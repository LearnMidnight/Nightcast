#!/usr/bin/env bash
# The threshold network on the VM's test set-up (the checkout, proof server and wallets that
# network/vm/net.sh installed: /root/Nightcast-net, 127.0.0.1:6304, /root/nightcast-net).
# Its own keys and records live in /root/nightcast-net/threshold. Nothing live is touched.
#
#   bash tnet.sh offline [settings]   no network: build the deploy, its updates and the lock, price them, check them
#   bash tnet.sh keys                 the house's four operator keys, 12 test pool keys with their list, 5 operator keys
#                                     (prints public ids only; existing keys are kept)
#   bash tnet.sh deploy [settings]    deploy on Preprod from the requester's wallet, add the circuits, lock, check
# Settings: see the top of network/threshold/ops/deploy.mjs.
set -euo pipefail

REPO=/root/Nightcast-net
DATA=/root/nightcast-net/threshold
REQW=/root/nightcast-net/requester-wallet.secret
PORT=6304
say() { echo "== $*"; }
cd "$REPO"
[ -f network/threshold/check/out-net/contract/index.js ] || { echo "no compiled contract: run bash network/threshold/check/run-net.sh first" >&2; exit 1; }

case "${1:-}" in
  offline)
    if [ -f "$DATA/pool-list.json" ] && [ -f "$DATA/house-1.secret" ]; then
      node network/threshold/ops/deploy.mjs offline --house "$DATA" --pools "$DATA/pool-list.json" "${@:2}"
    else
      node network/threshold/ops/deploy.mjs offline "${@:2}"
    fi
    ;;
  keys)
    mkdir -p "$DATA" && chmod 700 "$DATA"
    say "The house's operators (ids)"
    node network/threshold/ops/keys.mjs house --dir "$DATA"
    say "Test stake pools (public keys) and their list"
    node network/threshold/ops/keys.mjs pools --dir "$DATA" --count 12
    say "Independent operators (ids)"
    node network/threshold/ops/keys.mjs operators --dir "$DATA" --count 5
    ;;
  deploy)
    [ -f "$DATA/pool-list.json" ] || { echo "no keys yet: run bash network/threshold/vm/tnet.sh keys first" >&2; exit 1; }
    node network/threshold/ops/deploy.mjs deploy --wallet "$REQW" --house "$DATA" --pools "$DATA/pool-list.json" --proof-server-port "$PORT" "${@:2}"
    ;;
  *) sed -n 2,10p "$0"; exit 2 ;;
esac
