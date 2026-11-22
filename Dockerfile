# Backend image for hosts that build from the repo root (SnapDeploy, Render, Railway, Fly, a VPS ...).
# Runs the whole backend in ONE container: the gateway (services/gateway) and the NewPipe service (services/newpipe).
# The Expo app is not included.
#
# Set these environment variables on the host:
#   ZOYRA_API_KEY   the key the app sends (same value as EXPO_PUBLIC_ZOYRA_API_KEY in the app)
#   NEWPIPE_TOKEN   any long random string; setting it also starts the NewPipe service (music search and streaming)
# Optional: REDIS_URL, SUPABASE_JWT_SECRET / SUPABASE_JWKS_URL (for the /v1 routes), TRUST_PROXY=true behind a proxy.
# The container listens on $PORT (default 8080).

# --- build the NewPipe service (Java) ---
FROM gradle:8.10-jdk17 AS newpipe
WORKDIR /src
COPY services/newpipe/settings.gradle services/newpipe/build.gradle ./
COPY services/newpipe/src ./src
RUN gradle --no-daemon -q installDist

# --- runtime: Python gateway + Java runtime + ffmpeg ---
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
# openjdk: runs the NewPipe service. ffmpeg: /api/download converts the stream to a real .mp3.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg openjdk-17-jre-headless && rm -rf /var/lib/apt/lists/*
COPY services/gateway/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/gateway/app ./app
COPY --from=newpipe /src/build/install/zoyra-newpipe /opt/newpipe
COPY scripts/docker-entrypoint.sh /srv/entrypoint.sh
RUN useradd -r -u 10001 gateway && chmod +x /srv/entrypoint.sh
USER gateway
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','8080'))"
CMD ["/srv/entrypoint.sh"]
