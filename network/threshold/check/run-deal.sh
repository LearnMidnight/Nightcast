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
if ! "${C[@]}" ../src/deal-probe.compact out-deal; then
  # Which circuit stops the compiler? Compile each on its own (the others cut out).
  echo "== the compiler stopped: trying each circuit on its own"
  for c in registerKey dealCommit dealShare castEdge pointEdge; do
    awk -v keep="$c" '
      /^export circuit / { name = $3; sub(/\(.*/, "", name); skip = (name != keep) }
      !skip { print }
      skip && /^}/ { skip = 0 }
    ' ../src/deal-probe.compact > "/tmp/deal-probe-$c.compact"
    if "${C[@]}" "/tmp/deal-probe-$c.compact" "/tmp/deal-probe-out-$c" > "/tmp/deal-probe-$c.log" 2>&1; then
      echo "$c: compiles"
    else
      echo "$c: STOPS ($(grep -m1 -E "must enable|Exception|error" "/tmp/deal-probe-$c.log" | cut -c1-120))"
    fi
  done
  exit 1
fi
echo "compiled with keys in $(( $(date +%s) - start )) s"
echo "== circuit sizes (prover key, verifier key, zkir)"
for f in out-deal/keys/*.prover; do
  c=$(basename "$f" .prover)
  printf '%-16s prover %8s  verifier %6s  zkir %8s\n' "$c" "$(stat -c %s "$f")" "$(stat -c %s "out-deal/keys/$c.verifier")" "$(stat -c %s "out-deal/zkir/$c.bzkir" 2>/dev/null || stat -c %s "out-deal/zkir/$c.zkir")"
done
[ -d ../../node_modules/@midnight-ntwrk/compact-runtime ] || { echo "run npm install in network/ first" >&2; exit 1; }
node deal-check.mjs
