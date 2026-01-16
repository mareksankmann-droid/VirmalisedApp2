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

// Open-Meteo: pilvisus % (praegune tund)
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
      `&hourly=cloud_cover&forecast_days=2&timezone=Europe%2FTallinn`;

    const r = await fetch(url);
    if (!r.ok) throw new Error("Open-Meteo HTTP " + r.status);
    const data = await r.json();

    const times = data?.hourly?.time ?? [];
    const clouds = data?.hourly?.cloud_cover ?? [];

    const key = tallinnHourKeyNow();
    let idx = times.indexOf(key);

    // fallback: vali lähim aeg
    if (idx === -1) {
      const now = Date.now();
      let bestDiff = Infinity;
      for (let i = 0; i < times.length; i++) {
        const t = new Date(times[i]).getTime();
        const diff = Math.abs(t - now);
        if (Number.isFinite(diff) && diff < bestDiff) { bestDiff = diff; idx = i; }
      }
    }

    res.json({
      request: { lat, lon },
      time: idx >= 0 ? times[idx] : null,
      cloudCoverPercent: idx >= 0 ? clouds[idx] : null
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
      `&hourly=cloud_cover&forecast_days=2&timezone=Europe%2FTallinn`;

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
      out.push({ time: times[j], cloudCoverPercent: clouds[j] });
    }

    res.json({ request: { lat, lon, hours }, items: out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


app.listen(PORT, () => {
  console.log(`Ava brauseris: http://localhost:${PORT}`);
});
