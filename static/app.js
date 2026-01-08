/* global L */

let timer = null;

// Leaflet layers
let map = null;
let issMarker = null;

// Past trail
let pastTrail = null;
let pastPoints = [];

// Predicted ground track
let trackLine = null;
let trackSegments = []; // for dateline splits

function $(id) {
  return document.getElementById(id);
}

function val(id) {
  return $(id).value;
}

function setText(id, text) {
  $(id).textContent = text;
}

function durFmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

function safeNum(n, digits) {
  if (typeof n !== "number" || Number.isNaN(n)) return "-";
  return n.toFixed(digits);
}

function initMap() {
  if (map) return;

  map = L.map("map", { worldCopyJump: true }).setView([0, 0], 2);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 6,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  issMarker = L.marker([0, 0]).addTo(map).bindPopup("ISS");

  pastTrail = L.polyline([], {}).addTo(map);
  trackLine = L.featureGroup().addTo(map);

  $("resetBtn").addEventListener("click", resetPastTrail);
  $("followToggle").addEventListener("change", () => {});
  $("trackToggle").addEventListener("change", () => {
    const on = $("trackToggle").checked;
    if (!on) {
      clearTrack();
    } else {
      refreshTrack();
    }
  });
}

function resetPastTrail() {
  pastPoints = [];
  if (pastTrail) pastTrail.setLatLngs([]);
}

function clearTrack() {
  if (trackLine) trackLine.clearLayers();
}

function splitByDateline(points) {
  // points: array of [lat, lon]
  // returns array of segments (each segment is array of [lat, lon]) split when lon jump > 180
  const segments = [];
  let current = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];

    if (current.length === 0) {
      current.push(p);
      continue;
    }

    const prev = current[current.length - 1];
    const prevLon = prev[1];
    const lon = p[1];

    if (Math.abs(lon - prevLon) > 180) {
      segments.push(current);
      current = [p];
    } else {
      current.push(p);
    }
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

function updateMapState(lat, lon) {
  initMap();

  issMarker.setLatLng([lat, lon]);

  // past trail
  if (pastPoints.length > 0) {
    const prevLon = pastPoints[pastPoints.length - 1][1];
    if (Math.abs(lon - prevLon) > 180) {
      resetPastTrail();
    }
  }

  pastPoints.push([lat, lon]);
  if (pastPoints.length > 60) pastPoints.shift();
  pastTrail.setLatLngs(pastPoints);

  if ($("followToggle").checked) {
    map.setView([lat, lon], map.getZoom());
  }
}

async function fetchState() {
  const r = await fetch("/api/state", { cache: "no-store" });
  if (!r.ok) throw new Error("state fetch failed");
  return await r.json();
}

async function fetchPasses() {
  const params = new URLSearchParams({
    lat: val("lat"),
    lon: val("lon"),
    elev: val("elev"),
    min_el: val("minEl"),
    hours: val("hours"),
    limit: val("limit"),
    tz_offset: val("tzOffset"),
  });

  const r = await fetch("/api/passes?" + params.toString(), { cache: "no-store" });
  if (!r.ok) throw new Error("passes fetch failed");
  return await r.json();
}

async function fetchTrack() {
  const minutes = parseInt(val("trackMinutes") || "90", 10);
  const step = parseInt(val("trackStep") || "60", 10);

  const params = new URLSearchParams({
    minutes: String(minutes),
    step_seconds: String(step),
  });

  const r = await fetch("/api/track?" + params.toString(), { cache: "no-store" });
  if (!r.ok) throw new Error("track fetch failed");
  return await r.json();
}

function renderPasses(passes) {
  const body = $("passesBody");
  body.innerHTML = "";

  if (!passes || passes.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="muted">No passes found (try lowering min elev or increasing hours).</td>`;
    body.appendChild(tr);
    return;
  }

  passes.forEach((p, idx) => {
    const visible = !!p.likely_visible;
    const label = p.visibility_label || (visible ? "Likely visible" : "Not visible");

    const badgeClass = visible ? "vpill vpill--yes" : "vpill vpill--no";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td class="mono">${p.rise_local}</td>
      <td class="mono">${p.max_local} (${Number(p.max_elevation_deg).toFixed(1)}°)</td>
      <td class="mono">${p.set_local}</td>
      <td>${durFmt(p.duration_seconds)}</td>
      <td><span class="${badgeClass}">${label}</span></td>
    `;
    body.appendChild(tr);
  });
}

function tleAgeString(tleFetchedIso) {
  if (!tleFetchedIso) return "-";
  const fetched = new Date(tleFetchedIso);
  if (Number.isNaN(fetched.getTime())) return "-";
  const mins = Math.floor((Date.now() - fetched.getTime()) / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h${String(rem).padStart(2, "0")}m`;
}

async function refreshTrack() {
  if (!$("trackToggle").checked) return;

  try {
    const track = await fetchTrack();
    const points = (track.points || []).map((p) => [p.lat, p.lon]);

    clearTrack();
    if (!points.length) return;

    const segments = splitByDateline(points);

    // Draw each segment separately to avoid a long line across the dateline
    segments.forEach((seg) => {
      L.polyline(seg, { opacity: 0.85, weight: 3 }).addTo(trackLine);
    });
  } catch (e) {
    // ignore track errors; dashboard still useful
  }
}

async function refreshAll() {
  try {
    const [state, passes] = await Promise.all([fetchState(), fetchPasses()]);

    setText("issName", state.name || "ISS");
    setText("latlon", `${safeNum(state.lat, 4)}, ${safeNum(state.lon, 4)}`);
    setText("alt", `${safeNum(state.alt_km, 2)} km`);
    setText("speed", `${safeNum(state.speed_km_s, 2)} km/s`);
    setText("utcNow", state.utc || "-");

    setText("badgeAlt", `Alt ${safeNum(state.alt_km, 0)} km`);
    setText("badgeSpeed", `Speed ${safeNum(state.speed_km_s, 2)} km/s`);

    setText("tleAge", tleAgeString(state.tle_fetched_utc));

    updateMapState(state.lat, state.lon);
    renderPasses(passes.passes);

    // Track refresh can be slower; do it separately but still on the same cycle
    await refreshTrack();

    setText("errorLine", "");
  } catch (e) {
    setText("errorLine", "Error refreshing data. Check Pi internet connectivity and reload the page.");
  }
}

function startTimer() {
  if (timer) clearInterval(timer);

  const sec = Math.max(2, parseInt(val("refreshSec") || "5", 10));
  setText("refreshLabel", String(sec));

  timer = setInterval(refreshAll, sec * 1000);
}

function manualUpdate() {
  refreshAll();
  startTimer();
}

function wireGeolocation() {
  $("geoBtn").addEventListener("click", () => {
    if (!navigator.geolocation) {
      setText("errorLine", "Geolocation not supported by this browser.");
      return;
    }

    setText("errorLine", "Requesting location permission...");

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;

        $("lat").value = lat.toFixed(4);
        $("lon").value = lon.toFixed(4);

        // Elevation is often unavailable from browser geolocation; keep existing
        setText("errorLine", "Location updated. Click Update to refresh passes.");
      },
      (err) => {
        setText("errorLine", `Geolocation failed: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });
}

window.addEventListener("DOMContentLoaded", () => {
  initMap();

  $("updateBtn").addEventListener("click", manualUpdate);

  wireGeolocation();

  // First load
  refreshAll();
  startTimer();
});
