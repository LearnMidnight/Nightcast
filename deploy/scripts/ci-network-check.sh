#!/usr/bin/env bash
# CI: check a public network the way docs/preprod-guide.md step 8 does.
# 1. `doctor` (node, indexer HTTP and WebSocket, proof server);
# 2. a fresh wallet syncs and then asks for faucet tokens.
# Writes GitHub annotations; never prints the wallet seed or a project id.
set -uo pipefail
network=$1
annotate() { sed 's/\x1b\[[0-9;]*m//g' "$2" | grep -v '^\s*at ' | grep -v '^\s*$' | tail -"$3" | sed 's/%/%25/g' | awk 'BEGIN{ORS="%0A"} {print substr($0,1,300)}'; }
status=0

if ./nightcast doctor --network "$network" > "doctor-$network.log" 2>&1; then
  echo "::notice title=$network::reachable (node, indexer HTTP and WebSocket, proof server)"
else
  echo "::error title=$network doctor::$(annotate "$network" "doctor-$network.log" 14)"
  status=1
fi

wallet="$RUNNER_TEMP/$network-wallet.secret"
rm -f "$wallet"
./nightcast wallet new --out "$wallet" > /dev/null
seed=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).seed)' "$wallet")
if [ ${#seed} -ne 64 ]; then echo "::error title=$network::could not read the new wallet's seed"; exit 1; fi
# Phase 1: sync for up to SYNC_SECS (or until it asks for faucet tokens), then stop it.
# Phase 2: run again briefly; it must carry on from the saved state, not start over.
sync_secs=${SYNC_SECS:-600}
run_wallet() { # $1 = log file, $2 = seconds
  ./nightcast wallet show --network "$network" --wallet "$wallet" > "$1" 2>&1 &
  local pid=$! start=$SECONDS
  while kill -0 $pid 2>/dev/null && ! grep -q 'has no NIGHT yet' "$1" && [ $((SECONDS - start)) -lt "$2" ]; do sleep 5; done
  kill -INT $pid 2>/dev/null || true
  sleep 3
  kill $pid 2>/dev/null || true
  docker ps -q --filter "name=proof-server" | xargs -r docker rm -f > /dev/null 2>&1 || true
}
start=$SECONDS
run_wallet "sync-$network.log" "$sync_secs"
elapsed=$((SECONDS - start))
last1=$(grep -o 'shielded [0-9.]*% ([0-9]*' "sync-$network.log" | tail -1 | grep -o '([0-9]*' | tr -d '(')
if ! grep -q 'has no NIGHT yet' "sync-$network.log"; then
  run_wallet "resume-$network.log" 150
  first2=$(grep -o 'shielded [0-9.]*% ([0-9]*' "resume-$network.log" | head -1 | grep -o '([0-9]*' | tr -d '(')
  if grep -q 'Carrying on from the saved wallet state' "resume-$network.log"; then
    echo "::notice title=$network resume::second run carried on from saved state (shielded event ${last1:-?} before stopping, ${first2:-?} after resuming)"
  else
    echo "::error title=$network resume::second run did not use the saved state%0A$(annotate "$network" "resume-$network.log" 12)"
    status=1
  fi
  cat "resume-$network.log" >> "sync-$network.log"
fi

if grep -q "$seed" "sync-$network.log"; then
  echo "::error title=$network wallet seed printed::the wallet seed appeared in the output"
  status=1
fi
if [ -n "${NIGHTCAST_BLOCKFROST_PROJECT_ID:-}" ] && grep -qF "$NIGHTCAST_BLOCKFROST_PROJECT_ID" "doctor-$network.log" "sync-$network.log"; then
  echo "::error title=$network project id printed::the Blockfrost project id appeared in the output"
  status=1
fi
if grep -q 'has no NIGHT yet' "sync-$network.log"; then
  echo "::notice title=$network wallet sync::synced in ${elapsed}s, then asked for faucet tokens as expected"
elif grep -q 'Syncing: ' "sync-$network.log" && ! grep -q 'Wallet.Sync' "sync-$network.log"; then
  echo "::notice title=$network wallet sync::still syncing after ${elapsed}s with no errors: $(grep 'Syncing: ' "sync-$network.log" | tail -1 | sed 's/.*Syncing: //')"
else
  echo "::error title=$network wallet sync::$(annotate "$network" "sync-$network.log" 30)"
  status=1
fi
exit $status
