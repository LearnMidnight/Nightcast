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
#   NIGHTCAST_PROOF_MEMORY_MIB=0 turns that off (for circuits whose proofs need more than any such limit).
# The container's log is kept small (NIGHTCAST_PROOF_LOG_MAX, default 50m, twice), and with
# NIGHTCAST_PROOF_CONTAINER_MEMORY (e.g. 11g) the container may use no more than that: a proof that needs
# more ends that container alone, instead of the machine running out and the kernel choosing what to kill.
# (24 Nov 2026: a 302 MB circuit took the proof server past 6.5 GB while this script, reading the whole
# log into a variable to see whether it was idle, grew to 12 GB; the machine ran out of memory.)
#
# Reachable from this machine only: the oracle's secret key passes through it.
set -euo pipefail

PORT="${NIGHTCAST_PROOF_PORT:-6303}"
NAME="${NIGHTCAST_PROOF_NAME:-nightcast-proof}"
LIMIT_MIB="${NIGHTCAST_PROOF_MEMORY_MIB:-3072}"
VOLUME="${NIGHTCAST_PROOF_PARAMS_VOLUME:-nightcast-zk-params}"
LOG_MAX="${NIGHTCAST_PROOF_LOG_MAX:-50m}"
CONTAINER_MEMORY="${NIGHTCAST_PROOF_CONTAINER_MEMORY:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="$(grep -o 'midnightntwrk/proof-server:[0-9][0-9.]*' "$ROOT/deploy/docker/proof-server.yml" | head -1)"
[ -n "$IMAGE" ] || { echo "no proof-server image in $ROOT/deploy/docker/proof-server.yml" >&2; exit 1; }

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
stopping=0

start() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  local cap=()
  [ -z "$CONTAINER_MEMORY" ] || cap=(--memory "$CONTAINER_MEMORY" --memory-swap "$CONTAINER_MEMORY")
  docker run -d --rm --name "$NAME" \
    -p "127.0.0.1:${PORT}:6300" \
    -v "${VOLUME}:/params" -e MIDNIGHT_PP=/params \
    --log-driver json-file --log-opt "max-size=${LOG_MAX}" --log-opt max-file=2 ${cap[@]+"${cap[@]}"} \
    "$IMAGE" midnight-proof-server --verbose >/dev/null
  log "Proof server $IMAGE started on 127.0.0.1:${PORT} (container $NAME${CONTAINER_MEMORY:+, at most $CONTAINER_MEMORY of memory})."
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
# The log is counted as it streams by, never held: it can be very large.
idle() {
  local starts ends recent
  starts="$(docker logs "$NAME" 2>&1 | grep -c 'Starting to process request for /prove' || true)"
  ends="$(docker logs "$NAME" 2>&1 | grep -cE 'POST /prove\b.*took' || true)"
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
  if [ "$LIMIT_MIB" -gt 0 ] && [ -n "$mem" ] && [ "$mem" -gt "$LIMIT_MIB" ] && idle; then
    log "Proof server idle at ${mem} MiB (limit ${LIMIT_MIB}); restarting it to free memory."
    start
  fi
done
