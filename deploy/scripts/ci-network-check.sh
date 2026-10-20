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
seed=$(node -e 'console.log(require(process.argv[1]).seed)' "$wallet")
./nightcast wallet show --network "$network" --wallet "$wallet" > "sync-$network.log" 2>&1 &
pid=$!
start=$SECONDS
while kill -0 $pid 2>/dev/null && ! grep -q 'has no NIGHT yet' "sync-$network.log" && [ $((SECONDS - start)) -lt 900 ]; do sleep 5; done
kill $pid 2>/dev/null || true
sleep 2
docker ps -q --filter "name=proof-server" | xargs -r docker rm -f > /dev/null 2>&1 || true

if grep -q "$seed" "sync-$network.log"; then
  echo "::error title=$network wallet seed printed::the wallet seed appeared in the output"
  status=1
fi
if [ -n "${NIGHTCAST_BLOCKFROST_PROJECT_ID:-}" ] && grep -qF "$NIGHTCAST_BLOCKFROST_PROJECT_ID" "doctor-$network.log" "sync-$network.log"; then
  echo "::error title=$network project id printed::the Blockfrost project id appeared in the output"
  status=1
fi
if grep -q 'has no NIGHT yet' "sync-$network.log"; then
  echo "::notice title=$network wallet sync::synced in $((SECONDS - start))s, then asked for faucet tokens as expected"
else
  echo "::error title=$network wallet sync::$(annotate "$network" "sync-$network.log" 25)"
  status=1
fi
exit $status
