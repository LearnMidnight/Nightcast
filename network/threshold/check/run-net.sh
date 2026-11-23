#!/usr/bin/env bash
# Compile the threshold network contract (with keys, to measure the circuits) and run its checks
# in memory.   bash network/threshold/check/run-net.sh     (COMPACTC: default /root/compactc-0.36.1/compactc)
set -euo pipefail
cd "$(dirname "$0")"
read -r -a C <<< "${COMPACTC:-/root/compactc-0.36.1/compactc}"
echo "compiler: $("${C[@]}" --version)"
"${C[@]}" --version | grep -q '0\.36\.[1-9]' || { echo "needs Compact 0.36.1 or later" >&2; exit 1; }
rm -rf out-net
start=$(date +%s)
"${C[@]}" ../src/threshold-net.compact out-net
echo "compiled with keys in $(( $(date +%s) - start )) s"
echo "== circuit sizes (prover key, verifier key, zkir)"
for f in out-net/keys/*.prover; do
  c=$(basename "$f" .prover)
  printf '%-12s prover %9s  verifier %6s  zkir %8s\n' "$c" "$(stat -c %s "$f")" "$(stat -c %s "out-net/keys/$c.verifier")" "$(stat -c %s "out-net/zkir/$c.bzkir" 2>/dev/null || stat -c %s "out-net/zkir/$c.zkir")"
done
[ -d ../../node_modules/@midnight-ntwrk/compact-runtime ] || { echo "run npm install in network/ first" >&2; exit 1; }
node net-check.mjs
