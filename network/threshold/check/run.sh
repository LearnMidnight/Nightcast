#!/usr/bin/env bash
# Compile the threshold probe with Compact 0.36 (with its keys, to measure the circuits) and run
# its checks in memory. COMPACTC: a compactc 0.36 binary (default: compactc on PATH).
#   COMPACTC=/root/compactc-0.36/compactc bash network/threshold/check/run.sh
set -euo pipefail
cd "$(dirname "$0")"
read -r -a C <<< "${COMPACTC:-compactc}"
"${C[@]}" --version | grep -q '0\.36\.' || { echo "needs Compact 0.36.x (got $("${C[@]}" --version))" >&2; exit 1; }
rm -rf out
start=$(date +%s)
"${C[@]}" ../src/threshold-probe.compact out
echo "compiled with keys in $(( $(date +%s) - start )) s"
echo "== circuit sizes (prover key, verifier key, zkir)"
for f in out/keys/*.prover; do
  c=$(basename "$f" .prover)
  printf '%-16s prover %8s  verifier %6s  zkir %8s\n' "$c" "$(stat -c %s "$f")" "$(stat -c %s "out/keys/$c.verifier")" "$(stat -c %s "out/zkir/$c.bzkir" 2>/dev/null || stat -c %s "out/zkir/$c.zkir")"
done
# for comparison: the live network contract's answer circuit, if built here
for ref in /root/Nightcast-net/network/check/out /root/Nightcast-net/network/out; do
  [ -f "$ref/keys/answer.prover" ] && printf '%-16s prover %8s  (the operator network contract on this machine)\n' "network answer" "$(stat -c %s "$ref/keys/answer.prover")" && break
done
# the probe's runtime: network/node_modules (the copy Midnight.js's compact-js uses)
[ -d ../../node_modules/@midnight-ntwrk/compact-runtime ] || { echo "run npm install in network/ first" >&2; exit 1; }
node check.mjs
