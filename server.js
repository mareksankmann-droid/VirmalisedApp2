const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// NOAA Kp (viimane väärtus)
app.get("/api/kp", async (req, res) => {
  try {
    const url = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
    const r = await fetch(url);
    if (!r.ok) throw new Error("NOAA Kp HTTP " + r.status);
    const data = await r.json();

    const header = data[0];
    const rows = data.slice(1);

    const timeIdx = header.indexOf("time_tag");
    const kpIdx = header.indexOf("Kp");

    const last = rows[rows.length - 1];
    res.json({
      lastTime: last?.[timeIdx] ?? null,
      lastKp: kpIdx >= 0 ? (last?.[kpIdx] ?? null) : null
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Linn -> lat/lon (Eesti)
app.get("/api/geocode", async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) return res.status(400).json({ error: "Lisa ?name=..." });

    const url =
      "https://geocoding-api.open-meteo.com/v1/search" +
      `?name=${encodeURIComponent(name)}` +
      "&count=10&language=et&format=json&country=EE";

    const r = await fetch(url);
    if (!r.ok) throw new Error("Geocoding HTTP " + r.status);
    const data = await r.json();

    const results = (data.results || []).map(x => ({
      name: x.name,
      admin1: x.admin1,
      latitude: x.latitude,
      longitude: x.longitude
    }));

    res.json({ query: name, results });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// NOAA OVATION: aurora % koordinaadil
app.get("/api/aurora", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Lisa ?lat=..&lon=.." });
    }

    const url = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";
    const r = await fetch(url);
    if (!r.ok) throw new Error("NOAA OVATION HTTP " + r.status);
    const ov = await r.json();

    const coords = ov.coordinates; // [lon(0..360), lat, value]
    const lon0360 = ((lon % 360) + 360) % 360;

    const lonKey = Math.round(lon0360);
    const latKey = Math.round(lat);

    let best = null;
    for (const c of coords) {
      const cLon = Math.round(Number(c[0]));
      const cLat = Math.round(Number(c[1]));
      if (cLon === lonKey && cLat === latKey) { best = c; break; }
    }

    const prob = best ? Number(best[2]) : null;

    res.json({
      request: { lat, lon },
      matched: best ? { gridLon: Number(best[0]), gridLat: Number(best[1]) } : null,
      auroraProbPercent: prob
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Praeguse tunni võtme tegemine Europe/Tallinn ajas: YYYY-MM-DDTHH:00
function tallinnHourKeyNow() {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Tallinn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const get = (t) => parts.find(p => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:00`;
}

// Open-Meteo: pilvisus % (current – reaalsem “praegu”)
app.get("/api/clouds", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Lisa ?lat=..&lon=.." });
    }

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lon)}` +
      `&current=cloud_cover&timezone=Europe%2FTallinn`;

    const r = await fetch(url);
    if (!r.ok) throw new Error("Open-Meteo HTTP " + r.status);
    const data = await r.json();

    res.json({
      request: { lat, lon },
      time: data?.current?.time ?? null,
      cloudCoverPercent: data?.current?.cloud_cover ?? null
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});



// Pilvisus prognoos järgmisteks tundideks (nt 12h)
app.get("/api/clouds_next", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const hours = Math.max(1, Math.min(48, Number(req.query.hours || 12)));

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Lisa ?lat=..&lon=..&hours=12" });
    }

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lon)}` +
      `&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high&forecast_days=2&timezone=Europe%2FTallinn`;

    const r = await fetch(url);
    if (!r.ok) throw new Error("Open-Meteo HTTP " + r.status);
    const data = await r.json();

    const times = data?.hourly?.time ?? [];
    const clouds = data?.hourly?.cloud_cover ?? [];

    // leia lähim indeks "praegusele"
    const now = Date.now();
    let idx = 0, best = Infinity;
    for (let j = 0; j < times.length; j++) {
      const t = new Date(times[j]).getTime();
      const d = Math.abs(t - now);
      if (Number.isFinite(d) && d < best) { best = d; idx = j; }
    }

    const out = [];
    for (let k = 0; k < hours; k++) {
      const j = idx + k;
      if (j >= times.length) break;
      out.push({ time: times[j], cloudCoverPercent: clouds[j] ,
      cloudCoverLowPercent: (Number.isFinite(low) ? low : null ? low : null),
      cloudCoverMidPercent: (Number.isFinite(mid) ? mid : null ? mid : null),
      cloudCoverHighPercent: (Number.isFinite(high) ? high : null ? high : null),});
    }

    res.json({ request: { lat, lon, hours }, items: out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});



// Open-Meteo: temperatuur (current)
app.get("/api/temp", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Lisa ?lat=..&lon=.." });
    }

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lon)}` +
      `&current=temperature_2m&timezone=Europe%2FTallinn`;

    const r = await fetch(url);
    if (!r.ok) throw new Error("Open-Meteo HTTP " + r.status);
    const data = await r.json();

    res.json({
      request: { lat, lon },
      time: data?.current?.time ?? null,
      temperatureC: data?.current?.temperature_2m ?? null
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});



// Open-Meteo: sademed (current) – mm
app.get("/api/precip", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Lisa ?lat=..&lon=.." });
    }

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lon)}` +
      `&current=precipitation&timezone=Europe%2FTallinn`;

    const r = await fetch(url);
    if (!r.ok) throw new Error("Open-Meteo HTTP " + r.status);
    const data = await r.json();

    res.json({
      request: { lat, lon },
      time: data?.current?.time ?? null,
      precipitationMm: data?.current?.precipitation ?? null
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});



// Ilmateenistus (Keskkonnaagentuur): vaatlusandmed XML
// Allikas: ilmateenistus.ee/ilma_andmed/xml/observations.php
// NB: kasutustingimus on viitamine Keskkonnaagentuurile ja link ilmateenistus.ee lehele.
app.get("/api/clouds_obs", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Lisa ?lat=..&lon=.." });
    }

    // lazy require, et ei crashiks kui paketti pole
    const { XMLParser } = require("fast-xml-parser");
    const url = "https://www.ilmateenistus.ee/ilma_andmed/xml/observations.php";

    const r = await fetch(url);
    if (!r.ok) throw new Error("Ilmateenistus HTTP " + r.status);
    const xml = await r.text();

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const obj = parser.parse(xml);

    let stations = obj?.observations?.station ?? [];
    if (!Array.isArray(stations)) stations = [stations];

    function toNum(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }
    function haversineKm(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a =
        Math.sin(dLat/2)**2 +
        Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
      return 2 * R * Math.asin(Math.sqrt(a));
    }

    // pilvisuse mapping (nähtuste nimekirjast)
    // Clear / Few clouds / Variable clouds / Cloudy with clear spells / Overcast
    function phenomenonToCloudPercent(p) {
      switch ((p || "").trim()) {
        case "Clear": return 0;
        case "Few clouds": return 20;
        case "Variable clouds": return 50;
        case "Cloudy with clear spells": return 75;
        case "Overcast": return 100;
        default: return null; // kui on vihm/udu vms, siis see pole puhas pilvisus
      }
    }

    // leia lähim jaam
    let best = null;
    for (const st of stations) {
      const slat = toNum(st.latitude);
      const slon = toNum(st.longitude);
      if (slat == null || slon == null) continue;
      const d = haversineKm(lat, lon, slat, slon);
      if (!best || d < best.distKm) best = { st, distKm: d };
    }

    if (!best) {
      return res.json({ request:{lat,lon}, cloudCoverPercent: null, source: "Ilmateenistus", note: "Jaamu ei leitud XML-ist" });
    }

    const phenomenon = best.st?.phenomenon ?? null;
    const cloudCoverPercent = phenomenonToCloudPercent(phenomenon);

    // timestamp on rootis
    const ts = Number(obj?.observations?.timestamp);
    const time = Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;

    res.json({
      request: { lat, lon },
      time,
      source: "Ilmateenistus (Keskkonnaagentuur)",
      station: {
        name: best.st?.name ?? null,
        latitude: toNum(best.st?.latitude),
        longitude: toNum(best.st?.longitude),
        distanceKm: Math.round(best.distKm * 10) / 10
      },
      phenomenon,
      cloudCoverPercent
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


app.listen(PORT, () => {
  console.log(`Ava brauseris: http://localhost:${PORT}`);
});
