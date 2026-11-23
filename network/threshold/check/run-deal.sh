#!/usr/bin/env bash
# Compile the deal probe with Compact 0.36 (with its keys, to measure the circuits) and run its
# checks in memory. COMPACTC: a compactc 0.36 binary (default: compactc on PATH).
#   COMPACTC=/root/compactc-0.36/compactc bash network/threshold/check/run-deal.sh
set -euo pipefail
cd "$(dirname "$0")"
read -r -a C <<< "${COMPACTC:-compactc}"
"${C[@]}" --version | grep -q '0\.36\.' || { echo "needs Compact 0.36.x (got $("${C[@]}" --version))" >&2; exit 1; }
rm -rf out-deal
start=$(date +%s)
"${C[@]}" ../src/deal-probe.compact out-deal
echo "compiled with keys in $(( $(date +%s) - start )) s"
echo "== circuit sizes (prover key, verifier key, zkir)"
for f in out-deal/keys/*.prover; do
  c=$(basename "$f" .prover)
  printf '%-16s prover %8s  verifier %6s  zkir %8s\n' "$c" "$(stat -c %s "$f")" "$(stat -c %s "out-deal/keys/$c.verifier")" "$(stat -c %s "out-deal/zkir/$c.bzkir" 2>/dev/null || stat -c %s "out-deal/zkir/$c.zkir")"
done
[ -d ../../node_modules/@midnight-ntwrk/compact-runtime ] || { echo "run npm install in network/ first" >&2; exit 1; }
node deal-check.mjs
