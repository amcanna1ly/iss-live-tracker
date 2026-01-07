# ISS Live Tracker

A lightweight, Dockerized web dashboard for live International Space Station tracking, ground tracks, and observer-based pass visibility predictions.

This project provides a self-hosted web interface that shows the ISS’s real-time position, predicted ground track, and upcoming passes from a chosen observer location, including a visibility heuristic based on lighting conditions.

---

## Features

- **Live ISS position**
  - Latitude / longitude
  - Altitude and orbital speed
  - Auto-refreshing state display

- **Interactive world map**
  - Live ISS marker
  - Recent orbital trail
  - Forward ground-track projection (configurable)
  - Follow/unfollow ISS toggle

- **Pass predictions**
  - Observer-based rise, max, and set times
  - Maximum elevation and pass duration
  - Visibility estimation:
    - Observer in darkness (civil twilight or darker)
    - ISS sunlit at peak elevation

- **Modern dashboard UI**
  - Dark theme optimized for low-light viewing
  - Responsive layout (desktop, tablet, mobile)
  - No external JS frameworks

- **Docker-first deployment**
  - Runs cleanly on Raspberry Pi (ARM64) or x86_64
  - All dependencies isolated
  - Ephemeris data preloaded for fast startup

---

## Quick Start (Docker – Recommended)

### Pull the image

```bash
docker pull amcannally/iss-live-tracker:latest
```

### Run the container

```bash
docker run -d \
  --name iss-live-tracker \
  --restart unless-stopped \
  -p 5000:5000 \
  amcannally/iss-live-tracker:latest
```

Open in your browser:

```
http://<host-ip>:5000/
```

---

## Docker Compose (Optional)

```yaml
services:
  iss-live-tracker:
    image: amcannally/iss-live-tracker:latest
    container_name: iss-live-tracker
    restart: unless-stopped
    ports:
      - "5000:5000"
    environment:
      - TZ=America/Chicago
```

Start it:

```bash
docker compose up -d
```

---

## Running From Source (Development)

### Requirements

- Python 3.11+
- Internet access (for TLE updates and map tiles)

### Setup

```bash
git clone https://github.com/amcanna1ly/iss-live-tracker.git
cd iss-live-tracker

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Run

```bash
python iss_web.py
```

Open:

```
http://127.0.0.1:5000/
```

---

## Configuration Notes

- **TLE data** is fetched from Celestrak and cached in memory.
- **Ephemeris data (`de421.bsp`)** is required for Sun/visibility calculations.
  - When using Docker, this is downloaded at build time.
- **Map tiles** are served from OpenStreetMap (internet required).

---

## API Endpoints

- `GET /api/state` – current ISS position and orbital state
- `GET /api/passes` – upcoming observer-based passes
- `GET /api/track` – predicted ground track points

---

## Architecture

- **Backend:** Flask, Skyfield, SGP4
- **Frontend:** Vanilla HTML/CSS/JS, Leaflet
- **Data Sources:** Celestrak, JPL DE421, OpenStreetMap

---

## Project Structure

[placeholder]

---

## Raspberry Pi Notes

- Tested on Raspberry Pi 5 (ARM64)
- Runs comfortably on low-resource hardware

---

## License

MIT License.

---

## Acknowledgements

- Celestrak – ISS TLE data
- Skyfield – orbital mechanics and ephemeris
- OpenStreetMap – map tiles
