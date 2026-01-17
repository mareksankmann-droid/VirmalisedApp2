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
      `&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,precipitation` +
      `&forecast_days=2&timezone=Europe%2FTallinn`;

    const r = await fetch(url);
    if (!r.ok) throw new Error("Open-Meteo HTTP " + r.status);
    const data = await r.json();

    const times = data?.hourly?.time ?? [];
    const total = data?.hourly?.cloud_cover ?? [];
    const lowA  = data?.hourly?.cloud_cover_low ?? [];
    const midA  = data?.hourly?.cloud_cover_mid ?? [];
    const highA = data?.hourly?.cloud_cover_high ?? [];
    const temps = data?.hourly?.temperature_2m ?? [];
    const precs = data?.hourly?.precipitation ?? [];

    const now = Date.now();
    let idx = 0, best = Infinity;
    for (let j = 0; j < times.length; j++) {
      const t = new Date(times[j]).getTime();
      const d = Math.abs(t - now);
      if (Number.isFinite(d) && d < best) { best = d; idx = j; }
    }

    const items = [];
    for (let k = 0; k < hours; k++) {
      const j = idx + k;
      if (j >= times.length) break;
      items.push({
        time: times[j],
        cloudCoverPercent: total[j] ?? null,
        cloudLowPercent: lowA[j] ?? null,
        cloudMidPercent: midA[j] ?? null,
        cloudHighPercent: highA[j] ?? null,
        temperatureC: temps[j] ?? null,
        precipitationMm: precs[j] ?? null
      });
    }

    res.json({ request: { lat, lon, hours }, items });
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

// Ilmateenistus: vaatlusandmed (pilvisus “praegu”) + fallback Open-Meteo peale
app.get("/api/clouds_obs", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Lisa ?lat=..&lon=.." });
    }

    const { XMLParser } = require("fast-xml-parser");
    const url = "https://www.ilmateenistus.ee/ilma_andmed/xml/observations.php";

    const r = await fetch(url);
    if (!r.ok) throw new Error("Ilmateenistus HTTP " + r.status);
    const xml = await r.text();

    const parser = new XMLParser({ ignoreAttributes: true });
    const obj = parser.parse(xml);

    let stations = obj?.observations?.station ?? [];
    if (!Array.isArray(stations)) stations = [stations];

    const toNum = (x) => {
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    };

    const havKm = (lat1, lon1, lat2, lon2) => {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a =
        Math.sin(dLat/2)**2 +
        Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180) *
        Math.sin(dLon/2)**2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };

    const phenToPct = (p) => {
      const v = (p || "").trim();
      if (v === "Clear") return 0;
      if (v === "Few clouds") return 20;
      if (v === "Variable clouds") return 50;
      if (v === "Cloudy with clear spells") return 75;
      if (v === "Overcast") return 100;
      return null;
    };

    // leia lähim jaam
    let best = null;
    for (const st of stations) {
      const slat = toNum(st.latitude);
      const slon = toNum(st.longitude);
      if (slat == null || slon == null) continue;
      const d = havKm(lat, lon, slat, slon);
      if (!best || d < best.distKm) best = { st, distKm: d };
    }

    const ts = Number(obj?.observations?.timestamp);
    const time = Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;

    if (!best) {
      return res.json({ request:{lat,lon}, time, cloudCoverPercent: null, source: "Ilmateenistus", note: "Jaamu ei leitud" });
    }

    const st = best.st;
    const phenomenon = (st?.phenomenon ?? "").trim();

    // 1) Proovi cloudiness (palli) kui olemas (0..8)
    // (Ilmateenistus kaardil on pilvisus “palli”.) 
    let cloudinessBall = toNum(st?.cloudiness); // kui seda tagi pole, jääb null
    let cloudCoverPercent = null;
    let source = "Ilmateenistus (Keskkonnaagentuur)";

    if (cloudinessBall != null && cloudinessBall >= 0 && cloudinessBall <= 8) {
      cloudCoverPercent = Math.round((cloudinessBall / 8) * 100);
      source += " • cloudiness(pall)";
    } else {
      // 2) Proovi phenomenon -> %
      const p = phenToPct(phenomenon);
      if (p != null) {
        cloudCoverPercent = p;
        source += " • phenomenon";
      }
    }

    // 3) Kui ikka null, siis fallback Open-Meteo current cloud_cover (et linnades poleks “tühja”)
    if (cloudCoverPercent == null) {
      const omUrl =
        `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
        `&longitude=${encodeURIComponent(lon)}` +
        `&current=cloud_cover&timezone=Europe%2FTallinn`;
      const rr = await fetch(omUrl);
      if (rr.ok) {
        const data = await rr.json();
        const cc = Number(data?.current?.cloud_cover);
        if (Number.isFinite(cc)) {
          cloudCoverPercent = cc;
          source += " • Open-Meteo fallback";
        }
      }
    }

    res.json({
      request: { lat, lon },
      time,
      source,
      station: {
        name: st?.name ?? null,
        latitude: toNum(st?.latitude),
        longitude: toNum(st?.longitude),
        distanceKm: Math.round(best.distKm * 10) / 10
      },
      phenomenon: phenomenon || null,
      cloudinessBall: cloudinessBall,
      cloudCoverPercent
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});



app.listen(PORT, () => {
  console.log(`Ava brauseris: http://localhost:${PORT}`);
});
