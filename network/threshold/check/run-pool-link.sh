#!/usr/bin/env bash
# Compile the pool-link probe (with keys, to measure it) and run its check in memory.
#   bash network/threshold/check/run-pool-link.sh        (COMPACTC: default /root/compactc-0.36.1/compactc)
set -euo pipefail
cd "$(dirname "$0")"
read -r -a C <<< "${COMPACTC:-/root/compactc-0.36.1/compactc}"
echo "compiler: $("${C[@]}" --version)"
rm -rf out-pool
start=$(date +%s)
"${C[@]}" ../src/pool-link-probe.compact out-pool
echo "compiled with keys in $(( $(date +%s) - start )) s"
echo "== circuit sizes (prover key, verifier key, zkir)"
for f in out-pool/keys/*.prover; do
  c=$(basename "$f" .prover)
  printf '%-16s prover %9s  verifier %6s  zkir %8s\n' "$c" "$(stat -c %s "$f")" "$(stat -c %s "out-pool/keys/$c.verifier")" "$(stat -c %s "out-pool/zkir/$c.bzkir" 2>/dev/null || stat -c %s "out-pool/zkir/$c.zkir")"
done
[ -d ../../node_modules/@midnight-ntwrk/compact-runtime ] || { echo "run npm install in network/ first" >&2; exit 1; }
node pool-link-check.mjs
