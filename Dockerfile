FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tzdata curl \
  && rm -rf /var/lib/apt/lists/*

# Install Python deps first for caching
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Pre-download Skyfield ephemeris so first run doesn't pause
# Skyfield caches in the current working directory by default when you call load("de421.bsp")
RUN python -c "from skyfield.api import load; load('de421.bsp'); print('Downloaded de421.bsp')"

# Copy app code
COPY iss_web.py /app/iss_web.py
COPY templates /app/templates
COPY static /app/static

EXPOSE 5000

CMD ["python", "/app/iss_web.py"]