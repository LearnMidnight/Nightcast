#!/usr/bin/env bash
# The threshold network on the VM's test set-up (the checkout, proof server and wallets that
# network/vm/net.sh installed: /root/Nightcast-net, 127.0.0.1:6304, /root/nightcast-net).
# Its own keys and records live in /root/nightcast-net/threshold. Nothing live is touched.
#
#   bash tnet.sh offline [settings]   no network: build the deploy, its updates and the lock, price them, check them
#   bash tnet.sh keys                 the house's four operator keys, 12 test pool keys with their list, 5 operator keys
#                                     (prints public ids only; existing keys are kept)
#   bash tnet.sh deploy [settings]    deploy on Preprod from the requester's wallet, add the circuits, lock, check
#   bash tnet.sh status               what the chain shows of the deployed contract (no wallet)
#   bash tnet.sh coins [n]            give the operators' wallet n DUST coins to pay fees with (3 by default): every
#                                     call below pays its fee with three, which ledger 9's time allowance needs
#                                     (see ops.mjs). Once; it takes some minutes.
#   bash tnet.sh first                the first real proofs, each timed, from the operators' wallet: load the pool
#                                     list, register the house's four and op-1 and op-5, link those two to
#                                     pool-1 and pool-5, and op-5 leaves. All before any epoch.
#   bash tnet.sh epoch                open the next epoch, seat it, run the whole ceremony for every seat (the keys
#                                     are all here), and end it: for 3 of 5 that is 37 proofs, about half an hour
#   bash tnet.sh ask [tag]            a request to the serving committee, every seat's answer, and the value
#   bash tnet.sh do <action> ...      any of the actions (see network/threshold/ops/ops.mjs)
#   bash tnet.sh midnight             read-only: who produces Midnight's blocks on Preprod (for the real pool list)
#   bash tnet.sh proof-restart        install this checkout's proof server unit (its memory settings) and restart it
# Settings: see the top of network/threshold/ops/deploy.mjs. Proof times, and each transaction's size and
# price, are kept in $DATA/proofs.jsonl.
set -euo pipefail

REPO=/root/Nightcast-net
DATA=/root/nightcast-net/threshold
REQW=/root/nightcast-net/requester-wallet.secret
OPW=/root/nightcast-net/operators-wallet.secret
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
    # One process per wallet: the old test's requester uses the same one.
    if systemctl is-active -q nightcast-net-requester; then echo "the old test's requester is running and uses this wallet: stop it first (bash network/vm/net.sh stop)" >&2; exit 1; fi
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "the proof server on $PORT isn't answering: systemctl start nightcast-net-proof, wait a minute, and try again" >&2; exit 1; }
    # Midnight's own Preprod node was retired on 24 Nov 2026: Blockfrost's serves the chain.
    NIGHTCAST_NODE_URL=blockfrost NIGHTCAST_NODE_WS=blockfrost node network/threshold/ops/deploy.mjs deploy --wallet "$REQW" --house "$DATA" --pools "$DATA/pool-list.json" --proof-server-port "$PORT" "${@:2}"
    ;;
  proof-restart)
    cp network/vm/nightcast-net-proof.service /etc/systemd/system/nightcast-net-proof.service
    systemctl daemon-reload
    systemctl restart nightcast-net-proof
    for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 3; done
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "the proof server on $PORT isn't answering after 90 s: journalctl -u nightcast-net-proof -n 20" >&2; exit 1; }
    say "Proof server answering on $PORT; its memory ceiling: $(docker inspect -f '{{.HostConfig.Memory}}' nightcast-net-proof | awk '{ printf "%.1f GiB", $1 / 1073741824 }'); log kept to $(docker inspect -f '{{index .HostConfig.LogConfig.Config "max-size"}}' nightcast-net-proof) x 2"
    free -m | sed -n 1,2p
    ;;
  midnight)
    node network/threshold/ops/midnight-committee.mjs
    ;;
  status)
    NIGHTCAST_NODE_URL=blockfrost NIGHTCAST_NODE_WS=blockfrost node network/threshold/ops/ops.mjs status --proof-server-port "$PORT"
    ;;
  first|do|epoch|ask|coins)
    # One process per wallet: the old test's shared operators service uses the same one.
    if systemctl is-active -q nightcast-net-operators; then echo "the old test's operators service is running and uses this wallet: stop it first (bash network/vm/net.sh stop)" >&2; exit 1; fi
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "the proof server on $PORT isn't answering: systemctl start nightcast-net-proof, wait a minute, and try again" >&2; exit 1; }
    # Fees are paid with several DUST coins (ops.mjs --dust-spends): that needs the option the checkout adds to the dust wallet.
    patch=$(node deploy/scripts/patch-dust-two-spends.mjs --check 2>&1) || { echo "$patch" >&2; echo "the dust wallet installed here isn't the one the several-DUST-spends option was written for: tell Claude what the line above says" >&2; exit 1; }
    echo "$patch" | grep -Eq 'already there|added to' || { echo "$patch" >&2; echo "the several-DUST-spends option isn't installed (no dust wallet found): run npm ci in $REPO" >&2; exit 1; }
    case "$1" in
      first) set -- do load-pools register:house-1 register:house-2 register:house-3 register:house-4 register:op-1 link:op-1:pool-1 register:op-5 link:op-5:pool-5 leave:op-5 ;;
      epoch) set -- do open seat deal finish ;;
      ask) set -- do "request:${2:-test}" answer finalise ;;
      coins) set -- do "coins:${2:-3}" ;;
    esac
    # NIGHT that comes back as change is registered for DUST when the wallet opens, so its coins keep generating.
    NIGHTCAST_REGISTER_NEW_NIGHT=1 NIGHTCAST_NODE_URL=blockfrost NIGHTCAST_NODE_WS=blockfrost node network/threshold/ops/ops.mjs do --wallet "$OPW" --dir "$DATA" --log "$DATA/proofs.jsonl" --proof-server-port "$PORT" --proof-container nightcast-net-proof "${@:2}"
    ;;
  *) sed -n 2,24p "$0"; exit 2 ;;
esac
