#!/usr/bin/env python3
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any

import requests
from flask import Flask, jsonify, request, render_template
from skyfield.api import EarthSatellite, load, wgs84

CELESTRAK_ISS_TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE"
UTC = timezone.utc

app = Flask(__name__)
ts = load.timescale()

# In-memory TLE cache
_TLE_CACHE: dict[str, Any] = {"sat": None, "fetched_utc": None}
TLE_REFRESH_MINUTES = 180  # refresh every 3 hours

# Ephemeris cache (Sun position + satellite sunlit determination)
_EPH_CACHE: dict[str, Any] = {"eph": None, "loaded_utc": None}
EPH_REFRESH_HOURS = 24  # refresh daily (file is local after first download)

# Pass computation cache
_PASS_CACHE: dict[str, Any] = {"key": None, "expires_utc": None, "payload": None}
PASS_CACHE_SECONDS = 30

# Track computation cache
_TRACK_CACHE: dict[str, Any] = {"key": None, "expires_utc": None, "payload": None}
TRACK_CACHE_SECONDS = 30


def now_utc() -> datetime:
    return datetime.now(tz=UTC)


def fetch_iss_tle() -> tuple[str, str, str]:
    r = requests.get(CELESTRAK_ISS_TLE_URL, timeout=20)
    r.raise_for_status()
    lines = [ln.strip() for ln in r.text.splitlines() if ln.strip()]
    if len(lines) < 3:
        raise RuntimeError("Unexpected TLE response from Celestrak.")
    name, l1, l2 = lines[0], lines[1], lines[2]
    return name, l1, l2


def fetch_iss_satellite() -> EarthSatellite:
    name, l1, l2 = fetch_iss_tle()
    return EarthSatellite(l1, l2, name=name, ts=ts)


def get_satellite_cached() -> EarthSatellite:
    sat = _TLE_CACHE["sat"]
    fetched = _TLE_CACHE["fetched_utc"]

    if sat is None or fetched is None:
        sat = fetch_iss_satellite()
        _TLE_CACHE["sat"] = sat
        _TLE_CACHE["fetched_utc"] = now_utc()
        return sat

    if now_utc() - fetched > timedelta(minutes=TLE_REFRESH_MINUTES):
        try:
            sat = fetch_iss_satellite()
            _TLE_CACHE["sat"] = sat
            _TLE_CACHE["fetched_utc"] = now_utc()
        except Exception:
            # keep last known-good TLE
            pass

    return _TLE_CACHE["sat"]


def get_eph_cached():
    """
    Loads an ephemeris for Sun position and sunlit determination.
    On first run, Skyfield may download the file if not present.
    """
    eph = _EPH_CACHE["eph"]
    loaded = _EPH_CACHE["loaded_utc"]
    if eph is None or loaded is None:
        eph = load("de421.bsp")
        _EPH_CACHE["eph"] = eph
        _EPH_CACHE["loaded_utc"] = now_utc()
        return eph

    if now_utc() - loaded > timedelta(hours=EPH_REFRESH_HOURS):
        try:
            eph = load("de421.bsp")
            _EPH_CACHE["eph"] = eph
            _EPH_CACHE["loaded_utc"] = now_utc()
        except Exception:
            pass

    return _EPH_CACHE["eph"]


def parse_tz_offset(s: str) -> timezone:
    # expects [+|-]HH:MM
    if len(s) != 6 or s[3] != ":":
        raise ValueError("tz_offset must look like -06:00 or +01:00")
    if s[0] not in {"+", "-"}:
        raise ValueError("tz_offset must start with + or -")
    sign = -1 if s[0] == "-" else 1
    hh = int(s[1:3])
    mm = int(s[4:6])
    return timezone(sign * timedelta(hours=hh, minutes=mm))


def fmt_local(dt_utc: datetime, tz: timezone) -> str:
    return dt_utc.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S")


def cache_key_passes(lat: float, lon: float, elev: float, hours: int, limit: int, min_el: float, tz_offset: str) -> str:
    return f"passes|lat={lat:.6f}|lon={lon:.6f}|elev={elev:.1f}|hours={hours}|limit={limit}|min_el={min_el:.1f}|tz={tz_offset}"


def cache_key_track(minutes: int, step_seconds: int) -> str:
    return f"track|minutes={minutes}|step={step_seconds}"


def observer_sun_alt_deg(eph, observer, t) -> float:
    """
    Returns the Sun altitude (deg) as seen by the observer at time t.
    Skyfield: use (earth + topos).at(t).observe(sun) rather than observer.at(t).observe(...)
    """
    sun = eph["sun"]
    earth = eph["earth"]
    topos = earth + observer

    astrometric = topos.at(t).observe(sun)
    alt, az, distance = astrometric.apparent().altaz()
    return float(alt.degrees)


def classify_visibility(observer_sun_altitude_deg: float, iss_sunlit: bool) -> tuple[bool, str]:
    """
    Simple visibility heuristic:
    - Observer should be in civil twilight or darker (Sun below -6 degrees)
    - ISS should be sunlit
    """
    dark_enough = observer_sun_altitude_deg < -6.0
    visible = bool(dark_enough and iss_sunlit)

    if visible:
        return True, "Likely visible"
    if not iss_sunlit and dark_enough:
        return False, "Not visible (ISS in shadow)"
    if iss_sunlit and not dark_enough:
        return False, "Not visible (sky too bright)"
    return False, "Not visible"


@app.get("/")
def index():
    return render_template(
        "index.html",
        default_lat=33.5207,
        default_lon=-86.8025,
        default_elev=180,
        default_min_el=10,
        default_hours=48,
        default_limit=5,
        default_tz_offset="-06:00",
        default_refresh=5,
        default_track_minutes=90,
        default_track_step=60,
    )


@app.get("/api/state")
def api_state():
    sat = get_satellite_cached()
    t = ts.now()
    geocentric = sat.at(t)
    subpoint = wgs84.subpoint(geocentric)

    velocity_km_s = geocentric.velocity.km_per_s
    speed_km_s = math.sqrt(sum(v * v for v in velocity_km_s))

    fetched = _TLE_CACHE["fetched_utc"]

    return jsonify(
        {
            "name": sat.name,
            "utc": now_utc().isoformat(),
            "lat": float(subpoint.latitude.degrees),
            "lon": float(subpoint.longitude.degrees),
            "alt_km": float(subpoint.elevation.km),
            "speed_km_s": float(speed_km_s),
            "tle_fetched_utc": fetched.isoformat() if fetched else None,
        }
    )


@app.get("/api/passes")
def api_passes():
    """
    Query params:
      lat, lon (required)
      elev (meters, default 0)
      hours (default 48)
      limit (default 5)
      min_el (degrees, default 10)
      tz_offset (default -06:00)
    Returns:
      For each pass: rise/max/set, max elevation, duration, visibility label.
    """
    sat = get_satellite_cached()
    eph = get_eph_cached()

    lat = float(request.args.get("lat"))
    lon = float(request.args.get("lon"))
    elev = float(request.args.get("elev", 0))
    hours = int(request.args.get("hours", 48))
    limit = int(request.args.get("limit", 5))
    min_el = float(request.args.get("min_el", 10))
    tz_offset = request.args.get("tz_offset", "-06:00")

    key = cache_key_passes(lat, lon, elev, hours, limit, min_el, tz_offset)
    expires = _PASS_CACHE["expires_utc"]
    if _PASS_CACHE["key"] == key and isinstance(expires, datetime) and now_utc() < expires:
        payload = _PASS_CACHE["payload"]
        if payload is not None:
            return jsonify(payload)

    tz = parse_tz_offset(tz_offset)
    observer = wgs84.latlon(lat, lon, elevation_m=elev)

    t0 = ts.from_datetime(now_utc())
    t1 = ts.from_datetime(now_utc() + timedelta(hours=hours))

    times, events = sat.find_events(observer, t0, t1, altitude_degrees=min_el)

    results: list[dict[str, Any]] = []
    i = 0
    while i < len(events) - 2 and len(results) < limit:
        if events[i] == 0 and events[i + 1] == 1 and events[i + 2] == 2:
            rise_t = times[i].utc_datetime().replace(tzinfo=UTC)
            max_t = times[i + 1].utc_datetime().replace(tzinfo=UTC)
            set_t = times[i + 2].utc_datetime().replace(tzinfo=UTC)

            # Max elevation and azimuth at culmination
            alt, az, distance = (sat - observer).at(times[i + 1]).altaz()
            max_el = float(alt.degrees)
            max_az = float(az.degrees)

            duration_s = int((set_t - rise_t).total_seconds())

            # Visibility heuristics computed at max elevation time
            obs_sun_alt = observer_sun_alt_deg(eph, observer, times[i + 1])
            iss_sunlit = bool(sat.at(times[i + 1]).is_sunlit(eph))
            visible, visibility_label = classify_visibility(obs_sun_alt, iss_sunlit)

            results.append(
                {
                    "rise_utc": rise_t.isoformat(),
                    "max_utc": max_t.isoformat(),
                    "set_utc": set_t.isoformat(),
                    "rise_local": fmt_local(rise_t, tz),
                    "max_local": fmt_local(max_t, tz),
                    "set_local": fmt_local(set_t, tz),
                    "max_elevation_deg": max_el,
                    "max_azimuth_deg": max_az,
                    "duration_seconds": duration_s,
                    "observer_sun_alt_deg": float(obs_sun_alt),
                    "iss_sunlit": iss_sunlit,
                    "likely_visible": visible,
                    "visibility_label": visibility_label,
                }
            )
            i += 3
        else:
            i += 1

    payload = {"passes": results}

    _PASS_CACHE["key"] = key
    _PASS_CACHE["expires_utc"] = now_utc() + timedelta(seconds=PASS_CACHE_SECONDS)
    _PASS_CACHE["payload"] = payload

    return jsonify(payload)


@app.get("/api/track")
def api_track():
    """
    Returns predicted ground track for the next N minutes.

    Query params:
      minutes (default 90)
      step_seconds (default 60)
    """
    sat = get_satellite_cached()

    minutes = int(request.args.get("minutes", 90))
    step_seconds = int(request.args.get("step_seconds", 60))

    minutes = max(5, min(minutes, 180))          # clamp 5..180
    step_seconds = max(5, min(step_seconds, 300))  # clamp 5..300

    key = cache_key_track(minutes, step_seconds)
    expires = _TRACK_CACHE["expires_utc"]
    if _TRACK_CACHE["key"] == key and isinstance(expires, datetime) and now_utc() < expires:
        payload = _TRACK_CACHE["payload"]
        if payload is not None:
            return jsonify(payload)

    start = now_utc()
    count = int((minutes * 60) / step_seconds) + 1

    points: list[dict[str, Any]] = []
    for n in range(count):
        dt = start + timedelta(seconds=n * step_seconds)
        t = ts.from_datetime(dt)
        subpoint = wgs84.subpoint(sat.at(t))
        points.append(
            {
                "utc": dt.isoformat(),
                "lat": float(subpoint.latitude.degrees),
                "lon": float(subpoint.longitude.degrees),
            }
        )

    payload = {"minutes": minutes, "step_seconds": step_seconds, "points": points}

    _TRACK_CACHE["key"] = key
    _TRACK_CACHE["expires_utc"] = now_utc() + timedelta(seconds=TRACK_CACHE_SECONDS)
    _TRACK_CACHE["payload"] = payload

    return jsonify(payload)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
