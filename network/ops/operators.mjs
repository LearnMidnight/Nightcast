#!/usr/bin/env node
/**
 * Nightcast network operators: several operator keys run by one process, paying fees from one
 * wallet (an operator is its key; which wallet pays its fees doesn't matter to the contract). For
 * the five-operator test on one machine; a real operator runs this with its own key and wallet.
 *
 *   node network/ops/operators.mjs keys --dir <dir> --count 5
 *       Make operator keys op-1.secret ... in <dir> (mode 600; existing ones are kept).
 *   node network/ops/operators.mjs register --dir <dir> --wallet <file> [--bond 20]
 *       Register every key in <dir> that isn't active yet, each with --bond slots (paid from the
 *       wallet); fees are paid to the wallet's own address.
 *   node network/ops/operators.mjs run --dir <dir> --wallet <file> [--key op-N] [--poll 15]
 *       Answer every request naming one of the keys, expire requests past their deadline, and
 *       finalise any whose requester hasn't. A key is paused while <dir>/op-N.pause exists
 *       (to test a missing operator). Logs to <dir>/answers.jsonl; status in <dir>/status.json.
 *       With --key, only that operator, paying its fees from its own --wallet (as a real operator
 *       does): one process per operator, in parallel. Then a request is finalised or expired by
 *       its group's first operator, or by any of them once it's 2 minutes overdue (status in
 *       <dir>/status-op-N.json).
 *   node network/ops/operators.mjs leave --dir <dir> --wallet <file> --key op-5
 *       That operator takes its free bond back and leaves (stops being named in new requests).
 *   node network/ops/operators.mjs status --dir <dir> --wallet <file>
 *   Every mode: [--network preprod] [--proof-server-port 6304]
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { N, appendJsonl, errorText, hex, newOperatorSecret, operatorIdOf, readJson, readRecord, say, send, sleep, tn, withChain, writeSecret } from './common.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' }, wallet: { type: 'string' }, count: { type: 'string', default: '5' }, bond: { type: 'string', default: '20' },
    poll: { type: 'string', default: '15' }, 'stall-after': { type: 'string', default: '10' }, key: { type: 'string' }, network: { type: 'string', default: 'preprod' }, 'proof-server-port': { type: 'string', default: '6304' },
  },
});
const mode = positionals[0];
if (!values.dir) throw new Error('--dir <dir> is required (where the operator keys are)');
const dir = values.dir;

/** The operator keys in `dir`: [{ name, sk, id, idHex }] in name order. */
const loadKeys = () =>
  readdirSync(dir)
    .filter((f) => /^op-\d+\.secret$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((f) => {
      const j = readJson(join(dir, f));
      if (j.role !== 'nightcast-network-operator') throw new Error(`${f} is not an operator key`);
      const sk = BigInt('0x' + j.secret);
      const id = operatorIdOf(sk);
      return { name: f.replace(/\.secret$/, ''), sk, id, idHex: hex(id) };
    });

if (mode === 'keys') {
  const have = existsSync(dir) ? loadKeys().length : 0;
  for (let i = have + 1; i <= Number(values.count); i++) {
    const sk = newOperatorSecret();
    writeSecret(join(dir, `op-${i}.secret`), { role: 'nightcast-network-operator', secret: sk.toString(16).padStart(64, '0'), id: hex(operatorIdOf(sk)) });
    say(`op-${i}: ${hex(operatorIdOf(sk))}`);
  }
  say(`${Math.max(have, Number(values.count))} operator keys in ${dir}`);
  process.exit(0);
}

if (!values.wallet) throw new Error('--wallet <file> is required');
const record = readRecord(values.network);
const keys = loadKeys();
if (keys.length === 0) throw new Error(`no operator keys in ${dir}: run \`keys\` first`);
// a running operator restarts itself when its wallet stops following the chain (stall-watch.mjs)
const chain = { network: values.network, proofServerPort: Number(values['proof-server-port']), walletFile: values.wallet, address: record.contractAddress, watch: mode === 'run' ? Number(values['stall-after']) : 0 };

await withChain(chain, async ({ read, handle, me, meBytes }) => {
  const h = (k) => handle(`net-${k.name}`, { oracleSecretKey: k.sk });
  const l0 = await read();
  const isActive = (l, k) => l.operators.member(k.id) && l.operators.lookup(k.id).active;

  if (mode === 'register') {
    say(`registering from ${me}; fees and withdrawn bonds are paid to this wallet`);
    for (const k of keys) {
      if (isActive(l0, k)) { say(`${k.name} is already active`); continue; }
      const rejoin = l0.operators.member(k.id);
      const slots = rejoin ? 0n : BigInt(values.bond);
      const r = await send(`register ${k.name}`, async () => (await h(k)).callTx.register({ bytes: meBytes }, slots));
      say(`${k.name} ${rejoin ? 'rejoined' : `registered with ${slots} slots (${tn(slots * l0.collateralPerRequest)})`} in ${r.seconds.toFixed(0)} s (tx ${r.txId})`);
    }
    return;
  }

  if (mode === 'leave') {
    const k = keys.find((x) => x.name === values.key);
    if (!k) throw new Error(`no key ${values.key} in ${dir}`);
    const free = l0.bonds.member(k.id) ? l0.bonds.lookup(k.id).read() : 0n;
    const r = await send(`leave ${k.name}`, async () => (await h(k)).callTx.withdrawBond(free, true));
    say(`${k.name} left and took ${free} free slots back (${tn(free * l0.collateralPerRequest)}) in ${r.seconds.toFixed(0)} s`);
    return;
  }

  if (mode === 'status') {
    const l = await read();
    say(`contract ${record.contractAddress}: ${l.operatorCount} operators, ${l.requestCount} requests`);
    for (const k of keys) {
      const o = l.operators.member(k.id) ? l.operators.lookup(k.id) : undefined;
      say(`${k.name} ${k.idHex.slice(0, 12)}…  ${o ? (o.active ? 'active' : 'left') : 'not registered'}  free bond ${o ? l.bonds.lookup(k.id).read() : 0} slots${existsSync(join(dir, `${k.name}.pause`)) ? '  (paused)' : ''}`);
    }
    const counts = { pending: 0, fulfilled: 0, expired: 0 };
    for (const [, r] of l.requests) counts[['pending', 'fulfilled', 'expired'][r.status]]++;
    say(`requests: ${counts.fulfilled} fulfilled, ${counts.expired} expired, ${counts.pending} pending`);
    return;
  }

  if (mode !== 'run') throw new Error('usage: operators.mjs keys|register|run|leave|status ...');
  const poll = Number(values.poll) * 1000;
  // One operator per process (its own wallet), or every key in <dir> from one wallet.
  const only = values.key ? keys.filter((k) => k.name === values.key) : null;
  if (values.key && !only.length) throw new Error(`no key ${values.key} in ${dir}`);
  if (only) keys.splice(0, keys.length, ...only);
  const mine = new Map(keys.map((k) => [k.idHex, k]));
  const seen = new Map(); // request id -> first seen (ms)
  const gaveUp = new Set();
  const stats = { answered: 0, failed: 0, expired: 0, finalised: 0, started: new Date().toISOString() };
  const status = (extra = {}) => writeFileSync(join(dir, only ? `status-${values.key}.json` : 'status.json'), JSON.stringify({ ...stats, updated: new Date().toISOString(), wallet: me, ...extra }, null, 2) + '\n');
  say(`running ${keys.length} operators (${keys.map((k) => k.name).join(', ')}) for ${record.contractAddress}; paying fees from ${me}`);
  for (;;) {
    let l;
    try { l = await read(); } catch (e) { say(`reading the contract failed: ${errorText(e)}`); await sleep(poll); continue; }
    const now = Math.floor(Date.now() / 1000);
    const jobs = [];
    for (const [idBytes, r] of l.requests) {
      if (r.status !== N.Status.pending) continue;
      const id = hex(idBytes);
      if (!seen.has(id)) seen.set(id, Date.now());
      const missing = r.operators.filter((k) => !l.shares.member(N.pureCircuits.shareKeyOf(idBytes, k)));
      const deadline = Number(r.deadline);
      // One operator per process: the group's first operator tidies up (finalise, expire), and any
      // operator does once it's 2 minutes overdue, so several processes don't all send the same call.
      const tidy = !only || hex(r.operators[0]) === only[0].idHex || now >= deadline + 120;
      if (now >= deadline + 15) {
        if (!tidy) continue;
        if (missing.length > 0 && !gaveUp.has(`x${id}`)) jobs.push({ kind: 'expire', id, idBytes, at: deadline });
        else if (missing.length === 0 && !gaveUp.has(`f${id}`)) jobs.push({ kind: 'finalise', id, idBytes, at: deadline });
        continue;
      }
      if (missing.length === 0) {
        // The requester normally finalises; do it if it hasn't after a minute.
        if (tidy && Date.now() - seen.get(id) > 60_000 && !gaveUp.has(`f${id}`)) jobs.push({ kind: 'finalise', id, idBytes, at: deadline });
        continue;
      }
      for (const kb of missing) {
        const k = mine.get(hex(kb));
        if (!k || gaveUp.has(`a${id}${k.name}`)) continue;
        if (existsSync(join(dir, `${k.name}.pause`))) continue;
        if (deadline - now < 45) continue; // too close to its deadline to land in time
        jobs.push({ kind: 'answer', id, idBytes, k, at: deadline, slot: r.operators.findIndex((x) => hex(x) === k.idHex) });
      }
    }
    // Answers first, soonest deadline first; then finalising and expiring.
    const rank = { answer: 0, finalise: 1, expire: 2 };
    jobs.sort((a, b) => rank[a.kind] - rank[b.kind] || a.at - b.at);
    const job = jobs[0];
    if (!job) { status({ waiting: 0 }); await sleep(poll); continue; }
    const short = job.id.slice(0, 8);
    try {
      if (job.kind === 'answer') {
        const r = await send(`answer ${short} as ${job.k.name}`, async () => (await h(job.k)).callTx.answer(job.idBytes), { tries: 3, waitMs: 10_000 });
        stats.answered++;
        const sinceSeen = (Date.now() - seen.get(job.id)) / 1000;
        say(`${job.k.name} answered ${short} (operator ${job.slot + 1} of 3) in ${r.seconds.toFixed(0)} s, ${sinceSeen.toFixed(0)} s after seeing it${r.tries > 1 ? `, try ${r.tries}` : ''}`);
        appendJsonl(join(dir, 'answers.jsonl'), { at: new Date().toISOString(), request: job.id, operator: job.k.name, slot: job.slot, seconds: r.seconds, sinceSeen, tries: r.tries, txId: r.txId });
      } else if (job.kind === 'finalise') {
        const r = await send(`finalise ${short}`, async () => (await h(keys[0])).callTx.finalise(job.idBytes), { tries: 2, waitMs: 10_000 });
        stats.finalised++;
        say(`finalised ${short} in ${r.seconds.toFixed(0)} s`);
      } else {
        const r = await send(`expire ${short}`, async () => (await h(keys[0])).callTx.expire(job.idBytes), { tries: 2, waitMs: 10_000 });
        stats.expired++;
        say(`expired ${short} (past its deadline without every share) in ${r.seconds.toFixed(0)} s`);
        appendJsonl(join(dir, 'answers.jsonl'), { at: new Date().toISOString(), request: job.id, expired: true, txId: r.txId });
      }
    } catch (e) {
      stats.failed++;
      const text = errorText(e);
      // Already done by someone else, or refused for good: don't try this one again.
      gaveUp.add(job.kind === 'answer' ? `a${job.id}${job.k.name}` : `${job.kind[0] === 'e' ? 'x' : 'f'}${job.id}`);
      say(`${job.kind} ${short}${job.k ? ` as ${job.k.name}` : ''} failed: ${text.slice(0, 200)}`);
    }
    status({ waiting: jobs.length - 1 });
  }
});
