/* app.js - ISS + Tiangong Live Tracker (Leaflet) - DROP-IN
   Matches your backend responses:

   GET /api/state
     -> {
          "errors": [],
          "satellites": [
             {"key":"iss","label":"ISS","lat":..,"lon":..,"alt_km":..,"speed_km_s":..,"tle_age":"..","tle_name":".."},
             {"key":"tiangong","label":"Tiangong","lat":..,"lon":..,"alt_km":..,"speed_km_s":..,"tle_age":"..","tle_name":".."}
          ],
          "utc":"2026-01-08T22:12:26.348960+00:00"
        }

   GET /api/track?minutes=90&step=60
     -> { "tracks": { "iss": {"points":[{"lat":..,"lon":..}, ...]},
                      "tiangong":{"points":[{"lat":..,"lon":..}, ...]} },
          "utc":"..." }

   GET /api/passes?... -> flexible; we render several shapes.
*/

(() => {
  "use strict";

// -------------------- Helpers --------------------
const byId = (id) => document.getElementById(id);

const firstEl = (ids) => {
  for (const id of ids) {
    const el = byId(id);
    if (el) return el;
  }
  return null;
};

const setText = (idsOrId, value) => {
  const el = Array.isArray(idsOrId) ? firstEl(idsOrId) : byId(idsOrId);
  if (el) el.textContent = value;
};

const getValue = (idsOrId, fallback = "") => {
  const el = Array.isArray(idsOrId) ? firstEl(idsOrId) : byId(idsOrId);
  if (!el) return fallback;
  return el.value ?? fallback;
};

const getNum = (idsOrId, fallback) => {
  const v = parseFloat(getValue(idsOrId, ""));
  return Number.isFinite(v) ? v : fallback;
};

const getInt = (idsOrId, fallback) => {
  const v = parseInt(getValue(idsOrId, ""), 10);
  return Number.isFinite(v) ? v : fallback;
};

const getChecked = (idsOrId, fallback = false) => {
  const el = Array.isArray(idsOrId) ? firstEl(idsOrId) : byId(idsOrId);
  if (!el) return fallback;
  return !!el.checked;
};

const fmtLatLon = (lat, lon) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "-, -";
  const f = (x) => (Math.round(x * 10000) / 10000).toFixed(4);
  return `${f(lat)}, ${f(lon)}`;
};

const fmtKm = (km) => (Number.isFinite(km) ? `${(Math.round(km * 10) / 10).toFixed(1)} km` : "-");
const fmtKms = (kms) => (Number.isFinite(kms) ? `${(Math.round(kms * 1000) / 1000).toFixed(3)} km/s` : "-");

const fmtLocal = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
};

function parseTimeMaybe(v) {
  if (!v) return null;

  // ISO string or already parseable date
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d;

  return null;
}

function fmtDurationFromSeconds(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "-";

  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;

  return `${m}m ${r}s`;
}


async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`${r.status} ${r.statusText} - ${url}${txt ? " - " + txt.slice(0, 200) : ""}`);
  }
  return await r.json();
}

function satsByKey(stateJson) {
  const out = {};
  const arr = stateJson && Array.isArray(stateJson.satellites) ? stateJson.satellites : [];
  for (const s of arr) {
    if (s && s.key) out[s.key] = s;
  }
  return out;
}

// NEW: split tracks at dateline jumps to avoid "flat top" wrap lines
function splitAntimeridian(latlngs, jumpDeg = 180) {
  // latlngs: [[lat, lon], ...]
  if (!Array.isArray(latlngs) || latlngs.length === 0) return [];

  const segs = [];
  let seg = [latlngs[0]];

  for (let i = 1; i < latlngs.length; i++) {
    const prev = latlngs[i - 1];
    const cur = latlngs[i];
    const dLon = Math.abs(cur[1] - prev[1]);

    // If we jumped across the dateline, start a new segment
    if (dLon > jumpDeg) {
      segs.push(seg);
      seg = [cur];
    } else {
      seg.push(cur);
    }
  }
  segs.push(seg);
  return segs;
}

  // -------------------- DOM IDs (with fallbacks) --------------------
  const ids = {
    map: ["map"],

    follow: ["followISS", "followIss", "follow_iss"],
    showTracks: ["showGroundTrack", "showGroundTracks", "show_ground_track", "show_tracks"],

    refreshNowBtn: ["refreshNowBtn", "refreshNow", "btnRefreshNow"],
    updateBtn: ["updateBtn", "update", "btnUpdate"],
    resetTrailBtn: ["resetTrailBtn", "resetTrail", "btnResetTrail"],
    useLocationBtn: ["useLocationBtn", "useMyLocation", "useLocation"],

    // inputs
    latitude: ["latitude", "lat"],
    longitude: ["longitude", "lon", "lng"],
    elevation: ["elevation", "elev"],
    minElev: ["minElev", "min_el", "minEl"],
    hoursAhead: ["hoursAhead", "hours"],
    passCount: ["passCount", "passes", "limit"],
    tzOffset: ["tzOffset", "tz_offset"],
    refreshSec: ["refreshSec", "refresh", "refreshSeconds"],
    trackMin: ["trackMin", "trackMinutes", "minutes"],
    trackStep: ["trackStep", "trackSeconds", "step"],

    // tiles
    issLatLon: ["issLatLon", "iss_latlon"],
    issAlt: ["issAlt", "iss_alt"],
    issSpeed: ["issSpeed", "iss_speed"],
    tgLatLon: ["tgLatLon", "tiangongLatLon", "tg_latlon"],
    tgAlt: ["tgAlt", "tiangongAlt", "tg_alt"],
    tgSpeed: ["tgSpeed", "tiangongSpeed", "tg_speed"],
    utcValue: ["utcValue", "utc", "utcTile"],
    lastUpdate: ["lastUpdate", "last_update"],

    // header pills
    refreshLabel: ["refreshLabel"],
    tleAgeISS: ["tleAgeISS", "tleIss", "tle_iss"],
    tleAgeTiangong: ["tleAgeTiangong", "tleTiangong", "tle_tiangong"],

    // passes
    passesTable: ["passesTable"],
    passesStatus: ["passesStatus"],
  };

  const els = {
    follow: () => firstEl(ids.follow),
    showTracks: () => firstEl(ids.showTracks),

    refreshNowBtn: () => firstEl(ids.refreshNowBtn),
    updateBtn: () => firstEl(ids.updateBtn),
    resetTrailBtn: () => firstEl(ids.resetTrailBtn),
    useLocationBtn: () => firstEl(ids.useLocationBtn),

    passesTable: () => firstEl(ids.passesTable),
    passesStatus: () => firstEl(ids.passesStatus),
  };

  // -------------------- Leaflet state --------------------
  let map = null;
  let markerISS = null;
  let markerTG = null;

  let trackGroup = null;
  let trackISS = null;
  let trackTG = null;

  function ensureMap() {
    if (map) return;

    const mapEl = firstEl(ids.map);
    if (!mapEl) {
      console.error("No #map element found; cannot init Leaflet.");
      return;
    }

    map = L.map(mapEl, { worldCopyJump: true }).setView([20, 0], 2);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 6,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

markerISS = L.circleMarker([0, 0], {
  radius: 6,
  color: "#00c7ff",
  fillColor: "#00c7ff",
  fillOpacity: 0.9,
  weight: 2
}).addTo(map);

markerTG = L.circleMarker([0, 0], {
  radius: 6,
  color: "#ffb020",
  fillColor: "#ffb020",
  fillOpacity: 0.9,
  weight: 2
}).addTo(map);

// Track group (so show/hide works reliably)
trackGroup = L.layerGroup().addTo(map);

trackISS = L.polyline([], {
  weight: 2,
  color: "#00c7ff",
  opacity: 0.9
}).addTo(trackGroup);

trackTG = L.polyline([], {
  weight: 2,
  color: "#ffb020",
  opacity: 0.9,
  dashArray: "6 6"
}).addTo(trackGroup);

    setTracksVisible(getChecked(ids.showTracks, true));
  }

  function setTracksVisible(visible) {
    if (!map || !trackGroup) return;
    if (visible) {
      if (!map.hasLayer(trackGroup)) map.addLayer(trackGroup);
    } else {
      if (map.hasLayer(trackGroup)) map.removeLayer(trackGroup);
    }
  }

  function resetTracks() {
    if (trackISS) trackISS.setLatLngs([]);
    if (trackTG) trackTG.setLatLngs([]);
  }

  // -------------------- Refresh: /api/state --------------------
  function applyState(json) {
    const sats = satsByKey(json);
    const iss = sats.iss;
    const tg = sats.tiangong;

    // Tiles
    setText(ids.issLatLon, iss ? fmtLatLon(iss.lat, iss.lon) : "-, -");
    setText(ids.issAlt, iss ? fmtKm(iss.alt_km) : "-");
    setText(ids.issSpeed, iss ? fmtKms(iss.speed_km_s) : "-");

    setText(ids.tgLatLon, tg ? fmtLatLon(tg.lat, tg.lon) : "-, -");
    setText(ids.tgAlt, tg ? fmtKm(tg.alt_km) : "-");
    setText(ids.tgSpeed, tg ? fmtKms(tg.speed_km_s) : "-");

    // UTC + update time
    setText(ids.utcValue, json && json.utc ? fmtLocal(json.utc) : "-");
    setText(ids.lastUpdate, json && json.utc ? fmtLocal(json.utc) : fmtLocal(new Date().toISOString()));

    // TLE ages
    setText(ids.tleAgeISS, iss && iss.tle_age ? String(iss.tle_age) : "-");
    setText(ids.tleAgeTiangong, tg && tg.tle_age ? String(tg.tle_age) : "-");

    // Markers
    if (map) {
      if (iss && Number.isFinite(iss.lat) && Number.isFinite(iss.lon)) {
        markerISS.setLatLng([iss.lat, iss.lon]);
        markerISS.bindTooltip("ISS", { permanent: true, direction: "right", offset: [8, 0] });
      }
      if (tg && Number.isFinite(tg.lat) && Number.isFinite(tg.lon)) {
        markerTG.setLatLng([tg.lat, tg.lon]);
        markerTG.bindTooltip("TG", { permanent: true, direction: "right", offset: [8, 0] });
      }

      if (getChecked(ids.follow, false) && iss && Number.isFinite(iss.lat) && Number.isFinite(iss.lon)) {
        map.panTo([iss.lat, iss.lon], { animate: true });
      }
    }
  }

  async function refreshState() {
    try {
      const json = await fetchJson("/api/state");
      applyState(json);
    } catch (e) {
      console.warn("refreshState failed:", e);
    }
  }

  // -------------------- Refresh: /api/track --------------------
  function normalizePoints(points) {
    // Your backend returns: [{lat,lon}, ...]
    if (!Array.isArray(points)) return [];
    const out = [];
    for (const p of points) {
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) out.push([p.lat, p.lon]);
    }
    return out;
  }

  async function refreshTrack() {
    try {
      const minutes = getInt(ids.trackMin, 90);
      const step = getInt(ids.trackStep, 60);

      const json = await fetchJson(`/api/track?minutes=${encodeURIComponent(minutes)}&step=${encodeURIComponent(step)}`);

      const tracksObj = json && json.tracks ? json.tracks : null;
      if (!tracksObj) return;

      const issPts = tracksObj.iss && tracksObj.iss.points ? tracksObj.iss.points : [];
      const tgPts = tracksObj.tiangong && tracksObj.tiangong.points ? tracksObj.tiangong.points : [];

if (trackISS) trackISS.setLatLngs(splitAntimeridian(normalizePoints(issPts)));
if (trackTG) trackTG.setLatLngs(splitAntimeridian(normalizePoints(tgPts)));

      setTracksVisible(getChecked(ids.showTracks, true));
    } catch (e) {
      console.warn("refreshTrack failed:", e);
    }
  }

  // -------------------- Refresh: /api/passes --------------------
  function normalizePasses(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.passes)) return json.passes;
    if (Array.isArray(json.rows)) return json.rows;
    if (json.passes && Array.isArray(json.passes.rows)) return json.passes.rows;
    if (Array.isArray(json.results)) return json.results;
    return [];
  }

function parseTimeMaybe(v) {
  if (!v) return null;

  // If backend gives numeric seconds or epoch ms, handle that too
  if (typeof v === "number" && Number.isFinite(v)) {
    // assume epoch seconds if small-ish, else ms
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDurationFromSeconds(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec < 0) return "-";
  const sec = Math.round(totalSec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

  function renderPasses(rows) {
    const tbl = els.passesTable();
    if (!tbl) return;

    const tbody = tbl.querySelector("tbody");
    if (!tbody) return;

    tbody.innerHTML = "";

    if (!rows || rows.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="6" class="muted">No passes found.</td>`;
      tbody.appendChild(tr);
      return;
    }

    let idx = 1;
    for (const row of rows) {
const pickTime = (r, keys) => {
  for (const k of keys) {
    const v = r?.[k];
    if (!v) continue;
    // If it's already a "local" string from backend, keep it as-is.
    if (String(k).includes("local")) return String(v);
    // Otherwise try to format ISO/UTC-ish strings nicely
    return fmtLocal(v);
  }
  return "-";
};

const rise = pickTime(row, ["rise_local", "rise_utc", "rise", "start"]);
const maxv = pickTime(row, ["max_local", "max_utc", "max", "peak"]);
const setv  = pickTime(row, ["set_local", "set_utc", "set", "end"]);
let dur =
  row.duration ||
  row.duration_str ||
  row.dur ||
  row.duration_s ||
  row.duration_sec ||
  row.duration_seconds;

if (Number.isFinite(Number(dur))) {
  dur = fmtDurationFromSeconds(Number(dur));
} else {
  const riseRaw = row.rise_utc || row.rise || row.start || row.rise_local;
  const setRaw  = row.set_utc  || row.set  || row.end   || row.set_local;

  const a = parseTimeMaybe(riseRaw);
  const b = parseTimeMaybe(setRaw);

  if (a && b) {
    dur = fmtDurationFromSeconds((b - a) / 1000);
  } else {
    dur = "-";
  }
}

      const visible = row.visible === true || String(row.visible).toLowerCase() === "true";

      const pill = visible
        ? `<span class="vpill vpill--yes">Yes</span>`
        : `<span class="vpill vpill--no">No</span>`;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${row.index ?? idx}</td>
        <td class="mono">${rise}</td>
        <td class="mono">${maxv}</td>
        <td class="mono">${setv}</td>
        <td class="mono">${dur}</td>
        <td>${pill}</td>
      `;
      tbody.appendChild(tr);
      idx += 1;
    }
  }

  async function refreshPasses() {
    const status = els.passesStatus();
    try {
      const lat = getNum(ids.latitude, 33.5207);
      const lon = getNum(ids.longitude, -86.8025);
      const elev = getInt(ids.elevation, 180);
      const minEl = getInt(ids.minElev, 10);
      const hours = getInt(ids.hoursAhead, 48);
      const limit = getInt(ids.passCount, 5);
      const tz = getValue(ids.tzOffset, "-06:00");

      const qs = new URLSearchParams({
        lat: String(lat),
        lon: String(lon),
        elev: String(elev),
        min_el: String(minEl),
        hours: String(hours),
        limit: String(limit),
        tz_offset: tz,
      });

      if (status) status.textContent = "Loading...";
      const json = await fetchJson(`/api/passes?${qs.toString()}`);
      renderPasses(normalizePasses(json));
      if (status) status.textContent = "";
    } catch (e) {
      console.warn("refreshPasses failed:", e);
      if (status) status.textContent = "Failed to load passes.";
    }
  }

  // -------------------- Scheduler --------------------
  let timer = null;

  function setRefreshLabel(sec) {
    setText(ids.refreshLabel, String(sec));
  }

  async function tick() {
    // Each runs independently; a failure won’t block the others
    await refreshState();
    await refreshTrack();
    await refreshPasses();
  }

  function startTimer() {
    if (timer) clearInterval(timer);

    const sec = Math.max(1, getInt(ids.refreshSec, 5));
    setRefreshLabel(sec);

    // Do one immediately so you see live state update right away
    tick();

    timer = setInterval(tick, sec * 1000);
  }

  // -------------------- UI actions --------------------
  function wireEvents() {
    const refreshNowBtn = els.refreshNowBtn();
    const updateBtn = els.updateBtn();
    const resetTrailBtn = els.resetTrailBtn();
    const useLocationBtn = els.useLocationBtn();
    const showTracksEl = els.showTracks();

    if (refreshNowBtn) refreshNowBtn.addEventListener("click", () => tick());
    if (updateBtn) updateBtn.addEventListener("click", () => startTimer());
    if (resetTrailBtn) resetTrailBtn.addEventListener("click", () => resetTracks());

    if (showTracksEl) {
      showTracksEl.addEventListener("change", (e) => setTracksVisible(!!e.target.checked));
    }

    // If refresh seconds changes, restart timer
    const refreshInput = firstEl(ids.refreshSec);
    if (refreshInput) refreshInput.addEventListener("change", () => startTimer());

    if (useLocationBtn) {
      useLocationBtn.addEventListener("click", () => {
        if (!navigator.geolocation) {
          alert("Geolocation not available in this browser.");
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const { latitude, longitude } = pos.coords;
            const latEl = firstEl(ids.latitude);
            const lonEl = firstEl(ids.longitude);
            if (latEl) latEl.value = latitude.toFixed(4);
            if (lonEl) lonEl.value = longitude.toFixed(4);
            startTimer();
          },
          (err) => {
            console.warn("Geolocation failed:", err);
            alert("Failed to get your location. Check browser permissions.");
          },
          { enableHighAccuracy: true, timeout: 10000 }
        );
      });
    }
  }

  // -------------------- Boot --------------------
  function boot() {
    ensureMap();
    wireEvents();
    startTimer();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
