#!/usr/bin/env bash
# Compile the Nightcast network contract with Compact 0.36 and run its in-memory checks.
#   bash network/check/run.sh
# The compiler: COMPACTC (a compactc 0.36 binary, or "compact compile +0.36.0" for the Compact
# tool); "compact compile +0.36.0" otherwise.
set -euo pipefail
cd "$(dirname "$0")"
read -r -a C <<< "${COMPACTC:-compact compile +0.36.0}"
"${C[@]}" --version | grep -q '0\.36\.' || { echo "needs Compact 0.36.x (got $("${C[@]}" --version))" >&2; exit 1; }
rm -rf out
"${C[@]}" --skip-zk ../src/network.compact out
[ -d ../node_modules ] || (cd .. && npm install --no-audit --no-fund)
node check.mjs
node stall-watch.check.mjs
