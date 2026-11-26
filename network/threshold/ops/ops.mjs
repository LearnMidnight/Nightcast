#!/usr/bin/env node
/**
 * Calls on a deployed threshold network contract, one after another from one wallet, each one
 * timed: how long its proof took and how long until the chain had it. For the first runs with
 * real proofs; an operator's own software comes later.
 *
 *   node network/threshold/ops/ops.mjs status
 *       What the chain shows (no wallet): the pool list, the operators, the ring, the epochs.
 *   node network/threshold/ops/ops.mjs do --wallet <file> --dir <keys dir> [--log <file>] <action> ...
 *       The actions, in order; it stops at the first that fails.
 *         load-pools                  load the batches of <dir>/pool-list.json not loaded yet
 *         register:<key>[:<slots>]    register:house-1, register:op-1:12 (12 slots by default; a
 *                                     key that left rejoins with the bond it has)
 *         link:<key>:<pool>           link:op-1:pool-1: the test pool's key signs for the
 *                                     operator, and the operator brings the signature
 *         leave:<key>
 *         open                        open the next epoch's committee
 *         seat                        fill its seats (nobody chooses who: the ring, then the house)
 *         deal[:<key>]                the ceremony for one seat, or for every seat whose key is in
 *                                     <dir>: its commitments, then a share for each seat. The
 *                                     polynomial is kept in <dir>/epoch-<e>-<key>.poly.secret, so
 *                                     a run that stops can go on where it stopped.
 *         finish                      end the ceremony; every key in <dir> then opens its share
 *                                     from the chain and checks it against its share key
 *         request[:<tag>]             ask the serving committee for a value (pays the fee)
 *         answer[:<key>]              one seat's answer to the last request made here, or every
 *                                     seat's whose key is in <dir>
 *         finalise                    combine the answers into the value (paid the bounty)
 *         settle                      after the deadline: share out the fee, or void the request
 *         claim:<key>                 an operator collects what it earned
 *         topup:<key>:<slots>         add bond to an operator (anyone may; paid from the wallet)
 *         standdown:<key>             stand down an active operator whose bond is below the minimum
 *                                     (anyone may)
 *         withdraw:<key>:<slots>      an operator takes bond back to its payout address (all of it: all)
 *         recommend:<key>[:<address>] the operator's seat in the serving committee names a successor
 *                                     contract (a fixed test address by default): two-thirds of the
 *                                     seats, in two epochs in a row, record it
 *         spends:<n>                  pay the fees of the calls after it with n DUST coins (1 to 4)
 *         coins[:<n>]                 give the wallet n DUST coins to pay fees with (as many as
 *                                     --dust-spends by default): its NIGHT is split into n UTXOs
 *                                     (sent to its own address) and each is registered for DUST
 *       Bonds and fees are paid from the wallet, and fees, bounties and bonds come back to it.
 *   Both: [--network preprod] [--proof-server-port 6304]
 *
 * Every fee is paid with --dust-spends DUST coins (3 by default, 4 at most; 1: as the wallet
 * chooses). Ledger 9 allows a transaction 2 microseconds of checking for each of its bytes, and a
 * call with one DUST spend can come out over that (node error 1010, custom error 231: openEpoch
 * did on 24 Nov 2026, by 2.8 ms). Each further spend adds about 3 KB, so 6 ms of allowance, for
 * 2.7 ms of checking. The option is deploy/scripts/patch-dust-two-spends.mjs's; a call isn't
 * sent while the wallet has fewer coins free than that. A transaction the node refuses is saved,
 * serialized, as <dir>/refused-<circuit>-<time>.tx (hex), with what was reported about it.
 * DUST builds up from the wallet's NIGHT (5 DUST for each NIGHT over a week), and a run of calls
 * can spend it faster than that: a call waits (--dust-wait minutes at most, 120 by default) until
 * the wallet holds about what the last one paid. NIGHT that arrives meanwhile is registered.
 * A wallet that loses its connection to the network may never report itself in step again, and
 * whatever waits on it then waits for ever (twice on 24 Nov 2026). So a run that shows no sign
 * of life for --stall minutes (10 by default) ends with exit code 75, to be started again: it
 * goes on from what the chain shows. `tnet.sh bg` does that by itself.
 *
 * A circuit that takes the time is given "now" a little ahead (--lead 60 seconds; --lead-link 240
 * for linkPool, whose proof is the largest), because its proof has to be made before it is sent.
 * The contract accepts a "now" within its slack of the block's time.
 * With --proof-container <docker name> the proof server's memory is sampled during each call and
 * its peak reported. Each transaction's size, its DUST spends, how much of the call the chain
 * runs before taking the fee (the guaranteed part: that and the proofs are what the allowance is
 * for) and its price are reported and logged too.
 */
import { execFile } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ContractState, LedgerParameters, Transaction, unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { ecMul, ecMulGenerator, encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
import { filter, firstValueFrom } from 'rxjs';
import { TX_TTL_SECONDS, blockfrostProjectId, connect, walletBalances } from '@nightcast/deploy';
import {
  R, T, ed25519Point, errorText, fromHex, hex, ledgerOf, operatorFrom, poolIdOf, poolList, poolSign, randomScalar, readJson, readRecord, say, sleep, succeeded, tn,
  withChain, writeSecret,
} from './common.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wallet: { type: 'string' }, dir: { type: 'string' }, log: { type: 'string' }, network: { type: 'string', default: 'preprod' }, 'proof-server-port': { type: 'string', default: '6304' },
    lead: { type: 'string', default: '60' }, 'lead-link': { type: 'string', default: '240' }, 'proof-container': { type: 'string' },
    'dust-spends': { type: 'string', default: '3' }, 'dust-wait': { type: 'string', default: '120' }, stall: { type: 'string', default: '10' },
  },
});
const mode = positionals[0];
const record = readRecord(values.network);
const address = record.contractAddress;
const short = (b) => hex(b).slice(0, 12);
const isZero = (b) => /^0+$/.test(hex(b));
/** The occupied place in the ring just before `place` (0: none). */
const priorOf = (l, place) => { let best = 0n; for (const [p] of l.ringOp) if (p < place && p > best) best = p; return best; };
const phaseName = (p) => Object.keys(T.Phase).find((k) => T.Phase[k] === p) ?? String(p);
/** The proof system's field: a parcel's share and pad are added in it. */
const FP = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const modn = (v, m) => ((v % m) + m) % m;
const seatKeyOf = (e, i) => T.pureCircuits.seatKey(e, BigInt(i));
const cellKeyOf = (e, d, i) => T.pureCircuits.cellKey(e, BigInt(d), BigInt(i));
const clock = (seconds) => new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
const samePoint = (p, q) => p.x === q.x && p.y === q.y;
/** Position i's share of epoch e's key: its parcels from the finished dealers, opened with its operator secret and added up; checked against its share key on chain. */
const shareOf = (l, e, i, secret) => {
  const c = l.committees.lookup(e);
  let sk = 0n;
  for (let d = 1; d <= Number(c.n); d++) {
    if (!l.finished.member(seatKeyOf(e, d))) continue;
    const parcel = l.parcels.lookup(cellKeyOf(e, d, i));
    sk += modn(modn(parcel.c - T.pureCircuits.padOf(ecMul(parcel.r, secret), e, BigInt(d), BigInt(i)), FP), R);
  }
  sk = modn(sk, R);
  const A = [0, 1, 2, 3].map((k) => l.aggregate.lookup(seatKeyOf(e, k)));
  if (!samePoint(ecMulGenerator(sk), T.pureCircuits.evalCommitments(A[0], A[1], A[2], A[3], BigInt(i)))) throw new Error(`the share opened for position ${i} of epoch ${e} doesn't match its share key on chain`);
  return sk;
};

/** Specks as DUST (10^15 specks each). */
const dustText = (specks) => (Number(specks) / 1e15).toLocaleString('en', { maximumFractionDigits: 3 });
/** Picoseconds (the ledger's unit of time) as milliseconds. */
const msOf = (ps) => Math.round(Number(ps) / 1e6) / 1e3;
const timeOf = (cost) => (cost.computeTime > cost.readTime ? cost.computeTime : cost.readTime);
/**
 * What a transaction about to be sent looks like to the ledger's limits: its size, its DUST
 * spends, how many of the call's steps run before the fee is taken (guaranteed) and after
 * (fallible), and its price. Whatever can't be read is left out: this never stops a call.
 */
const describeTx = (handle) => {
  const d = {};
  try { d.bytes = handle.serialize().length; } catch { /* left out */ }
  // Midnight.js hands transactions on as their bytes: decode them with this ledger.
  let tx = handle;
  try { if (typeof handle.deserialize === 'function') tx = handle.deserialize({ v9: Transaction }); } catch { return d; }
  try {
    let spends = 0, g = 0, f = 0, gPs = 0n, fPs = 0n, fee = 0n;
    if (!tx.intents) throw new Error('not a decoded transaction');
    for (const intent of tx.intents.values()) {
      spends += intent.dustActions?.spends?.length ?? 0;
      for (const spend of intent.dustActions?.spends ?? []) fee += spend.vFee;
      for (const action of intent.actions ?? []) {
        const gt = action.guaranteedTranscript, ft = action.fallibleTranscript;
        if (gt) { g += gt.program?.length ?? 0; if (gt.gas) gPs += timeOf(gt.gas); }
        if (ft) { f += ft.program?.length ?? 0; if (ft.gas) fPs += timeOf(ft.gas); }
      }
    }
    Object.assign(d, { dustSpends: spends, feeSpecks: fee.toString(), feeDust: Number(fee) / 1e15, guaranteedSteps: g, guaranteedMs: msOf(gPs), fallibleSteps: f, fallibleMs: msOf(fPs) });
  } catch { /* left out */ }
  const p = LedgerParameters.initialParameters();
  try {
    const c = tx.cost(p);
    d.pricedMs = msOf(timeOf(c));
    d.cost = { computeMs: msOf(c.computeTime), readMs: msOf(c.readTime), blockUsage: Number(c.blockUsage), bytesWritten: Number(c.bytesWritten), bytesChurned: Number(c.bytesChurned) };
  } catch { /* left out */ }
  if (d.bytes !== undefined) d.allowedMs = Math.max(15, Math.round(d.bytes * 2) / 1000);
  // The ledger's own check, as the node makes it: it says by how much when it fails.
  try { tx.cost(p, true); d.dismiss = 'ok'; } catch (e) {
    const text = errorText(e);
    const m = /would take ([\d.]+)\s*ms to dismiss/.exec(text);
    d.dismiss = /dismiss/i.test(text) ? 'over' : 'unknown';
    if (m) d.dismissMs = Number(m[1]);
    if (!m) d.dismissError = text.slice(0, 200);
  }
  return d;
};
const txText = (d) => {
  if (!d) return '';
  const parts = [];
  if (d.bytes !== undefined) parts.push(`${d.bytes.toLocaleString('en')} bytes`);
  if (d.dustSpends !== undefined) parts.push(`${d.dustSpends} DUST spend${d.dustSpends === 1 ? '' : 's'}${d.feeDust ? ` paying ${dustText(d.feeSpecks)} DUST` : ''}`);
  if (d.guaranteedSteps !== undefined) parts.push(`${d.guaranteedSteps} steps before the fee (${d.guaranteedMs} ms) and ${d.fallibleSteps} after (${d.fallibleMs} ms)`);
  if (d.pricedMs !== undefined) parts.push(`priced at ${d.pricedMs} ms in all`);
  if (d.dismiss === 'over') parts.push(`OVER its allowance: ${d.dismissMs ?? '?'} ms to dismiss, ${d.allowedMs} ms allowed`);
  else if (d.allowedMs !== undefined) parts.push(`${d.allowedMs} ms allowed to dismiss${d.dismiss === 'ok' ? ': within it' : ''}`);
  return parts.length ? `; the transaction: ${parts.join(', ')}` : '';
};

const status = (l) => {
  say(`contract ${address}`);
  say(`pool list: ${l.poolCount} places loaded${isZero(l.poolsNext) ? ', complete' : ', more to load'}`);
  say(`epochs: serving ${l.current}, newest opened ${l.opened}${l.opened > 0n ? ` (${phaseName(l.committees.lookup(l.opened).phase)})` : ''}`);
  if (l.opened > 0n) {
    const c = l.committees.lookup(l.opened);
    say(`  epoch ${l.opened}: ${c.t} of ${c.n}, ${c.indepSeats} seats for independents; ${c.seated} seated, ${c.dealt} dealers finished${c.phase === T.Phase.serving ? `; serving since ${clock(c.since)}` : c.phase === T.Phase.failed ? '' : `; deadline ${clock(c.dealBy)}`}`);
    for (let i = 1; i <= Number(c.seated); i++) {
      const sk = seatKeyOf(l.opened, i);
      const m = l.missed.member(sk) ? Number(l.missed.lookup(sk)) : 0;
      say(`    position ${i}: ${short(l.members.lookup(sk))}${m ? `  missed ${m} answering time${m === 1 ? '' : 's'}` : ''}`);
    }
  }
  say(`operators: ${l.houseActive} house active, ${l.independents} independent in the ring${l.independents > 0n ? ` (places ${[...l.ringOp].map(([p]) => p).sort((a, b) => (a < b ? -1 : 1)).join(', ')}; last seated ${l.cursor})` : ''}`);
  for (const [id, o] of l.operators) {
    const place = l.poolOf.member(id) ? `pool place ${l.listed.lookup(l.poolOf.lookup(id))}` : o.house ? 'house' : 'no pool';
    say(`  ${short(id)}  ${o.active ? 'active' : 'left  '}  bond ${l.bonds.lookup(id).read()} slots  ${place}`);
  }
  say(`requests made: ${l.nextRequest}; forfeited bond: ${l.forfeited} slots`);
  if (l.backedEpoch > 0n) say(`recommended successor: ${isZero(l.successor) ? 'none yet' : `${hex(l.successor)} (since epoch ${l.successorEpoch})`}; epoch ${l.backedEpoch} backs ${hex(l.backed).slice(0, 12)}`);
};

if (mode === 'status') {
  const session = await connect(values.network, { proofServerPort: Number(values['proof-server-port']), projectId: blockfrostProjectId(values.network), waitForBlockfrost: true });
  try {
    const r = await indexerPublicDataProvider(session.config.indexer, session.config.indexerWS).queryContractState(address);
    if (!r) throw new Error(`the indexer shows no contract at ${address}`);
    status(ledgerOf((r.contractState ?? r).deserialize({ v9: ContractState })));
  } finally {
    await session.shutdown().catch(() => undefined);
  }
} else if (mode === 'do') {
  if (!values.wallet || !values.dir) throw new Error('--wallet <file> and --dir <keys dir> are required');
  const actions = positionals.slice(1);
  if (!actions.length) throw new Error('no actions given');
  const dir = values.dir;
  const log = (row) => {
    if (!values.log) return;
    mkdirSync(dirname(values.log), { recursive: true });
    appendFileSync(values.log, JSON.stringify(row) + '\n');
  };
  // Signs of life: every look at the chain or the wallet that came back, and every proof asked for or made.
  let lastSign = Date.now();
  const alive = () => { lastSign = Date.now(); };
  const stallMs = Math.max(3, Number(values.stall) || 10) * 60_000;
  // How many DUST coins pay each fee (the dust wallet reads this when it balances a transaction).
  let wantSpends;
  /** How many DUST coins pay the fees from here on (read by the patched dust wallet each time it balances). */
  const setSpends = (n) => {
    wantSpends = Math.max(1, Math.min(4, Math.floor(Number(n)) || 1));
    if (wantSpends > 1) process.env.NIGHTCAST_DUST_MIN_SPENDS = String(wantSpends);
    else delete process.env.NIGHTCAST_DUST_MIN_SPENDS;
  };
  setSpends(values['dust-spends']);
  try {
  await withChain({ network: values.network, proofServerPort: Number(values['proof-server-port']), walletFile: values.wallet, address }, async ({ session, wallet, providers, read: readChain, handle, me, meBytes }) => {
    // Watched from here on, with the wallet open (its first sync can take minutes and says so itself).
    alive();
    setInterval(() => {
      if (Date.now() - lastSign < stallMs) return;
      say(`stalled: no sign of life for ${Math.round(stallMs / 60_000)} minutes (the wallet has probably lost the network). Stopping, to be started again: it goes on from what the chain shows`);
      process.exit(75);
    }, 30_000).unref();
    const read = async (...a) => { const l = await readChain(...a); alive(); return l; };
    // Look at each transaction as it is sent.
    let lastTx, lastHandle;
    const sender = providers.midnightProvider;
    providers.midnightProvider = new Proxy(sender, {
      get: (t, k) => {
        const v = t[k];
        if (typeof v !== 'function') return v;
        if (k !== 'submitTx') return v.bind(t);
        return async (tx, ...rest) => { lastHandle = tx; lastTx = describeTx(tx); alive(); try { return await v.call(t, tx, ...rest); } finally { alive(); } };
      },
    });
    const syncedState = () => firstValueFrom(wallet.wallet.state().pipe(filter((s) => s.isSynced)));
    /** The wallet's NIGHT UTXOs (and how many generate DUST) and its DUST coins: free to pay with, and booked by a transaction that hasn't landed. */
    const coinsNow = async () => {
      const c = { ...(await walletBalances(wallet)), booked: (await syncedState()).dust.pendingCoins.length };
      alive();
      return c;
    };
    const coinsText = (c) => `${tn(c.night)} in ${c.nightUtxos} NIGHT UTXO${c.nightUtxos === 1 ? '' : 's'} (${c.nightRegistered} generating DUST); ${dustText(c.dust)} DUST in ${c.dustCoins} coin${c.dustCoins === 1 ? '' : 's'} free to pay with${c.booked ? `, ${c.booked} more booked by transactions that haven't landed` : ''}`;
    /** Register NIGHT that doesn't generate DUST yet (change, or NIGHT that has just arrived). */
    const registerNew = async () => {
      const raw = unshieldedToken().raw, ks = wallet.unshieldedKeystore;
      const coins = (await syncedState()).unshielded.availableCoins.filter((x) => x.utxo.type === raw && x.meta.registeredForDustGeneration === false);
      if (!coins.length) return;
      const recipe = await wallet.wallet.registerNightUtxosForDustGeneration(coins, ks.getPublicKey(), (payload) => ks.signDataAsync(payload));
      const txId = await wallet.wallet.submitTransaction(await wallet.wallet.finalizeRecipe(recipe));
      say(`${coins.length} NIGHT UTXO${coins.length === 1 ? '' : 's'} registered to generate DUST, transaction ${txId}`);
    };
    /** Wait until `ok(coins)`, looking every 10 s. */
    const coinsUntil = async (ok, what, ms) => {
      const until = Date.now() + ms;
      for (;;) {
        const c = await coinsNow();
        if (ok(c)) return c;
        if (Date.now() > until) throw new Error(`${what} (the wallet: ${coinsText(c)})`);
        await sleep(10_000);
      }
    };
    /**
     * About what the next fee takes, in specks: a quarter more than the last one paid. Until one has been, 1.2 DUST:
     * a fee is mostly the transaction's size (10 DUST for a block's 200,000 bytes), and these are about 20,000 bytes.
     */
    let needDust = 1_200_000_000_000_000n;
    const dustWaitMs = Math.max(1, Number(values['dust-wait']) || 120) * 60_000;
    /**
     * Before a call: the coins its fee is to be paid with are free (the last transaction's come back once the wallet
     * has seen it land), and the wallet holds about a fee's worth of DUST. Waiting for DUST, it says so every 5 minutes.
     */
    const coinsReady = async (what) => {
      const started = Date.now();
      let told = 0, registered = 0;
      for (;;) {
        const c = await coinsNow();
        const enoughCoins = wantSpends < 2 || c.dustCoins >= wantSpends;
        if (enoughCoins && c.dust >= needDust) return;
        const waited = Date.now() - started;
        if (!enoughCoins && waited > 5 * 60_000) throw new Error(`${what} isn't sent: after 5 minutes the wallet still has fewer than ${wantSpends} DUST coins free (${coinsText(c)}). Make more with the coins action, or pass --dust-spends`);
        if (waited > dustWaitMs) throw new Error(`${what} isn't sent: after ${Math.round(dustWaitMs / 60_000)} minutes the wallet still has too little DUST (${coinsText(c)}; a fee takes about ${dustText(needDust)}). It needs more NIGHT, or more time`);
        if (enoughCoins && Date.now() - told > 5 * 60_000) {
          say(`waiting for DUST before ${what}: the wallet has ${dustText(c.dust)} and a fee takes about ${dustText(needDust)} (DUST builds up from the wallet's ${tn(c.night)})`);
          told = Date.now();
        }
        // NIGHT sent to the wallet meanwhile makes DUST only once it is registered.
        if (c.nightRegistered < c.nightUtxos && Date.now() - registered > 5 * 60_000) {
          registered = Date.now();
          await registerNew().catch((e) => say(`registering new NIGHT for DUST failed (trying again later): ${errorText(e).slice(0, 200)}`));
        }
        await sleep(15_000);
      }
    };
    // Time the proof server's part of each call.
    let proving = 0;
    const prover = providers.proofProvider;
    providers.proofProvider = new Proxy(prover, {
      get: (t, k) => {
        const v = t[k];
        if (typeof v !== 'function') return v;
        return async (...a) => { const s = Date.now(); alive(); try { return await v.apply(t, a); } finally { proving += Date.now() - s; alive(); } };
      },
    });
    const l0 = await read();
    const stamp = (lead) => BigInt(Math.floor(Date.now() / 1000) + lead);
    const lead = Number(values.lead), leadLink = Number(values['lead-link']);
    if (BigInt(Math.max(lead, leadLink)) >= l0.slack) throw new Error(`a lead of ${Math.max(lead, leadLink)} s is not inside the contract's slack of ${l0.slack} s`);
    say(`calling from ${me}; the contract's slack is ${l0.slack} s`);
    const c0 = await coinsNow();
    say(`the wallet: ${coinsText(c0)}; each fee is paid with ${wantSpends === 1 ? 'as few DUST coins as cover it' : `${wantSpends} DUST coins`}`);
    if (c0.dustCoins + c0.booked < wantSpends && !actions.some((x) => x.split(':')[0] === 'coins')) {
      throw new Error(`the wallet has ${c0.dustCoins + c0.booked} DUST coin(s) and each fee is to be paid with ${wantSpends}: make them first with the coins action (bash network/threshold/vm/tnet.sh coins)`);
    }
    const h = (k) => handle(`tnet-${k.name}`, { operatorSecret: k.secret, answerSecs: l0.answerSecs });
    const anyone = () => handle('tnet-anyone', { answerSecs: l0.answerSecs });
    const key = (name) => ({ ...operatorFrom(join(dir, `${name}.secret`)), name });
    /** The operator keys kept in <dir>, by id: who is who on the chain. */
    const known = new Map();
    for (const f of readdirSync(dir)) {
      if (!/^(house|op)-\d+\.secret$/.test(f)) continue;
      const name = f.replace(/\.secret$/, '');
      known.set(hex(operatorFrom(join(dir, f)).id), name);
    }
    const newest = (l) => { if (l.opened === 0n) throw new Error('no epoch has been opened yet'); return l.opened; };
    const seatedIn = (l, e) => Array.from({ length: Number(l.committees.lookup(e).seated) }, (_, k) => {
      const id = l.members.lookup(seatKeyOf(e, k + 1));
      return { position: k + 1, id, name: known.get(hex(id)) };
    });
    const positionOf = (l, e, id) => seatedIn(l, e).find((x) => hex(x.id) === hex(id))?.position ?? 0;
    const polynomialFile = (name, e) => join(dir, `epoch-${e}-${name}.poly.secret`);
    /** A dealer's polynomial for an epoch: made once and kept (mode 600), zeros past the threshold. */
    const polynomialFor = (name, e, t) => {
      const file = polynomialFile(name, e);
      if (!existsSync(file)) {
        writeSecret(file, { role: 'threshold-polynomial', operator: name, epoch: e.toString(), coefficients: Array.from({ length: 4 }, (_, k) => (k < t ? randomScalar() : 0n).toString(16).padStart(64, '0')) });
      }
      const p = readJson(file);
      if (p.role !== 'threshold-polynomial') throw new Error(`${file} is not a polynomial file`);
      return p.coefficients.map((c) => BigInt('0x' + c));
    };
    const lastRequest = () => {
      const file = join(dir, 'last-request');
      if (!existsSync(file)) throw new Error('no request has been made from here yet (request first)');
      return fromHex(readFileSync(file, 'utf8').trim());
    };
    /** Wait until the indexer shows what the transaction did. */
    const shown = async (ok, what, ms = 180_000) => {
      const until = Date.now() + ms;
      for (;;) {
        if (ok(await read())) return;
        if (Date.now() > until) throw new Error(`the chain did not show ${what} within ${ms / 1000} s`);
        await sleep(5_000);
      }
    };
    /** The proof server container's memory in MiB now ("6.2GiB / 23.4GiB" -> 6349), or undefined. */
    const memoryNow = () => new Promise((done) => {
      if (!values['proof-container']) return done(undefined);
      execFile('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', values['proof-container']], { timeout: 10_000 }, (err, out) => {
        const m = /^\s*([\d.]+)\s*(KiB|MiB|GiB|B)/.exec(String(out ?? ''));
        if (err || !m) return done(undefined);
        done(Math.round(Number(m[1]) * { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]]));
      });
    });
    /** One call: up to three tries when it fails for a reason that can pass; a contract assertion is final. */
    const call = async (what, circuit, f) => {
      for (let i = 1; ; i++) {
        proving = 0;
        const started = Date.now();
        let peak;
        let sampling = false;
        const sampler = setInterval(async () => {
          if (sampling) return;
          sampling = true;
          const m = await memoryNow();
          if (m !== undefined && (peak === undefined || m > peak)) peak = m;
          sampling = false;
        }, 5_000);
        const memory = () => (peak === undefined ? '' : `, proof server up to ${(peak / 1024).toFixed(1)} GiB`);
        lastTx = undefined;
        lastHandle = undefined;
        try {
          await coinsReady(what);
          const r = succeeded(await f(), what);
          clearInterval(sampler);
          const row = { time: new Date().toISOString(), what, circuit, ok: true, provingSeconds: Math.round(proving / 100) / 10, totalSeconds: Math.round((Date.now() - started) / 100) / 10, tries: i, peakProofServerMiB: peak, txId: r.public?.txId, tx: lastTx };
          log(row);
          say(`ok   ${what}: proof ${row.provingSeconds} s, ${row.totalSeconds} s in all${memory()}${i > 1 ? ` (try ${i})` : ''}, transaction ${row.txId}${txText(lastTx)}`);
          if (lastTx?.feeSpecks) needDust = (BigInt(lastTx.feeSpecks) * 5n) / 4n;
          return r;
        } catch (e) {
          clearInterval(sampler);
          const text = errorText(e);
          // A transaction the node refused: keep it, for whoever looks into why.
          let saved;
          if (lastHandle && /1010|Invalid Transaction|time to dismiss|Custom error/i.test(text)) {
            try {
              saved = join(values.dir, `refused-${circuit}-${new Date().toISOString().replace(/[:.]/g, '-')}.tx`);
              writeFileSync(saved, `${Buffer.from(lastHandle.serialize()).toString('hex')}\n`);
              writeFileSync(`${saved}.json`, `${JSON.stringify({ what, circuit, error: text, tx: lastTx, dustSpendsWanted: wantSpends }, null, 2)}\n`);
            } catch (err) { saved = undefined; say(`the refused transaction couldn't be saved: ${errorText(err).slice(0, 200)}`); }
          }
          log({ time: new Date().toISOString(), what, circuit, ok: false, provingSeconds: Math.round(proving / 100) / 10, totalSeconds: Math.round((Date.now() - started) / 100) / 10, tries: i, peakProofServerMiB: peak, error: text, tx: lastTx, saved });
          if (saved) say(`the refused transaction is saved: ${saved} (and .json)`);
          say(`FAIL ${what} (try ${i}; proof ${Math.round(proving / 1000)} s, ${Math.round((Date.now() - started) / 1000)} s in all${memory()}): ${text}${txText(lastTx)}`);
          // A proof server that failed is not asked again at once: it may have run out of memory. A
          // transaction over its time allowance would be built the same way again, and each try books DUST coins.
          if (i >= 3 || /failed assert|assertion failed|Proof Server request failed|isn't sent|time to dismiss|Custom error: 231/i.test(text)) throw e;
          // Out of DUST: the next try waits until the wallet holds more than it was thought to need.
          if (/insufficient\s*funds|could not balance dust/i.test(text)) {
            const have = (await coinsNow()).dust;
            const floor = needDust > have ? needDust : have;
            needDust = (floor * 3n) / 2n;
          }
          await sleep(20_000);
        }
      }
    };

    for (const action of actions) {
      const [verb, a, b] = action.split(':');
      if (verb === 'spends') {
        setSpends(a);
        say(`fees from here on: ${wantSpends === 1 ? 'one DUST coin' : `${wantSpends} DUST coins`}`);
      } else if (verb === 'coins') {
        const n = Math.max(1, Math.min(4, Math.floor(Number(a ?? wantSpends)) || 1));
        let c = await coinsNow();
        if (c.dustCoins >= n) { say(`the wallet has ${c.dustCoins} DUST coins free: nothing to make`); continue; }
        const w = wallet.wallet, ks = wallet.unshieldedKeystore, raw = unshieldedToken().raw;
        // A registered NIGHT UTXO has one DUST coin. Coins booked by a transaction that didn't land can stay booked
        // for hours, so UTXOs are made for n coins besides those.
        const utxos = Math.min(8, n + c.booked);
        if (c.nightUtxos < utxos) {
          // One transfer to this wallet's own address: `make` new UTXOs of a share each, and the rest comes back as change.
          const make = utxos - c.nightUtxos, each = c.night / BigInt(utxos);
          if (each < 1_000_000n) throw new Error(`too little NIGHT to split into ${utxos}: ${tn(c.night)}`);
          const to = MidnightBech32m.parse(me).decode(UnshieldedAddress, session.config.walletNetworkId);
          const recipe = await w.transferTransaction([{ type: 'unshielded', outputs: Array.from({ length: make }, () => ({ amount: each, receiverAddress: to, type: raw })) }], { ttl: new Date(Date.now() + TX_TTL_SECONDS * 1000) });
          const signed = await w.signRecipe(recipe, (payload) => ks.signDataAsync(payload));
          const txId = await w.submitTransaction(await w.finalizeRecipe(signed));
          say(`the wallet's NIGHT is being split: ${make} part${make === 1 ? '' : 's'} of ${tn(each)} sent to its own address, transaction ${txId}`);
          c = await coinsUntil((x) => x.nightUtxos >= utxos, `the split didn't show within 10 minutes`, 10 * 60_000);
        }
        if (c.nightRegistered < c.nightUtxos) await registerNew();
        c = await coinsUntil((x) => x.dustCoins >= n, `the new DUST coins didn't show within 15 minutes`, 15 * 60_000);
        say(`the wallet now: ${coinsText(c)}`);
      } else if (verb === 'load-pools') {
        const list = poolList(readJson(join(dir, 'pool-list.json')).pools.map((p) => p.public));
        if (hex(list.root) !== hex(l0.poolsRoot)) throw new Error(`${join(dir, 'pool-list.json')} is not the list this contract was deployed with`);
        for (;;) {
          const next = hex((await read()).poolsNext);
          if (/^0+$/.test(next)) { say('the pool list is fully loaded'); break; } // `next` is hex here
          const k = list.batches.findIndex((x) => hex(T.pureCircuits.poolBatchOf(x.ids, x.next)) === next);
          if (k < 0) throw new Error('the next batch the contract expects is not in this list');
          await call(`loadPools, batch ${k + 1} of ${list.batches.length}`, 'loadPools', async () => (await anyone()).callTx.loadPools(list.batches[k].ids, list.batches[k].next));
          await shown((l) => hex(l.poolsNext) !== next, `batch ${k + 1} loaded`);
        }
      } else if (verb === 'register') {
        const k = key(a);
        const l = await read();
        const known = l.operators.member(k.id);
        if (known && l.operators.lookup(k.id).active) { say(`${a} is already registered and active`); continue; }
        const slots = known ? 0n : BigInt(b ?? 12);
        const prior = l.poolOf.member(k.id) ? priorOf(l, l.listed.lookup(l.poolOf.lookup(k.id))) : 0n;
        await call(`register ${a}${known ? ' (again)' : ` with ${slots} slots (${tn(slots * l.collateralPerSlot)})`}`, 'register', async () => (await h(k)).callTx.register({ bytes: meBytes }, slots, prior));
        await shown((x) => x.operators.member(k.id) && x.operators.lookup(k.id).active, `${a} registered`);
      } else if (verb === 'link') {
        const k = key(a);
        const poolFile = join(dir, `${b}.secret`);
        const pub = readJson(poolFile).public;
        const pid = poolIdOf(pub);
        const l = await read();
        if (!l.listed.member(pid)) throw new Error(`${b} isn't on the loaded pool list (load-pools first)`);
        const count = l.poolLinks.member(pid) ? l.poolLinks.lookup(pid) : 0n;
        const place = l.listed.lookup(pid);
        const prior = priorOf(l, place);
        await call(`linkPool: ${a} behind ${b} (place ${place} in the list)`, 'linkPool', async () => {
          const at = stamp(leadLink);
          const until = at + 86_400n;
          const message = T.pureCircuits.linkMessageOf({ bytes: encodeContractAddress(address) }, k.id, count, false, until);
          return (await h(k)).callTx.linkPool(k.id, poolSign(poolFile, message), ed25519Point(fromHex(pub)), false, at, prior, until);
        });
        await shown((x) => x.poolOf.member(k.id), `${a} linked`);
      } else if (verb === 'leave') {
        const k = key(a);
        await call(`leave ${a}`, 'leave', async () => (await h(k)).callTx.leave(stamp(lead)));
        await shown((x) => !x.operators.lookup(k.id).active, `${a} left`);
      } else if (verb === 'open') {
        const lb = await read();
        const before = lb.opened;
        // A run that stopped goes on with the ceremony it left: only one can be running.
        const running = before !== lb.current ? lb.committees.lookup(before).phase : undefined;
        if (running === T.Phase.seating || running === T.Phase.dealing) { say(`epoch ${before} is already open (${phaseName(running)}): going on with it`); continue; }
        const r = await call('openEpoch', 'openEpoch', async () => (await anyone()).callTx.openEpoch(stamp(lead)));
        if (r.private?.result === 0n) { say('no committee of an allowed size can be made: nothing was opened'); continue; }
        await shown((x) => x.opened > before, 'the new epoch');
        const l = await read();
        const c = l.committees.lookup(l.opened);
        say(`epoch ${l.opened} is open: ${c.t} of ${c.n}, ${c.indepSeats} of its seats for independents; to be seated by ${clock(c.dealBy)}`);
      } else if (verb === 'seat') {
        for (let guard = 0; guard < 8; guard++) {
          const l = await read();
          const e = newest(l);
          const c = l.committees.lookup(e);
          if (c.phase !== T.Phase.seating) break;
          await call(`seat ${c.seated + 1n} of ${c.n} in epoch ${e}`, 'seat', async () => (await anyone()).callTx.seat(e, stamp(lead)));
          await shown((x) => x.committees.lookup(e).seated > c.seated, 'the seat taken');
        }
        const l = await read();
        const e = newest(l);
        say(`epoch ${e} is seated: ${seatedIn(l, e).map((x) => x.name ?? short(x.id)).join(', ')}; dealing until ${clock(l.committees.lookup(e).dealBy)}`);
      } else if (verb === 'deal') {
        const l = await read();
        const e = newest(l);
        const c = l.committees.lookup(e);
        if (c.phase !== T.Phase.dealing) throw new Error(`epoch ${e} isn't dealing (it is ${phaseName(c.phase)})`);
        const who = a ? [a] : seatedIn(l, e).filter((x) => x.name).map((x) => x.name);
        for (const name of who) {
          const k = key(name);
          const d = positionOf(l, e, k.id);
          if (!d) throw new Error(`${name} has no seat in epoch ${e}`);
          const poly = polynomialFor(name, e, Number(c.t));
          const hd = () => handle(`tnet-${name}-deal-${e}`, { operatorSecret: k.secret, coefficients: poly, answerSecs: l0.answerSecs });
          if (!(await read()).committed.member(seatKeyOf(e, d))) {
            await call(`dealCommit: ${name}, position ${d} of epoch ${e}`, 'dealCommit', async () => (await hd()).callTx.dealCommit(e, BigInt(d), poly.map((x) => ecMulGenerator(x))));
            await shown((x) => x.committed.member(seatKeyOf(e, d)), `${name}'s commitments`);
          }
          for (let i = 1; i <= Number(c.n); i++) {
            if ((await read()).parcels.member(cellKeyOf(e, d, i))) continue;
            await call(`dealShare: ${name} (position ${d}) to position ${i}`, 'dealShare', async () => (await hd()).callTx.dealShare(e, BigInt(d), BigInt(i)));
            await shown((x) => x.parcels.member(cellKeyOf(e, d, i)), `${name}'s parcel for position ${i}`);
          }
        }
        say(`epoch ${e}: ${(await read()).committees.lookup(e).dealt} of ${c.n} dealers have finished`);
      } else if (verb === 'finish') {
        const e = newest(await read());
        await call(`finish epoch ${e}`, 'finish', async () => (await anyone()).callTx.finish(e, stamp(lead)));
        await shown((x) => x.committees.lookup(e).phase === T.Phase.serving || x.committees.lookup(e).phase === T.Phase.failed, 'the ceremony ended');
        const l = await read();
        const c = l.committees.lookup(e);
        if (c.phase !== T.Phase.serving) { say(`epoch ${e}'s ceremony failed: ${c.dealt} dealers finished, ${c.t} were needed`); continue; }
        say(`epoch ${e} serves: ${c.t} of ${c.n}, from ${c.dealt} finished dealers`);
        for (const x of seatedIn(l, e).filter((y) => y.name)) {
          shareOf(l, e, x.position, key(x.name).secret);
          say(`  ${x.name} (position ${x.position}) opened its share from the chain: it matches its share key`);
        }
      } else if (verb === 'request') {
        const before = await read();
        const hr = await handle(`tnet-requester-${Date.now()}`, { requesterSecret: webcrypto.getRandomValues(new Uint8Array(32)), answerSecs: l0.answerSecs });
        const tag = new Uint8Array(32);
        tag.set(new TextEncoder().encode(String(a ?? 'test')).subarray(0, 32));
        await call(`request "${a ?? 'test'}" (fee ${tn(before.requestFee)})`, 'request', async () => hr.callTx.request(tag, stamp(lead), { bytes: meBytes }));
        await shown((x) => x.nextRequest > before.nextRequest, 'the request');
        const l = await read();
        let rid, q;
        for (const [id, x] of l.requests) if (!q || x.number > q.number) { rid = id; q = x; }
        writeFileSync(join(dir, 'last-request'), hex(rid) + '\n');
        say(`request ${hex(rid)}: number ${q.number}, for epoch ${q.epoch}'s committee, to be answered by ${clock(q.deadline)}`);
      } else if (verb === 'answer') {
        const rid = lastRequest();
        const l = await read();
        const q = l.requests.lookup(rid);
        const who = a ? [a] : seatedIn(l, q.epoch).filter((x) => x.name).map((x) => x.name);
        for (const name of who) {
          const k = key(name);
          const i = positionOf(l, q.epoch, k.id);
          if (!i) throw new Error(`${name} has no seat in epoch ${q.epoch}`);
          if ((await read()).shares.member(T.pureCircuits.shareKey(q.number, BigInt(i)))) { say(`${name} (position ${i}) has already answered`); continue; }
          const ha = await handle(`tnet-${name}-answer-${q.epoch}`, { operatorSecret: k.secret, shareSecret: shareOf(l, q.epoch, i, k.secret), answerSecs: l0.answerSecs });
          await call(`answer: ${name} (position ${i})`, 'answer', async () => ha.callTx.answer(rid, BigInt(i)));
          await shown((x) => x.shares.member(T.pureCircuits.shareKey(q.number, BigInt(i))), `${name}'s answer`);
        }
      } else if (verb === 'finalise') {
        const rid = lastRequest();
        const l = await read();
        const q = l.requests.lookup(rid);
        const c = l.committees.lookup(q.epoch);
        const have = [];
        for (let i = 1; i <= Number(c.n); i++) if (l.shares.member(T.pureCircuits.shareKey(q.number, BigInt(i)))) have.push(i);
        if (have.length < Number(c.t)) throw new Error(`only ${have.length} answers are in; ${c.t} are needed`);
        const positions = [...have.slice(0, Number(c.t)), 0, 0, 0, 0].slice(0, 4).map(BigInt);
        await call(`finalise with positions ${have.slice(0, Number(c.t)).join(', ')}`, 'finalise', async () => (await anyone()).callTx.finalise(rid, positions, { bytes: meBytes }));
        await shown((x) => x.requests.lookup(rid).status === T.Status.fulfilled, 'the value');
        const out = (await read()).requests.lookup(rid).output;
        say(`the random value: ${hex(out)}`);
        // Possible only because this test holds every dealer's polynomial: the value worked out off chain.
        const dealers = seatedIn(l, q.epoch).filter((x) => l.finished.member(seatKeyOf(q.epoch, x.position)));
        if (dealers.every((x) => x.name && existsSync(polynomialFile(x.name, q.epoch)))) {
          const groupSecret = modn(dealers.reduce((sum, x) => sum + polynomialFor(x.name, q.epoch, Number(c.t))[0], 0n), R);
          const expected = T.pureCircuits.outputOf(ecMul(q.point, modn(720n * groupSecret, R)));
          say(hex(expected) === hex(out) ? '  it is the value worked out off chain from the dealers\' polynomials (which only this test holds together)' : `  MISMATCH: off chain the value is ${hex(expected)}`);
          if (hex(expected) !== hex(out)) throw new Error('the value on chain is not the one worked out off chain');
        }
      } else if (verb === 'settle') {
        const rid = lastRequest();
        const lb = await read();
        const qb = lb.requests.lookup(rid);
        if (qb.settled) { say('the request is settled already'); continue; }
        // The contract refuses before the deadline by the block's clock: wait for it, and a minute more.
        const due = Number(qb.deadline) * 1000 + 60_000;
        if (Date.now() < due) {
          say(`waiting for the request's answer deadline, ${clock(qb.deadline)} (${Math.ceil((due - Date.now()) / 60_000)} minutes)`);
          while (Date.now() < due) { alive(); await sleep(Math.min(60_000, due - Date.now())); }
        }
        const seats = seatedIn(lb, qb.epoch).map((x) => ({ ...x, bond: lb.bonds.lookup(x.id).read(), answered: lb.timelyShares.member(T.pureCircuits.shareKey(qb.number, BigInt(x.position))) }));
        await call('settle', 'settle', async () => (await anyone()).callTx.settle(rid, { bytes: meBytes }));
        await shown((x) => x.requests.lookup(rid).settled, 'the request settled');
        const la = await read();
        const q = la.requests.lookup(rid);
        const answered = seats.filter((x) => x.answered).length;
        const c = la.committees.lookup(q.epoch);
        say(q.voided
          ? `the request is void: ${answered} of ${c.n} answered in time and ${c.t} are needed; its fee went back`
          : `the request is paid: its fee is shared by the ${answered} seats that answered in time`);
        for (const x of seats) {
          const sk = seatKeyOf(q.epoch, x.position);
          const m = la.missed.member(sk) ? Number(la.missed.lookup(sk)) : 0;
          const bond = la.bonds.lookup(x.id).read();
          say(`  position ${x.position} (${x.name ?? short(x.id)}): ${x.answered ? 'answered in time' : 'missed it'}; bond ${x.bond === bond ? `${bond} slots` : `${x.bond} -> ${bond} slots`}; missed ${m} answering time${m === 1 ? '' : 's'} in epoch ${q.epoch}`);
        }
        say(`forfeited bond, all told: ${la.forfeited} slots`);
      } else if (verb === 'topup') {
        const k = key(a);
        const n = BigInt(b ?? 1);
        const before = (await read()).bonds.lookup(k.id).read();
        await call(`topUp: ${a} + ${n} slot${n === 1n ? '' : 's'} (${tn(n * l0.collateralPerSlot)})`, 'topUp', async () => (await anyone()).callTx.topUp(k.id, n));
        await shown((x) => x.bonds.lookup(k.id).read() === before + n, `${a}'s bond`);
        say(`  ${a}'s bond: ${before} -> ${before + n} slots`);
      } else if (verb === 'standdown') {
        const k = key(a);
        const l = await read();
        const o = l.operators.lookup(k.id);
        if (!o.active) { say(`${a} isn't active`); continue; }
        const bond = l.bonds.lookup(k.id).read();
        if (bond >= l.minBondSlots) throw new Error(`${a}'s bond is ${bond} slots, not below the minimum of ${l.minBondSlots}`);
        await call(`standDown: ${a} (bond ${bond} slots, below the minimum of ${l.minBondSlots})`, 'standDown', async () => (await anyone()).callTx.standDown(k.id, stamp(lead)));
        await shown((x) => !x.operators.lookup(k.id).active, `${a} stood down`);
        const la = await read();
        say(`  ${a} is stood down: ${la.houseActive} house operator${la.houseActive === 1n ? '' : 's'} and ${la.independents} independent${la.independents === 1n ? '' : 's'} active`);
      } else if (verb === 'withdraw') {
        const k = key(a);
        const lb = await read();
        const before = lb.bonds.lookup(k.id).read();
        const n = b === 'all' ? before : BigInt(b ?? 1);
        if (n === 0n) { say(`${a} has no bond to withdraw`); continue; }
        await call(`withdraw: ${a} takes ${n} slot${n === 1n ? '' : 's'} (${tn(n * lb.collateralPerSlot)})`, 'withdraw', async () => (await h(k)).callTx.withdraw(n));
        await shown((x) => x.bonds.lookup(k.id).read() === before - n, `${a}'s bond`);
        say(`  ${a}'s bond: ${before} -> ${before - n} slots, sent to its payout address`);
      } else if (verb === 'recommend') {
        const k = key(a);
        const l = await read();
        const e = l.current;
        const i = positionOf(l, e, k.id);
        if (!i) throw new Error(`${a} has no seat in the serving committee (epoch ${e})`);
        if (l.ballots.member(seatKeyOf(e, i))) { say(`${a} (position ${i}) has named an address in epoch ${e} already`); continue; }
        // A fixed address that is not a contract, so a test vote can never point anyone anywhere real.
        const to = b ? Uint8Array.from(Buffer.from(b, 'hex')) : Uint8Array.from(createHash('sha256').update('nightcast:threshold:successor-test').digest());
        if (to.length !== 32) throw new Error('the address is 32 bytes of hex');
        await call(`recommend: ${a} (position ${i}) names ${hex(to).slice(0, 12)}`, 'recommend', async () => (await h(k)).callTx.recommend(BigInt(i), { bytes: to }));
        await shown((x) => x.ballots.member(seatKeyOf(e, i)), `${a}'s vote`);
        const la = await read();
        const votes = la.votes.member(T.pureCircuits.voteKey(e, to)) ? la.votes.lookup(T.pureCircuits.voteKey(e, to)) : 0n;
        const c = la.committees.lookup(e);
        say(`  ${votes} of ${c.n} seats in epoch ${e} name it${hex(la.backed) === hex(to) && la.backedEpoch === e ? `: epoch ${e} backs it` : ''}${hex(la.successor) === hex(to) && la.successorEpoch === e ? `; two epochs in a row: it is the recommended successor` : ''}`);
      } else if (verb === 'claim') {
        const k = key(a);
        const owed = (await read()).earned;
        const amount = owed.member(k.id) ? owed.lookup(k.id) : 0n;
        if (amount === 0n) { say(`${a} has nothing to claim`); continue; }
        await call(`claim: ${a} collects ${tn(amount)}`, 'claim', async () => (await h(k)).callTx.claim());
        await shown((x) => !x.earned.member(k.id) || x.earned.lookup(k.id) === 0n, `${a} paid`);
      } else {
        throw new Error(`unknown action ${action}`);
      }
    }
    status(await read());
  });
  } catch (e) {
    // The failing call has said why already: one line here, not a stack trace.
    say(`stopped: ${errorText(e)}`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write('usage: node network/threshold/ops/ops.mjs status | do --wallet <file> --dir <keys dir> [--log <file>] <action> ...\n');
  process.exitCode = 2;
}
