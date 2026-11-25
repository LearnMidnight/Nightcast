#!/usr/bin/env bash
# Compile the Nightcast network contract with Compact 0.36, with its proving keys, into network/build
# (what the deploy, operator and requester scripts use).
#   bash network/build.sh
# The compiler: COMPACTC (a compactc 0.36 binary, or "compact compile +0.36.0"); the Compact tool otherwise.
set -euo pipefail
cd "$(dirname "$0")"
read -r -a C <<< "${COMPACTC:-compact compile +0.36.0}"
"${C[@]}" --version | grep -q '0\.36\.' || { echo "needs Compact 0.36.x (got $("${C[@]}" --version))" >&2; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
rm -rf build.new
"${C[@]}" src/network.compact build.new
rm -rf build && mv build.new build
echo "Built: $(ls build/keys/*.verifier | wc -l) circuits with keys in $(pwd)/build"
