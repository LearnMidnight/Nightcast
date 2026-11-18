#!/usr/bin/env bash
# Update Nightcast on a VM (the oracle, the MCP server for LunaSpin, and their own proof server) to
# origin/main, in one go:
#
#   bash /root/Nightcast/deploy/vm/update.sh            # update to origin/main and restart
#   bash /root/Nightcast/deploy/vm/update.sh --check    # only check that the services are healthy
#
# What it does:
#  1. refuses to start if tracked files in the checkout were changed by hand;
#  2. pulls origin/main (fast-forward only);
#  3. removes EVERY node_modules (root and workspaces): `npm ci` only clears the root one, and stale
#     packages left in deploy/node_modules were loaded first and broke the MCP server (18 Nov 2026);
#  4. `npm ci`, then builds contract (when its compiled output is here), sdk and deploy: deploy is
#     type-checked against the sdk's built output, so the sdk must be built first (18 Nov 2026);
#  5. checks the installed Midnight packages load (the ledger 8 and 9 protocol modules);
#  6. pulls the proof-server image named in deploy/docker/proof-server.yml;
#  7. installs deploy/vm/*.service into /etc/systemd/system when they differ (per-machine settings stay
#     in drop-ins), and enables nightcast-proof;
#  8. restarts nightcast-proof, then nightcast-oracle and nightcast-mcp (the install changed the
#     packages under them, so they are always restarted), and checks they come up.
# If anything in steps 2-5 fails, it goes back to the commit it started from, installs and builds
# that again, and restarts on it, so the services never run half-updated code.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
UNITS=(nightcast-proof nightcast-oracle nightcast-mcp)
say() { echo "== $*"; }
# The port nightcast-proof listens on (from its unit; 6303 by default).
proof_port() {
  local p
  p="$( (systemctl show nightcast-proof -p Environment --value 2>/dev/null || true) | grep -o 'NIGHTCAST_PROOF_PORT=[0-9]*' | cut -d= -f2 || true)"
  echo "${p:-6303}"
}

check() {
  local ok=1
  for u in "${UNITS[@]}"; do
    printf '%-18s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)"
    systemctl is-active --quiet "$u" || ok=0
  done
  local port
  port="$(proof_port)"
  if curl -sf -m 5 "http://127.0.0.1:${port}/version" >/dev/null; then
    echo "proof server       answers on 127.0.0.1:${port}"
  else
    echo "proof server       NOT answering on 127.0.0.1:${port}"; ok=0
  fi
  journalctl -u nightcast-oracle -u nightcast-mcp --since "-3 min" -o cat 2>/dev/null | grep -E 'Oracle running|WARN|ERROR' | tail -8 || true
  [ "$ok" -eq 1 ]
}

if [ "${1:-}" = "--check" ]; then check; exit $?; fi

# Each step checks its own result: this runs inside an `if`, where `set -e` doesn't stop on a failure.
install_and_build() {
  rm -rf node_modules contract/node_modules sdk/node_modules deploy/node_modules examples/*/node_modules || return 1
  npm ci --no-audit --no-fund || return 1
  if [ -d contract/src/managed ]; then
    npm run build -w @nightcast/contract || return 1
  else
    say "contract/src/managed not here: keeping contract/dist as it is"
  fi
  npm run build -w @nightcast/sdk || return 1
  npm run build -w @nightcast/deploy || return 1
  (cd deploy && node -e 'Promise.all([import("@midnight-ntwrk/midnight-js-protocol/v8"), import("@midnight-ntwrk/midnight-js-protocol/v9")]).then(() => console.log("Midnight protocol modules load (ledger 8 and 9)"))') || return 1
}

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Tracked files were changed by hand in $ROOT; commit or undo them first:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

FROM="$(git rev-parse HEAD)"
say "Updating from $(git log --oneline -1 HEAD)"
git fetch -q origin
if ! { git merge --ff-only -q origin/main && say "Now at $(git log --oneline -1 HEAD)" && install_and_build; }; then
  say "The update failed: going back to ${FROM:0:7}, rebuilding it and restarting on it."
  git reset -q --hard "$FROM"
  install_and_build
  systemctl restart nightcast-oracle nightcast-mcp
  sleep 60
  check || true
  exit 1
fi

IMAGE="$(grep -o 'midnightntwrk/proof-server:[0-9][0-9.]*' deploy/docker/proof-server.yml | head -1)"
say "Proof server image: $IMAGE"
docker pull -q "$IMAGE" >/dev/null

changed=0
for u in "${UNITS[@]}"; do
  if ! cmp -s "deploy/vm/$u.service" "/etc/systemd/system/$u.service"; then
    install -m 644 "deploy/vm/$u.service" "/etc/systemd/system/$u.service"
    say "Installed $u.service"
    changed=1
  fi
done
[ "$changed" -eq 0 ] || systemctl daemon-reload
systemctl enable -q nightcast-proof

say "Restarting the proof server, then the oracle and the MCP server"
systemctl restart nightcast-proof
PORT="$(proof_port)"
for _ in $(seq 1 60); do curl -sf -m 2 "http://127.0.0.1:${PORT}/version" >/dev/null && break; sleep 2; done
systemctl restart nightcast-oracle nightcast-mcp
sleep 90
check
