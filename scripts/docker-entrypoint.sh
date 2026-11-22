#!/bin/sh
# Container start for the combined backend image: the NewPipe service (when NEWPIPE_TOKEN is set) and the gateway.
# Without NEWPIPE_TOKEN only the gateway runs, exactly like the earlier gateway-only image.
set -e
NEWPIPE_BIN="${NEWPIPE_BIN:-/opt/newpipe/bin/zoyra-newpipe}"
if [ -n "${NEWPIPE_TOKEN:-}" ]; then
  : "${NEWPIPE_BASE:=http://127.0.0.1:8090}"
  export NEWPIPE_BASE
  # PORT=8090 applies to this one process only: the gateway below keeps the host's own PORT.
  PORT=8090 "$NEWPIPE_BIN" &
fi
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8080}" --proxy-headers --forwarded-allow-ips='*'
