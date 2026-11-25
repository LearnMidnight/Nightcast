#!/usr/bin/env bash
# Does this compiler still stop on the two shapes that stopped 0.36.0? Each circuit on its own.
#   COMPACTC=/root/compactc-0.36.1/compactc bash network/threshold/check/run-616.sh
set -uo pipefail
cd "$(dirname "$0")"
read -r -a C <<< "${COMPACTC:-compactc}"
echo "compiler: $("${C[@]}" --version)"
for c in fromSecretOnly hashPoint; do
  awk -v keep="$c" '
    /^export circuit / { name = $3; sub(/\(.*/, "", name); skip = (name != keep) }
    !skip { print }
    skip && /^}/ { skip = 0 }
  ' ../src/compiler-616.compact > "/tmp/compiler-616-$c.compact"
  rm -rf "/tmp/compiler-616-out-$c"
  if "${C[@]}" "/tmp/compiler-616-$c.compact" "/tmp/compiler-616-out-$c" > "/tmp/compiler-616-$c.log" 2>&1; then
    echo "$c: compiles, with keys"
  else
    echo "$c: STOPS ($(grep -m1 -E "must enable|cannot convert|Exception|error" "/tmp/compiler-616-$c.log" | cut -c1-140))"
  fi
done
