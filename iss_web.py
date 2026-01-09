import math
import os
import time
from datetime import datetime, timedelta, timezone

import requests
from flask import Flask, jsonify, render_template, request
from skyfield.api import EarthSatellite, load, wgs84

import json

TLE_DIR = os.environ.get("TLE_DIR", "/app/tle_cache")
os.makedirs(TLE_DIR, exist_ok=True)

def tle_path(norad: int) -> str:
    return os.path.join(TLE_DIR, f"{norad}.tle")

def save_tle_to_disk(norad: int, name: str, l1: str, l2: str) -> None:
    with open(tle_path(norad), "w", encoding="utf-8") as f:
        f.write(name.strip() + "\n")
        f.write(l1.strip() + "\n")
        f.write(l2.strip() + "\n")

def load_tle_from_disk(norad: int) -> tuple[str, str, str] | None:
    p = tle_path(norad)
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            lines = [ln.strip() for ln in f.read().splitlines() if ln.strip()]
        if len(lines) >= 3:
            return lines[0], lines[1], lines[2]
    except Exception:
        return None
    return None


app = Flask(__name__)

# Two-satellite overlay
# ISS (ZARYA): 25544
# Tiangong (CSS reference, Tianhe core module): 48274
SATELLITES = {
    "iss": {"name": "ISS", "norad": 25544},
    "tiangong": {"name": "Tiangong", "norad": 48274},
}

# TLE caching (per NORAD id)
TLE_CACHE = {}  # norad -> {"sat": EarthSatellite, "fetched": float, "name": str}
TLE_TTL_SECONDS = 60 * 30  # 30 minutes

SESSION = requests.Session()
SESSION.headers.update(
    {"User-Agent": "iss-live-tracker/1.0 (+github.com/amcanna1ly/iss-live-tracker)"}
)

ts = load.timescale()
_eph = None


def get_eph():
    global _eph
    if _eph is None:
        # This will use local file if bundled in the image, otherwise it will download.
        _eph = load("de421.bsp")
    return _eph


def _fetch_tle_from_celestrak(norad: int) -> tuple[str, str, str]:
    # Prefer www host first (some environments behave differently)
    urls = [
        f"https://www.celestrak.org/NORAD/elements/gp.php?CATNR={norad}&FORMAT=TLE",
        f"https://celestrak.org/NORAD/elements/gp.php?CATNR={norad}&FORMAT=TLE",
    ]

    headers = {
        "User-Agent": "iss-live-tracker/1.0 (+https://github.com/amcanna1ly/iss-live-tracker)",
        "Accept": "text/plain,text/html;q=0.9,*/*;q=0.8",
        "Referer": "https://www.celestrak.org/",
    }

    last_err = None
    for url in urls:
        try:
            r = SESSION.get(url, timeout=(6, 20), headers=headers)
            r.raise_for_status()
            lines = [ln.strip() for ln in r.text.strip().splitlines() if ln.strip()]
            if len(lines) >= 3:
                return lines[0], lines[1], lines[2]
            raise RuntimeError(f"Unexpected TLE response: {r.text[:200]}")
        except Exception as e:
            last_err = e

    raise RuntimeError(f"CelesTrak fetch failed: {last_err}")


def _fetch_tle_from_ivanstanojevic(norad: int) -> tuple[str, str, str]:
    # Public TLE API: https://tle.ivanstanojevic.me/satellite/{norad}
    url = f"https://tle.ivanstanojevic.me/satellite/{norad}"
    r = SESSION.get(url, timeout=(6, 20))
    r.raise_for_status()
    data = r.json()

    # Typical fields: name, line1, line2
    name = (data.get("name") or str(norad)).strip()
    l1 = (data.get("line1") or "").strip()
    l2 = (data.get("line2") or "").strip()
    if not (l1.startswith("1 ") and l2.startswith("2 ")):
        raise RuntimeError("Invalid TLE from ivanstanojevic API")
    return name, l1, l2


def get_satellite(norad: int) -> EarthSatellite:
    now = time.time()
    cached = TLE_CACHE.get(norad)

    # Use fresh in-memory cache
    if cached and (now - cached["fetched"] < TLE_TTL_SECONDS):
        return cached["sat"]

    # Try network (multi-source)
    try:
        name, l1, l2 = fetch_tle_multi_source(norad)
        sat = EarthSatellite(l1, l2, name=name, ts=ts)
        TLE_CACHE[norad] = {"sat": sat, "fetched": now, "name": name}
        save_tle_to_disk(norad, name, l1, l2)
        return sat
    except Exception:
        # Use stale in-memory cache if present
        if cached:
            return cached["sat"]

        # Use disk cache if present
        disk = load_tle_from_disk(norad)
        if disk:
            name, l1, l2 = disk
            sat = EarthSatellite(l1, l2, name=name, ts=ts)
            TLE_CACHE[norad] = {"sat": sat, "fetched": now, "name": name}
            return sat

        # Nothing available - bubble up
        raise

def _fetch_tle_from_amsat(norad: int) -> tuple[str, str, str]:
    """
    Fallback: parse AMSAT daily bulletin TLE list and extract the block matching NORAD id.
    """
    url = "https://www.amsat.org/tle/daily-bulletin.txt"
    r = SESSION.get(url, timeout=(6, 20))
    r.raise_for_status()
    lines = [ln.rstrip("\n") for ln in r.text.splitlines()]

    for i in range(len(lines) - 2):
        name = lines[i].strip()
        l1 = lines[i + 1].strip()
        l2 = lines[i + 2].strip()

        if l1.startswith("1 ") and l2.startswith("2 ") and len(l1) >= 7:
            try:
                cat = int(l1[2:7])
            except Exception:
                continue

            if cat == norad:
                if not name:
                    name = str(norad)
                return name, l1, l2

    raise RuntimeError(f"NORAD {norad} not found in AMSAT daily bulletin")



def fetch_tle_multi_source(norad: int) -> tuple[str, str, str]:
    """
    Try multiple sources. Order matters:
    1) CelesTrak
    2) ivanstanojevic TLE API
    3) AMSAT daily bulletin
    """
    errs = []

    for fn in (_fetch_tle_from_celestrak, _fetch_tle_from_ivanstanojevic, _fetch_tle_from_amsat):
        try:
            return fn(norad)
        except Exception as e:
            errs.append(f"{fn.__name__}: {e}")

    raise RuntimeError("All TLE sources failed: " + " | ".join(errs))

# Backwards-compatible alias (some code paths still call this name)
def fetch_tle_from_celestrak(norad: int) -> tuple[str, str, str]:
    return fetch_tle_multi_source(norad)


def get_satellite(norad: int) -> EarthSatellite:
    now = time.time()
    cached = TLE_CACHE.get(norad)

    # 1) Use fresh in-memory cache
    if cached and (now - cached["fetched"] < TLE_TTL_SECONDS):
        return cached["sat"]

    # 2) Try network fetch
    try:
        name, l1, l2 = fetch_tle_from_celestrak(norad)
        sat = EarthSatellite(l1, l2, name=name, ts=ts)
        TLE_CACHE[norad] = {"sat": sat, "fetched": now, "name": name}
        save_tle_to_disk(norad, name, l1, l2)
        return sat
    except Exception:
        # 3) If network failed, use stale in-memory cache if present
        if cached:
            return cached["sat"]

        # 4) If no in-memory cache, try disk cache
        disk = load_tle_from_disk(norad)
        if disk:
            name, l1, l2 = disk
            sat = EarthSatellite(l1, l2, name=name, ts=ts)
            TLE_CACHE[norad] = {"sat": sat, "fetched": now, "name": name}
            return sat

        # 5) Nothing available
        raise


def tle_age_str(norad: int) -> str:
    cached = TLE_CACHE.get(norad)
    if not cached:
        return "-"
    age_sec = time.time() - cached["fetched"]
    if age_sec < 90:
        return "fresh"
    if age_sec < 3600:
        return f"{int(age_sec // 60)}m"
    return f"{int(age_sec // 3600)}h"


def km_per_s_to_mph(km_s: float) -> float:
    return km_s * 3600.0 * 0.621371


def vector_norm3(v) -> float:
    # v is a 3-element numpy-like array
    return float(math.sqrt(float(v[0]) ** 2 + float(v[1]) ** 2 + float(v[2]) ** 2))


def compute_state_for_sat(norad: int) -> dict:
    sat = get_satellite(norad)
    t = ts.now()
    geoc = sat.at(t)

    v = geoc.velocity.km_per_s
    spd_km_s = vector_norm3(v)

    subpoint = wgs84.subpoint(geoc)
    lat = float(subpoint.latitude.degrees)
    lon = float(subpoint.longitude.degrees)
    alt_km = float(subpoint.elevation.km)

    return {
        "norad": norad,
        "tle_name": sat.name,
        "lat": lat,
        "lon": lon,
        "alt_km": alt_km,
        "speed_km_s": spd_km_s,
        "speed_mph": km_per_s_to_mph(spd_km_s),
        "tle_age": tle_age_str(norad),
    }


def observer_sun_alt_deg(observer, t) -> float:
    """
    Sun altitude (deg) as seen by observer at time t.
    """
    eph = get_eph()
    earth = eph["earth"]
    sun = eph["sun"]
    topos = earth + observer
    alt, az, dist = topos.at(t).observe(sun).apparent().altaz()
    return float(alt.degrees)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/state")
def api_state():
    sats = []
    errors = []

    for key, meta in SATELLITES.items():
        try:
            state = compute_state_for_sat(meta["norad"])
            sats.append({"key": key, "label": meta["name"], **state})
        except Exception as e:
            errors.append({"key": key, "label": meta["name"], "error": str(e)})

    if not sats:
        return jsonify({"error": "Failed to compute state for all satellites", "details": errors}), 500

    return jsonify({"utc": datetime.now(timezone.utc).isoformat(), "satellites": sats, "errors": errors})


@app.get("/api/track")
def api_track():
    """
    Predicted ground track points for BOTH satellites.

    Query params:
      minutes (default 90)
      step_sec (default 60)
    """
    minutes = int(request.args.get("minutes", "90"))
    step_sec = int(request.args.get("step_sec", "60"))

    minutes = max(1, minutes)
    step_sec = max(5, step_sec)

    horizon = minutes * 60
    steps = int(horizon // step_sec) + 1

    now = datetime.now(timezone.utc)
    times_dt = [now + timedelta(seconds=i * step_sec) for i in range(steps)]
    times = ts.from_datetimes(times_dt)

    tracks = {}
    for key, meta in SATELLITES.items():
        sat = get_satellite(meta["norad"])
        geoc = sat.at(times)
        subpoints = wgs84.subpoint(geoc)
        lats = subpoints.latitude.degrees
        lons = subpoints.longitude.degrees

        pts = [{"lat": float(lats[i]), "lon": float(lons[i])} for i in range(steps)]
        tracks[key] = {"label": meta["name"], "norad": meta["norad"], "points": pts}

    return jsonify({"utc": now.isoformat(), "tracks": tracks})


@app.get("/api/passes")
def api_passes():
    """
    PASS PREDICTIONS (ISS-ONLY, for backwards compatibility with your current UI).

    Query params:
      lat, lon (required)
      elev (meters, optional, default 0)
      min_el (degrees, optional, default 10)
      hours (optional, default 24)
      limit (optional, default 5)
      tz_offset (optional string like -06:00; currently just passed through)
    """
    try:
        lat = float(request.args.get("lat", "").strip())
        lon = float(request.args.get("lon", "").strip())
    except Exception:
        return jsonify({"error": "lat and lon are required and must be numbers"}), 400

    elev_m = float(request.args.get("elev", "0"))
    min_el = float(request.args.get("min_el", "10"))
    hours = int(request.args.get("hours", "24"))
    limit = int(request.args.get("limit", "5"))

    hours = max(1, min(hours, 168))
    limit = max(1, min(limit, 50))
    min_el = max(0.0, min(min_el, 89.0))

    # Observer location
    observer = wgs84.latlon(latitude_degrees=lat, longitude_degrees=lon, elevation_m=elev_m)

    # Use ISS for pass predictions (NORAD 25544)
    iss = get_satellite(SATELLITES["iss"]["norad"])

    # Find events for the next X hours
    start = datetime.now(timezone.utc)
    end = start + timedelta(hours=hours)
    t0 = ts.from_datetime(start)
    t1 = ts.from_datetime(end)

    # Skyfield find_events returns times and event codes:
    # 0 = rise, 1 = culminate, 2 = set
    times, events = iss.find_events(observer, t0, t1, altitude_degrees=min_el)

    passes = []
    i = 0
    while i < len(events) - 2 and len(passes) < limit:
        if events[i] == 0 and events[i + 1] == 1 and events[i + 2] == 2:
            t_rise = times[i]
            t_max = times[i + 1]
            t_set = times[i + 2]

            # Max elevation
            alt, az, dist = (iss - observer).at(t_max).altaz()
            max_el = float(alt.degrees)

            # Visibility heuristic:
            # - Observer dark-ish (Sun altitude <= -6 deg) at max time
            # - ISS is sunlit at max time (not in Earth shadow)
            sun_alt = observer_sun_alt_deg(observer, t_max)
            sun_ok = sun_alt <= -6.0
            iss_sunlit = bool(iss.at(t_max).is_sunlit(get_eph()))

            visible = bool(sun_ok and iss_sunlit)

            duration_s = int(round((t_set.utc_datetime() - t_rise.utc_datetime()).total_seconds()))

            passes.append(
                {
                    "rise_utc": t_rise.utc_iso(),
                    "max_utc": t_max.utc_iso(),
                    "set_utc": t_set.utc_iso(),
                    "duration_s": duration_s,
                    "max_el_deg": round(max_el, 1),
                    "sun_alt_deg": round(sun_alt, 1),
                    "iss_sunlit": iss_sunlit,
                    "visible": visible,
                }
            )
            i += 3
        else:
            i += 1

    return jsonify(
        {
            "observer": {"lat": lat, "lon": lon, "elev_m": elev_m},
            "min_el_deg": min_el,
            "hours": hours,
            "limit": limit,
            "passes": passes,
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
