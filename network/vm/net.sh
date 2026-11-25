#!/usr/bin/env bash
# The five-operator Nightcast network test on the VM, kept apart from everything live:
# its own checkout (/root/Nightcast-net), its own proof server (127.0.0.1:6304), its own contract,
# wallets and keys (/root/nightcast-net). LunaSpin's /root/Nightcast and Starfall are not touched.
#
#   bash net.sh install            check out (or update) the branch, build, install the services, start the proof server
#   bash net.sh wallets            make the operators' and the requester's wallets; prints their addresses to fund
#   bash net.sh sync               sync both wallets and register their NIGHT for DUST (about an hour the first time)
#   bash net.sh deploy             deploy the contract (locked) and check it
#   bash net.sh operators [5]      make the operator keys and register them (bond: BOND slots each, default 20)
#   bash net.sh start | stop       the operators and the requester services
#   bash net.sh wallets5           a wallet of its own for each operator (op-N): prints their addresses to fund
#   bash net.sh sync5 | synced     sync those wallets in the background (two at a time) / how far they've got
#   bash net.sh start5             each operator in its own process with its own wallet (nightcast-net-operator@N),
#                                  and a fresh requester log (the last one is kept as requests-<time>.jsonl)
#   bash net.sh status             operators, bonds, requests, and the requester's report
#   bash net.sh pause N | resume N operator op-N stops / starts answering (the others carry on)
#   bash net.sh leave N            op-N takes its bond back and leaves
#   bash net.sh add                a sixth operator key, registered
#   bash net.sh logs               the last lines of both services
set -euo pipefail

REPO=/root/Nightcast-net
BRANCH="${BRANCH:-operator-network}"
DATA=/root/nightcast-net
COMPACTC="${COMPACTC:-/root/compactc-0.36/compactc}"
PORT=6304
BOND="${BOND:-20}"
OPS="$DATA/operators"
OPW="$DATA/operators-wallet.secret"
OWD="$DATA/wallets"
REQW="$DATA/requester-wallet.secret"
say() { echo "== $*"; }
node_net() { (cd "$REPO" && node "network/ops/$1" "${@:2}" --proof-server-port "$PORT"); }

case "${1:-}" in
  install)
    mkdir -p "$DATA" && chmod 700 "$DATA"
    if [ ! -d "$REPO/.git" ]; then git clone -q https://github.com/LearnMidnight/Nightcast "$REPO"; fi
    cd "$REPO"
    git fetch -q origin "$BRANCH" && git checkout -q -B "$BRANCH" "origin/$BRANCH"
    say "At $(git log --oneline -1)"
    # The v1 contract's compiled output isn't in git: take the live checkout's (the same v1 source).
    [ -d contract/src/managed ] || cp -r /root/Nightcast/contract/src/managed contract/src/
    find . -name node_modules -type d -prune -exec rm -rf {} +
    npm ci --no-audit --no-fund
    npm run build -w @nightcast/contract && npm run build -w @nightcast/sdk && npm run build -w @nightcast/deploy
    (cd network && npm install --no-audit --no-fund)
    [ -x "$COMPACTC" ] || { echo "no Compact 0.36 at $COMPACTC (set COMPACTC)" >&2; exit 1; }
    COMPACTC="$COMPACTC" bash network/build.sh
    say "In-memory checks"
    COMPACTC="$COMPACTC" bash network/check/run.sh | tail -8
    node network/ops/deploy.mjs offline | tail -3
    for u in nightcast-net-proof nightcast-net-operators nightcast-net-requester; do
      install -m 644 "network/vm/$u.service" "/etc/systemd/system/$u.service"
    done
    systemctl daemon-reload
    systemctl enable --now nightcast-net-proof
    sleep 20
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && say "Proof server answering on $PORT" || echo "the proof server on $PORT isn't answering yet (it may still be starting): systemctl status nightcast-net-proof"
    ;;
  wallets)
    mkdir -p "$DATA" && chmod 700 "$DATA"
    for w in "$OPW" "$REQW"; do [ -f "$w" ] || "$REPO/nightcast" wallet new --out "$w" >/dev/null; done
    say "Fund these two wallets with tNIGHT (from your wallet or the faucet https://midnight-tmnight-preprod.nethermind.dev/):"
    (cd "$REPO/deploy" && node -e "
      const { walletAddressOf } = await import('./dist/index.js');
      const fs = await import('node:fs');
      for (const [name, f, amount] of [['operators', '$OPW', 300], ['requester', '$REQW', 200]]) {
        console.log(name.padEnd(10), amount + ' tNIGHT ', walletAddressOf('preprod', JSON.parse(fs.readFileSync(f, 'utf8')).seed));
      }" --input-type=module)
    ;;
  sync)
    say "Syncing both wallets (a new wallet: DUST from the ledger 9 start, then shielded from the start; about an hour)"
    "$REPO/nightcast" wallet show --network preprod --wallet "$OPW" --proof-server-port "$PORT" > "$DATA/sync-operators.log" 2>&1 &
    a=$!
    "$REPO/nightcast" wallet show --network preprod --wallet "$REQW" --proof-server-port "$PORT" > "$DATA/sync-requester.log" 2>&1 &
    b=$!
    wait $a; ra=$?; wait $b; rb=$?
    tail -3 "$DATA/sync-operators.log"; tail -3 "$DATA/sync-requester.log"
    [ $ra -eq 0 ] && [ $rb -eq 0 ] && say "Both synced" || { echo "a sync failed: see $DATA/sync-*.log" >&2; exit 1; }
    ;;
  deploy)
    node_net deploy.mjs deploy --wallet "$REQW" --fee "${FEE:-0.1}" --collateral "${COLLATERAL:-1}" --min-bond "${MIN_BOND:-10}"
    ;;
  operators)
    (cd "$REPO" && node network/ops/operators.mjs keys --dir "$OPS" --count "${2:-5}")
    node_net operators.mjs register --dir "$OPS" --wallet "$OPW" --bond "$BOND"
    ;;
  start) systemctl start nightcast-net-operators && sleep 5 && systemctl start nightcast-net-requester && say "started" ;;
  stop) systemctl stop nightcast-net-requester nightcast-net-operators 'nightcast-net-operator@*' && say "stopped" ;;
  wallets5)
    mkdir -p "$OWD" && chmod 700 "$OWD"
    for k in "$OPS"/op-*.secret; do
      n=$(basename "$k" .secret)
      [ -f "$OWD/$n.secret" ] || "$REPO/nightcast" wallet new --out "$OWD/$n.secret" >/dev/null
    done
    say "Fund each with about ${EACH:-40} tNIGHT (its own NIGHT makes the DUST that pays its fees):"
    (cd "$REPO/deploy" && node -e "
      const { walletAddressOf } = await import('./dist/index.js');
      const fs = await import('node:fs');
      for (const f of fs.readdirSync('$OWD').filter((x) => /^op-[0-9]+\.secret$/.test(x)).sort((a, b) => parseInt(a.slice(3)) - parseInt(b.slice(3)))) {
        console.log(f.replace('.secret', '').padEnd(6), walletAddressOf('preprod', JSON.parse(fs.readFileSync('$OWD/' + f, 'utf8')).seed));
      }" --input-type=module)
    ;;
  sync5)
    # In the background (an ssh session ending doesn't stop it), two at a time to spare memory and Blockfrost.
    nohup bash "$0" _sync5 >/dev/null 2>&1 &
    say "Syncing in the background; check with: bash net.sh synced"
    ;;
  _sync5)
    ls "$OWD"/op-*.secret | sort -V | xargs -P 2 -I{} bash "$0" _sync1 {}
    ;;
  _sync1)
    n=$(basename "$2" .secret)
    rm -f "$DATA/sync-$n.done"
    set +e
    "$REPO/nightcast" wallet show --network preprod --wallet "$2" --proof-server-port "$PORT" > "$DATA/sync-$n.log" 2>&1
    echo $? > "$DATA/sync-$n.done"
    ;;
  synced)
    for k in "$OWD"/op-*.secret; do
      n=$(basename "$k" .secret)
      if [ -f "$DATA/sync-$n.done" ]; then st="done (exit $(cat "$DATA/sync-$n.done"))"; else st="syncing"; fi
      printf '%-5s %s  %s\n' "$n" "$st" "$(grep -E 'NIGHT|DUST' "$DATA/sync-$n.log" 2>/dev/null | tail -1 | cut -c1-110)"
    done
    ;;
  start5)
    install -m 644 "$REPO/network/vm/nightcast-net-operator@.service" /etc/systemd/system/nightcast-net-operator@.service
    install -m 644 "$REPO/network/vm/nightcast-net-requester.service" /etc/systemd/system/nightcast-net-requester.service
    systemctl daemon-reload
    systemctl stop nightcast-net-requester nightcast-net-operators 'nightcast-net-operator@*' 2>/dev/null || true
    [ -f "$DATA/requests.jsonl" ] && mv "$DATA/requests.jsonl" "$DATA/requests-$(date -u +%Y%m%dT%H%M).jsonl"
    for k in "$OPS"/op-*.secret; do
      n=$(basename "$k" .secret); i=${n#op-}
      [ -f "$OWD/$n.secret" ] || { echo "no wallet for $n in $OWD (run wallets5)" >&2; exit 1; }
      systemctl start "nightcast-net-operator@$i"
    done
    sleep 5 && systemctl start nightcast-net-requester && say "started: $(ls "$OPS"/op-*.secret | wc -l) operators, each with its own wallet"
    ;;
  status)
    node_net operators.mjs status --dir "$OPS" --wallet "$OPW" 2>&1 | grep -E "^[0-9:]{8} " || true
    (cd "$REPO" && node network/ops/requester.mjs report --log "$DATA/requests.jsonl")
    ;;
  pause) touch "$OPS/op-$2.pause" && say "op-$2 paused" ;;
  resume) rm -f "$OPS/op-$2.pause" && say "op-$2 answering again" ;;
  leave) node_net operators.mjs leave --dir "$OPS" --wallet "$OPW" --key "op-$2" ;;
  add)
    n=$(( $(ls "$OPS"/op-*.secret | wc -l) + 1 ))
    (cd "$REPO" && node network/ops/operators.mjs keys --dir "$OPS" --count "$n")
    if [ -d "$OWD" ]; then
      # One process per operator: the new one pays its fees from the shared operators wallet (funded, synced, idle now).
      node_net operators.mjs register --dir "$OPS" --wallet "$OPW" --bond "$BOND"
      ln -sf "$OPW" "$OWD/op-$n.secret"
      systemctl start "nightcast-net-operator@$n" && say "op-$n running with the operators wallet"
    else
      systemctl stop nightcast-net-operators
      node_net operators.mjs register --dir "$OPS" --wallet "$OPW" --bond "$BOND"
      systemctl start nightcast-net-operators
    fi
    ;;
  logs) journalctl -u nightcast-net-operators -u 'nightcast-net-operator@*' -u nightcast-net-requester --since "-30 min" --no-pager -o cat | tail -40 ;;
  *) sed -n 2,20p "$0"; exit 2 ;;
esac
