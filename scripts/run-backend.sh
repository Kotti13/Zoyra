#!/usr/bin/env bash
# Runs the Zoyra backend (the NewPipe service and the gateway) on this machine.
#
#   bash scripts/run-backend.sh            start both (foreground; Ctrl+C stops both)
#   bash scripts/run-backend.sh --check    only check that everything needed is in place
#
# Reads services/gateway/.env (copy services/gateway/.env.example and fill NEWPIPE_BASE, NEWPIPE_TOKEN, ZOYRA_API_KEY).
# Needs: Java 17+, gradle (first run builds the NewPipe service), Python 3.12+, and ffmpeg (for mp3 downloads).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GW="$ROOT/services/gateway"
NP="$ROOT/services/newpipe"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1

fail() { echo "✗ $1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed. $2"; echo "✓ $1"; }

need java "Install Java 17 or newer (macOS: brew install openjdk@17)."
need python3 "Install Python 3.12 or newer."
command -v ffmpeg >/dev/null 2>&1 && echo "✓ ffmpeg" || echo "! ffmpeg not found: mp3 downloads will answer 503 (macOS: brew install ffmpeg)"
[ -f "$GW/.env" ] || fail "Missing $GW/.env. Copy .env.example to .env and fill in NEWPIPE_BASE, NEWPIPE_TOKEN and ZOYRA_API_KEY."
set -a; . "$GW/.env"; set +a
for v in NEWPIPE_BASE NEWPIPE_TOKEN ZOYRA_API_KEY; do [ -n "${!v:-}" ] || fail "$v is empty in $GW/.env"; done
echo "✓ .env has NEWPIPE_BASE, NEWPIPE_TOKEN, ZOYRA_API_KEY"
[ "$CHECK" = 1 ] && { echo "All set."; exit 0; }

# NewPipe service: build once, then run on the port NEWPIPE_BASE points at.
if [ ! -x "$NP/build/install/zoyra-newpipe/bin/zoyra-newpipe" ]; then
  need gradle "Install gradle (macOS: brew install gradle)."
  (cd "$NP" && gradle --no-daemon -q installDist)
fi
# Gateway: its own virtualenv, created on first run.
if [ ! -x "$GW/.venv/bin/uvicorn" ]; then
  python3 -m venv "$GW/.venv"
  "$GW/.venv/bin/pip" install -q -r "$GW/requirements.txt"
fi

NP_PORT="${NEWPIPE_BASE##*:}"; NP_PORT="${NP_PORT%%/*}"
PORT="$NP_PORT" NEWPIPE_TOKEN="$NEWPIPE_TOKEN" "$NP/build/install/zoyra-newpipe/bin/zoyra-newpipe" &
NP_PID=$!
trap 'kill "$NP_PID" 2>/dev/null || true' EXIT INT TERM
sleep 3
cd "$GW"
echo "Gateway on http://0.0.0.0:${PORT:-8080}  (NewPipe service on :$NP_PORT)"
exec "$GW/.venv/bin/uvicorn" app.main:app --host 0.0.0.0 --port "${PORT:-8080}" --proxy-headers
