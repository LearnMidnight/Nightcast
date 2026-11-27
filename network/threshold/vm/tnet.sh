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
#   bash tnet.sh void [tag]           a request only two seats answer: settled as void after its deadline (fines for
#                                     the silent, the fee back), then a third answer and the same value all the same
#   bash tnet.sh rare                 the calls nothing else makes: top up the three fined seats, op-5 takes its bond
#                                     back, house-1 takes 2 slots back, four seats recommend a successor in this
#                                     epoch, the next epoch opens, and four recommend it again (it is then recorded)
#   bash tnet.sh down                 a request only op-1 and house-2 answer, settled void after its deadline: house-1
#                                     (at the minimum bond) falls below it and is stood down. The next epoch is then
#                                     sized without it; bring it back with: do topup:house-1:2 register:house-1
#   bash tnet.sh do <action> ...      any of the actions (see network/threshold/ops/ops.mjs)
#   bash tnet.sh bg <command> ...     first, epoch, ask, do or coins in the background: it goes on if the window closes or the
#                                     connection drops, and is started again if it stalls. Its output goes to $DATA/run.log
#   bash tnet.sh stop                 stop a run (it can be started again: it goes on from what the chain shows)
#   bash tnet.sh log [lines]          whether a run is going, and the end of run.log
#   bash tnet.sh midnight             read-only: who produces Midnight's blocks on Preprod (for the real pool list)
#   bash tnet.sh proof-restart        install this checkout's proof server unit (its memory settings) and restart it
#   bash tnet.sh bundle               check the compiled contract against the chain and pack it for a GitHub release
#                                     (/root/nightcast-net/threshold-net-build-preprod.tar.gz); prints its SHA-256
# The operator package's test: the house's four and op-1 as five operators, each its own process and wallet
# (network/threshold/ops/operator.mjs run), keeping the network going with no epoch commands from here.
#   bash tnet.sh team-setup [tNIGHT]  give each its folder in $TEAM (its key from $DATA, a new wallet) and send each
#                                     wallet tNIGHT from the operators' wallet (150 by default) to make DUST with
#   bash tnet.sh team-start           start the five in the background (started again when they stall); they share
#                                     the proof server one proof at a time
#   bash tnet.sh team-stop            stop them (they go on from what the chain shows when started again)
#   bash tnet.sh team-log [lines]     which are running, and the end of each one's log
#   bash tnet.sh team-status          what the chain shows about each of the five (no wallets)
# Settings: see the top of network/threshold/ops/deploy.mjs. Proof times, and each transaction's size and
# price, are kept in $DATA/proofs.jsonl.
set -euo pipefail

REPO=/root/Nightcast-net
DATA=/root/nightcast-net/threshold
REQW=/root/nightcast-net/requester-wallet.secret
OPW=/root/nightcast-net/operators-wallet.secret
PORT=6304
TEAM=/root/nightcast-net/team
MEMBERS="house-1 house-2 house-3 house-4 op-1"
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
  bundle)
    contract=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).contractAddress)' network/threshold/deployments/preprod.json)
    NIGHTCAST_NODE_URL=blockfrost NIGHTCAST_NODE_WS=blockfrost node network/threshold/ops/bundle.mjs pack --build network/threshold/check/out-net --out /root/nightcast-net/threshold-net-build-preprod.tar.gz --contract "$contract" --network preprod
    ;;
  midnight)
    node network/threshold/ops/midnight-committee.mjs
    ;;
  status)
    NIGHTCAST_NODE_URL=blockfrost NIGHTCAST_NODE_WS=blockfrost node network/threshold/ops/ops.mjs status --proof-server-port "$PORT"
    ;;
  first|do|epoch|ask|void|rare|down|coins)
    # The team acts for the same seats: an epoch command from here as well would deal for them twice.
    if pgrep -f 'tnet-team-loop' >/dev/null && [ "${TEAM_OK:-}" != 1 ]; then echo "the team's operators are running and act for the same seats: stop them first (bash network/threshold/vm/tnet.sh team-stop), or for a request alone: TEAM_OK=1 bash network/threshold/vm/tnet.sh do request:<tag>" >&2; exit 1; fi
    # One process per wallet: the old test's shared operators service uses the same one.
    if systemctl is-active -q nightcast-net-operators; then echo "the old test's operators service is running and uses this wallet: stop it first (bash network/vm/net.sh stop)" >&2; exit 1; fi
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "the proof server on $PORT isn't answering: systemctl start nightcast-net-proof, wait a minute, and try again" >&2; exit 1; }
    # And one of these commands at a time: the lock goes when this one ends, however it ends.
    exec 9>"$DATA/.operators-wallet.lock"
    flock -n 9 || { echo "another tnet.sh command is using the operators' wallet: wait for it to finish (pgrep -af ops.mjs shows it)" >&2; exit 1; }
    # Fees are paid with several DUST coins (ops.mjs --dust-spends): that needs the option the checkout adds to the dust wallet.
    patch=$(node deploy/scripts/patch-dust-two-spends.mjs --check 2>&1) || { echo "$patch" >&2; echo "the dust wallet installed here isn't the one the several-DUST-spends option was written for: tell Claude what the line above says" >&2; exit 1; }
    echo "$patch" | grep -Eq 'already there|added to' || { echo "$patch" >&2; echo "the several-DUST-spends option isn't installed (no dust wallet found): run npm ci in $REPO" >&2; exit 1; }
    case "$1" in
      first) set -- do load-pools register:house-1 register:house-2 register:house-3 register:house-4 register:op-1 link:op-1:pool-1 register:op-5 link:op-5:pool-5 leave:op-5 "${@:2}" ;;
      epoch) set -- do open seat deal finish "${@:2}" ;;
      ask) set -- do "request:${2:-test}" answer finalise ;;
      # A request too few answer: two of five, then (after its deadline) settle, then a third answers late and it is
      # finalised all the same. Silence costs the silent their bond and buys nobody a different value.
      void) set -- do "request:${2:-void}" answer:op-1 answer:house-1 settle answer:house-2 finalise ;;
      down) set -- do "request:${2:-down}" answer:op-1 answer:house-2 settle standdown:house-1 ;;
      rare) set -- do topup:house-2:1 topup:house-3:1 topup:house-4:1 withdraw:op-5:all withdraw:house-1:2 \
              recommend:op-1 recommend:house-1 recommend:house-2 recommend:house-3 \
              open seat deal finish \
              recommend:op-1 recommend:house-1 recommend:house-2 recommend:house-3 ;;
      coins) set -- do "coins:${2:-3}" ;;
    esac
    # NIGHT that comes back as change is registered for DUST when the wallet opens, so its coins keep generating. Fees
    # are gathered from the largest DUST coins first: operators are paid in small amounts, and each payment registered
    # for DUST is one more small coin, which the wallet's own order would spend first (26 Nov 2026: 8 spends a fee).
    NIGHTCAST_DUST_LARGEST_FIRST=1 NIGHTCAST_REGISTER_NEW_NIGHT=1 NIGHTCAST_NODE_URL=blockfrost NIGHTCAST_NODE_WS=blockfrost node network/threshold/ops/ops.mjs do --wallet "$OPW" --dir "$DATA" --log "$DATA/proofs.jsonl" --proof-server-port "$PORT" --proof-container nightcast-net-proof "${@:2}"
    ;;
  bg)
    case "${2:-}" in first|do|epoch|ask|void|rare|down|coins) ;; *) echo "bg takes one of: first, epoch, ask, void, rare, down, do, coins" >&2; exit 2 ;; esac
    if pgrep -f 'node network/threshold/ops/[o]ps.mjs' >/dev/null; then echo "a run is already going: bash network/threshold/vm/tnet.sh log" >&2; exit 1; fi
    echo "==== $(date -u '+%Y-%m-%d %H:%M:%S') UTC: tnet.sh ${*:2}" >> "$DATA/run.log"
    # A run that stalls (the wallet lost the network) ends with code 75: start it again, up to six times.
    nohup bash -c 'for n in 1 2 3 4 5 6; do bash "$0" "$@"; code=$?; [ "$code" = 75 ] || exit "$code"; echo "== started again after a stall (start $((n + 1)) of 6)"; sleep 20; done; exit 75' "$REPO/network/threshold/vm/tnet.sh" "${@:2}" >> "$DATA/run.log" 2>&1 < /dev/null &
    sleep 5
    say "Started in the background: it goes on if this window closes. Look at it with: bash network/threshold/vm/tnet.sh log"
    tail -n 6 "$DATA/run.log"
    ;;
  stop)
    pkill -f 'tnet[.]sh (first|do|epoch|ask|void|rare|down|coins)' || true
    pkill -f "ops[.]mjs do --wallet $OPW" || true
    sleep 3
    if pgrep -f 'node network/threshold/ops/[o]ps.mjs' >/dev/null; then echo "still running: pgrep -af ops.mjs" >&2; exit 1; fi
    say "Stopped"
    ;;
  log)
    if pgrep -f 'node network/threshold/ops/[o]ps.mjs' >/dev/null; then say "A run is going"; else say "Nothing is running"; fi
    if [ -f "$DATA/run.log" ]; then tail -n "${2:-40}" "$DATA/run.log"; else echo "no background run has been started yet"; fi
    ;;
  team-setup)
    mkdir -p "$TEAM" && chmod 700 "$TEAM"
    for m in $MEMBERS; do
      say "$m"
      out=$(node network/threshold/ops/operator.mjs init --home "$TEAM/$m" --key "$DATA/$m.secret" --proof-server-port "$PORT")
      echo "$out" | grep -E 'operator id|wallet address'
      addr=$(echo "$out" | sed -nE 's/.*wallet address: +(mn_addr[a-z0-9_]+).*/\1/p')
      [ -n "$addr" ] || { echo "$out" >&2; echo "no wallet address for $m" >&2; exit 1; }
      # Each wallet is funded once: run again, this sends only to those it hasn't yet.
      if [ -f "$TEAM/$m/.funded" ]; then echo "   funded already ($(cat "$TEAM/$m/.funded"))"; continue; fi
      sent=$(bash "$0" do "send:$addr:${2:-150}" 2>&1 || true)
      echo "$sent" | grep -E 'sent to|stopped|FAIL' || true
      if echo "$sent" | grep -q 'sent to'; then echo "${2:-150} tNIGHT, $(date -u '+%Y-%m-%d %H:%M') UTC" > "$TEAM/$m/.funded"; else echo "$sent" | grep -vE 'RPC-CORE' | tail -n 12 >&2; echo "sending to $m didn't go through (above: the end of what it said): run team-setup again" >&2; exit 1; fi
    done
    ;;
  team-start)
    if pgrep -f 'tnet-team-loop' >/dev/null; then echo "the team is running already: bash network/threshold/vm/tnet.sh team-log" >&2; exit 1; fi
    if pgrep -f 'node network/threshold/ops/[o]ps.mjs' >/dev/null; then echo "a tnet.sh run is going: it acts for the same seats. Wait for it (bash network/threshold/vm/tnet.sh log)" >&2; exit 1; fi
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "the proof server on $PORT isn't answering: systemctl start nightcast-net-proof, wait a minute, and try again" >&2; exit 1; }
    for m in $MEMBERS; do
      [ -f "$TEAM/$m/config.json" ] || { echo "$m has no folder yet: bash network/threshold/vm/tnet.sh team-setup" >&2; exit 1; }
      echo "==== $(date -u '+%Y-%m-%d %H:%M:%S') UTC: started" >> "$TEAM/$m.log"
      # Started again whenever it ends other than when stopped: code 75 (it stalled) at once, anything else after a minute.
      NIGHTCAST_PROOF_LOCK="$TEAM/.proof.lock" nohup bash -c 'for n in $(seq 1 50); do node network/threshold/ops/operator.mjs run --home "$1" --every 120 --claim-at 0.05; code=$?; [ "$code" = 0 ] && exit 0; echo "== ended with code $code: starting again (start $((n + 1)) of 50)"; [ "$code" = 75 ] && sleep 20 || sleep 60; done' tnet-team-loop "$TEAM/$m" >> "$TEAM/$m.log" 2>&1 < /dev/null &
    done
    sleep 5
    say "Started in the background: $MEMBERS. Look at them with: bash network/threshold/vm/tnet.sh team-log"
    ;;
  team-stop)
    pkill -f 'tnet-team-loop' || true
    pkill -f "operator[.]mjs run --home $TEAM/" || true
    sleep 3
    if pgrep -f "operator[.]mjs run --home $TEAM/" >/dev/null; then echo "still running: pgrep -af operator.mjs" >&2; exit 1; fi
    say "Stopped"
    ;;
  team-log)
    for m in $MEMBERS; do
      if pgrep -f "operator[.]mjs run --home $TEAM/$m\b" >/dev/null; then say "$m: running"; else say "$m: not running"; fi
      [ -f "$TEAM/$m.log" ] && tail -n "${2:-8}" "$TEAM/$m.log"
    done
    ;;
  team-status)
    for m in $MEMBERS; do say "$m"; node network/threshold/ops/operator.mjs status --home "$TEAM/$m" | grep -vE '^\[|RPC-CORE|[0-9] (contract|wallet) ' || true; done
    ;;
  *) sed -n 2,47p "$0"; exit 2 ;;
esac
