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
 *       Bonds are paid from the wallet, and fees and bonds come back to it.
 *   Both: [--network preprod] [--proof-server-port 6304]
 *
 * A circuit that takes the time is given "now" a little ahead (--lead 60 seconds; --lead-link 240
 * for linkPool, whose proof is the largest), because its proof has to be made before it is sent.
 * The contract accepts a "now" within its slack of the block's time.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ContractState } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import { blockfrostProjectId, connect } from '@nightcast/deploy';
import {
  T, ed25519Point, errorText, fromHex, hex, ledgerOf, operatorFrom, poolIdOf, poolList, poolSign, readJson, readRecord, say, sleep, succeeded, tn, withChain,
} from './common.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wallet: { type: 'string' }, dir: { type: 'string' }, log: { type: 'string' }, network: { type: 'string', default: 'preprod' }, 'proof-server-port': { type: 'string', default: '6304' },
    lead: { type: 'string', default: '60' }, 'lead-link': { type: 'string', default: '240' },
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

const status = (l) => {
  say(`contract ${address}`);
  say(`pool list: ${l.poolCount} places loaded${isZero(l.poolsNext) ? ', complete' : ', more to load'}`);
  say(`epochs: serving ${l.current}, newest opened ${l.opened}${l.opened > 0n ? ` (${phaseName(l.committees.lookup(l.opened).phase)})` : ''}`);
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
    /** Wait until the indexer shows what the transaction did. */
    const shown = async (ok, what, ms = 180_000) => {
      const until = Date.now() + ms;
      for (;;) {
        if (ok(await read())) return;
        if (Date.now() > until) throw new Error(`the chain did not show ${what} within ${ms / 1000} s`);
        await sleep(5_000);
      }
    };
    /** One call: up to three tries when it fails for a reason that can pass; a contract assertion is final. */
    const call = async (what, circuit, f) => {
      for (let i = 1; ; i++) {
        proving = 0;
        const started = Date.now();
        try {
          const r = succeeded(await f(), what);
          const row = { time: new Date().toISOString(), what, circuit, ok: true, provingSeconds: Math.round(proving / 100) / 10, totalSeconds: Math.round((Date.now() - started) / 100) / 10, tries: i, txId: r.public?.txId };
          log(row);
          say(`ok   ${what}: proof ${row.provingSeconds} s, ${row.totalSeconds} s in all${i > 1 ? ` (try ${i})` : ''}, transaction ${row.txId}`);
          return r;
        } catch (e) {
          const text = errorText(e);
          log({ time: new Date().toISOString(), what, circuit, ok: false, provingSeconds: Math.round(proving / 100) / 10, totalSeconds: Math.round((Date.now() - started) / 100) / 10, tries: i, error: text });
          say(`FAIL ${what} (try ${i}; proof ${Math.round(proving / 1000)} s, ${Math.round((Date.now() - started) / 1000)} s in all): ${text}`);
          if (i >= 3 || /failed assert|assertion failed/i.test(text)) throw e;
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
          if (isZero(next)) { say('the pool list is fully loaded'); break; }
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
