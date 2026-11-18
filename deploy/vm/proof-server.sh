#!/usr/bin/env bash
# Nightcast's own proof server for a VM (systemd: nightcast-proof.service).
#
# Runs Midnight's proof server in Docker on 127.0.0.1:$NIGHTCAST_PROOF_PORT (default 6303), with the image
# named in deploy/docker/proof-server.yml, so it moves with Nightcast's own version updates. It stays in the
# foreground for systemd and:
# - starts the container again if it stops on its own;
# - restarts it when it is idle (no proof running, none finished in the last 30 s) and using more than
#   $NIGHTCAST_PROOF_MEMORY_MIB (default 3072): a long-running proof server grows slower and bigger
#   (Lunardraw's first Preprod soak, Oct 2026; the same rule as `./lunardraw proof-server`).
#
# Reachable from this machine only: the oracle's secret key passes through it.
set -euo pipefail

PORT="${NIGHTCAST_PROOF_PORT:-6303}"
NAME="${NIGHTCAST_PROOF_NAME:-nightcast-proof}"
LIMIT_MIB="${NIGHTCAST_PROOF_MEMORY_MIB:-3072}"
VOLUME="${NIGHTCAST_PROOF_PARAMS_VOLUME:-nightcast-zk-params}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="$(grep -o 'midnightntwrk/proof-server:[0-9][0-9.]*' "$ROOT/deploy/docker/proof-server.yml" | head -1)"
[ -n "$IMAGE" ] || { echo "no proof-server image in $ROOT/deploy/docker/proof-server.yml" >&2; exit 1; }

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
stopping=0

start() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --rm --name "$NAME" \
    -p "127.0.0.1:${PORT}:6300" \
    -v "${VOLUME}:/params" -e MIDNIGHT_PP=/params \
    "$IMAGE" midnight-proof-server --verbose >/dev/null
  log "Proof server $IMAGE started on 127.0.0.1:${PORT} (container $NAME)."
}

running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" = "true" ]; }

# MiB in use ("1.2GiB / 23.4GiB" -> 1228), or empty.
mem_mib() {
  docker stats --no-stream --format '{{.MemUsage}}' "$NAME" 2>/dev/null | awk '{
    v = $1; n = v + 0;
    if (v ~ /GiB$/) n *= 1024; else if (v ~ /KiB$/) n /= 1024; else if (v ~ /B$/ && v !~ /MiB$/) n /= 1048576;
    printf "%d", n }'
}

# Idle: every "Starting to process request for /prove" has its "POST /prove ... took", and none ended in the last 30 s.
idle() {
  local all starts ends recent
  all="$(docker logs "$NAME" 2>&1 || true)"
  starts="$(grep -c 'Starting to process request for /prove' <<<"$all" || true)"
  ends="$(grep -cE 'POST /prove\b.*took' <<<"$all" || true)"
  recent="$(docker logs --since 30s "$NAME" 2>&1 | grep -cE 'POST /prove\b.*took' || true)"
  [ "${starts:-0}" -le "${ends:-0}" ] && [ "${recent:-0}" -eq 0 ]
}

shutdown() { stopping=1; log "Stopping the proof server."; docker stop "$NAME" >/dev/null 2>&1 || true; exit 0; }
trap shutdown TERM INT

start
while [ "$stopping" -eq 0 ]; do
  sleep 15 &
  wait $! || true
  [ "$stopping" -eq 0 ] || break
  if ! running; then
    log "The proof server stopped; starting it again."
    start
    continue
  fi
  mem="$(mem_mib)"
  if [ -n "$mem" ] && [ "$mem" -gt "$LIMIT_MIB" ] && idle; then
    log "Proof server idle at ${mem} MiB (limit ${LIMIT_MIB}); restarting it to free memory."
    start
  fi
done
