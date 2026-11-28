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
 *         send:<address>:<tNIGHT>     send tNIGHT from the wallet to another (an operator's, to fund it)
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
 * goes on from what the chain shows. `tnet.sh bg` does that by itself. A wallet that hasn't caught
 * up with the chain within --open-wait minutes (30 by default) ends the run the same way.
 *
 * A circuit that takes the time is given "now" a little ahead (--lead 60 seconds; --lead-link 240
 * for linkPool, whose proof is the largest), because its proof has to be made before it is sent.
 * The contract accepts a "now" within its slack of the block's time.
 * With --proof-container <docker name> the proof server's memory is sampled during each call and
 * its peak reported. Each transaction's size, its DUST spends, how much of the call the chain
 * runs before taking the fee (the guaranteed part: that and the proofs are what the allowance is
 * for) and its price are reported and logged too.
 */
import { createHash, webcrypto } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { ecMul, ecMulGenerator, encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { blockfrostProjectId, connect } from '@nightcast/deploy';
import {
  R, T, ed25519Point, errorText, fromHex, hex, ledgerOf, night, operatorFrom, poolIdOf, poolList, poolSign, readJson, readRecord, say, tn,
} from './common.mjs';
import {
  cellKeyOf, clock, isZero, modn, phaseName, polynomialFile as polynomialFileIn, polynomialFor as polynomialForIn, positionOf, priorOf,
  seatKeyOf, seatedIn as seatedInWith, shareOf, short,
} from './threshold.mjs';
import { openRuntime } from './runtime.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wallet: { type: 'string' }, dir: { type: 'string' }, log: { type: 'string' }, network: { type: 'string', default: 'preprod' }, 'proof-server-port': { type: 'string', default: '6304' },
    lead: { type: 'string', default: '60' }, 'lead-link': { type: 'string', default: '240' }, 'proof-container': { type: 'string' },
    'dust-spends': { type: 'string', default: '3' }, 'dust-wait': { type: 'string', default: '120' }, stall: { type: 'string', default: '10' },
    'open-wait': { type: 'string', default: '30' },
  },
});
const mode = positionals[0];
const record = readRecord(values.network);
const address = record.contractAddress;


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
  try {
  await openRuntime({
    network: values.network, proofServerPort: Number(values['proof-server-port']), walletFile: values.wallet, address, log: values.log, saveDir: dir,
    dustSpends: values['dust-spends'], dustWait: values['dust-wait'], stall: values.stall, openWait: values['open-wait'],
    lead: Number(values.lead), leadLink: Number(values['lead-link']), proofContainer: values['proof-container'],
  }, async ({ handle, anyone, me, meBytes, l0, read, shown, waitUntil, call, stamp, lead, leadLink, coinsNow, coinsText, coinsUntil, makeCoins, sendNight, setSpends, spends }) => {
    say(`calling from ${me}; the contract's slack is ${l0.slack} s`);
    const c0 = await coinsNow();
    say(`the wallet: ${coinsText(c0)}; each fee is paid with ${spends() === 1 ? 'as few DUST coins as cover it' : `${spends()} DUST coins`}`);
    if (c0.dustCoins + c0.booked < spends() && !actions.some((x) => x.split(':')[0] === 'coins')) {
      throw new Error(`the wallet has ${c0.dustCoins + c0.booked} DUST coin(s) and each fee is to be paid with ${spends()}: make them first with the coins action (bash network/threshold/vm/tnet.sh coins)`);
    }
    const h = (k) => handle(`tnet-${k.name}`, { operatorSecret: k.secret, answerSecs: l0.answerSecs });
    const key = (name) => ({ ...operatorFrom(join(dir, `${name}.secret`)), name });
    /** The operator keys kept in <dir>, by id: who is who on the chain. */
    const known = new Map();
    for (const f of readdirSync(dir)) {
      if (!/^(house|op)-\d+\.secret$/.test(f)) continue;
      const name = f.replace(/\.secret$/, '');
      known.set(hex(operatorFrom(join(dir, f)).id), name);
    }
    const newest = (l) => { if (l.opened === 0n) throw new Error('no epoch has been opened yet'); return l.opened; };
    const seatedIn = (l, e) => seatedInWith(l, e, known);
    const polynomialFile = (name, e) => polynomialFileIn(dir, name, e);
    const polynomialFor = (name, e, t) => polynomialForIn(dir, name, e, t);
    const lastRequest = () => {
      const file = join(dir, 'last-request');
      if (!existsSync(file)) throw new Error('no request has been made from here yet (request first)');
      return fromHex(readFileSync(file, 'utf8').trim());
    };

    for (const action of actions) {
      const [verb, a, b] = action.split(':');
      if (verb === 'spends') {
        setSpends(a);
        say(`fees from here on: ${spends() === 1 ? 'one DUST coin' : `${spends()} DUST coins`}`);
      } else if (verb === 'coins') {
        const n = Math.max(1, Math.min(4, Math.floor(Number(a ?? spends())) || 1));
        const before = await coinsNow();
        if (before.dustCoins >= n) { say(`the wallet has ${before.dustCoins} DUST coins free: nothing to make`); continue; }
        say(`the wallet now: ${coinsText(await makeCoins(n))}`);
      } else if (verb === 'send') {
        const amount = night(b);
        if (!a?.startsWith('mn_addr') || !(amount > 0n)) throw new Error('send:<mn_addr_... address>:<tNIGHT>');
        const before = await coinsNow();
        if (before.night < amount) throw new Error(`the wallet has ${tn(before.night)}`);
        const txId = await sendNight(a, amount);
        say(`${tn(amount)} sent to ${a}, transaction ${txId}`);
        // Until it lands, the UTXO it spent is out of the wallet with all its change: wait for the change, so the next send has NIGHT to spend.
        await coinsUntil((x) => x.night < before.night && x.night >= before.night - amount, 'the transfer and its change didn\'t show within 10 minutes', 10 * 60_000);
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
          // Each minute, ask the wallet for its coins: an answer is a sign of life, so a wallet that has lost the
          // network goes quiet and the watchdog starts the run again (26 Nov: a wallet that lost it here settled
          // nearly an hour behind the chain and was refused).
          await waitUntil(due);
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
