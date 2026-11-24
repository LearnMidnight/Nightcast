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
 *       Bonds and fees are paid from the wallet, and fees, bounties and bonds come back to it.
 *   Both: [--network preprod] [--proof-server-port 6304]
 *
 * A circuit that takes the time is given "now" a little ahead (--lead 60 seconds; --lead-link 240
 * for linkPool, whose proof is the largest), because its proof has to be made before it is sent.
 * The contract accepts a "now" within its slack of the block's time.
 * With --proof-container <docker name> the proof server's memory is sampled during each call and
 * its peak reported.
 */
import { execFile } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { ecMul, ecMulGenerator, encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { blockfrostProjectId, connect } from '@nightcast/deploy';
import {
  R, T, ed25519Point, errorText, fromHex, hex, ledgerOf, operatorFrom, poolIdOf, poolList, poolSign, randomScalar, readJson, readRecord, say, sleep, succeeded, tn,
  withChain, writeSecret,
} from './common.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wallet: { type: 'string' }, dir: { type: 'string' }, log: { type: 'string' }, network: { type: 'string', default: 'preprod' }, 'proof-server-port': { type: 'string', default: '6304' },
    lead: { type: 'string', default: '60' }, 'lead-link': { type: 'string', default: '240' }, 'proof-container': { type: 'string' },
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

const status = (l) => {
  say(`contract ${address}`);
  say(`pool list: ${l.poolCount} places loaded${isZero(l.poolsNext) ? ', complete' : ', more to load'}`);
  say(`epochs: serving ${l.current}, newest opened ${l.opened}${l.opened > 0n ? ` (${phaseName(l.committees.lookup(l.opened).phase)})` : ''}`);
  if (l.opened > 0n) {
    const c = l.committees.lookup(l.opened);
    say(`  epoch ${l.opened}: ${c.t} of ${c.n}, ${c.indepSeats} seats for independents; ${c.seated} seated, ${c.dealt} dealers finished${c.phase === T.Phase.serving ? `; serving since ${clock(c.since)}` : c.phase === T.Phase.failed ? '' : `; deadline ${clock(c.dealBy)}`}`);
    for (let i = 1; i <= Number(c.seated); i++) say(`    position ${i}: ${short(l.members.lookup(seatKeyOf(l.opened, i)))}`);
  }
  say(`operators: ${l.houseActive} house active, ${l.independents} independent in the ring${l.independents > 0n ? ` (places ${[...l.ringOp].map(([p]) => p).sort((a, b) => (a < b ? -1 : 1)).join(', ')}; last seated ${l.cursor})` : ''}`);
  for (const [id, o] of l.operators) {
    const place = l.poolOf.member(id) ? `pool place ${l.listed.lookup(l.poolOf.lookup(id))}` : o.house ? 'house' : 'no pool';
    say(`  ${short(id)}  ${o.active ? 'active' : 'left  '}  bond ${l.bonds.lookup(id).read()} slots  ${place}`);
  }
  say(`requests made: ${l.nextRequest}; forfeited bond: ${l.forfeited} slots`);
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
  await withChain({ network: values.network, proofServerPort: Number(values['proof-server-port']), walletFile: values.wallet, address }, async ({ providers, read, handle, me, meBytes }) => {
    // Time the proof server's part of each call.
    let proving = 0;
    const prover = providers.proofProvider;
    providers.proofProvider = new Proxy(prover, {
      get: (t, k) => {
        const v = t[k];
        if (typeof v !== 'function') return v;
        return async (...a) => { const s = Date.now(); try { return await v.apply(t, a); } finally { proving += Date.now() - s; } };
      },
    });
    const l0 = await read();
    const stamp = (lead) => BigInt(Math.floor(Date.now() / 1000) + lead);
    const lead = Number(values.lead), leadLink = Number(values['lead-link']);
    if (BigInt(Math.max(lead, leadLink)) >= l0.slack) throw new Error(`a lead of ${Math.max(lead, leadLink)} s is not inside the contract's slack of ${l0.slack} s`);
    say(`calling from ${me}; the contract's slack is ${l0.slack} s`);
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
        try {
          const r = succeeded(await f(), what);
          clearInterval(sampler);
          const row = { time: new Date().toISOString(), what, circuit, ok: true, provingSeconds: Math.round(proving / 100) / 10, totalSeconds: Math.round((Date.now() - started) / 100) / 10, tries: i, peakProofServerMiB: peak, txId: r.public?.txId };
          log(row);
          say(`ok   ${what}: proof ${row.provingSeconds} s, ${row.totalSeconds} s in all${memory()}${i > 1 ? ` (try ${i})` : ''}, transaction ${row.txId}`);
          return r;
        } catch (e) {
          clearInterval(sampler);
          const text = errorText(e);
          log({ time: new Date().toISOString(), what, circuit, ok: false, provingSeconds: Math.round(proving / 100) / 10, totalSeconds: Math.round((Date.now() - started) / 100) / 10, tries: i, peakProofServerMiB: peak, error: text });
          say(`FAIL ${what} (try ${i}; proof ${Math.round(proving / 1000)} s, ${Math.round((Date.now() - started) / 1000)} s in all${memory()}): ${text}`);
          // a proof server that failed is not asked again at once: it may have run out of memory
          if (i >= 3 || /failed assert|assertion failed|Proof Server request failed/i.test(text)) throw e;
          await sleep(20_000);
        }
      }
    };

    for (const action of actions) {
      const [verb, a, b] = action.split(':');
      if (verb === 'load-pools') {
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
        const before = (await read()).opened;
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
        await call('settle', 'settle', async () => (await anyone()).callTx.settle(rid, { bytes: meBytes }));
        await shown((x) => x.requests.lookup(rid).settled, 'the request settled');
        const q = (await read()).requests.lookup(rid);
        say(q.voided ? 'the request is void: its fee went back' : 'the request is paid: its fee is shared by the seats that answered in time');
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
} else {
  process.stderr.write('usage: node network/threshold/ops/ops.mjs status | do --wallet <file> --dir <keys dir> [--log <file>] <action> ...\n');
  process.exitCode = 2;
}
