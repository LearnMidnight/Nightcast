#!/usr/bin/env node
/**
 * The test requester for the Nightcast network: asks for randomness on a schedule, each time from
 * the next three active operators in turn, finalises each request once all three shares are in
 * (or expires it after its deadline), and logs the timings.
 *
 *   node network/ops/requester.mjs run --wallet <file> --secret <file> [--every 180] [--count 0] [--window 600] [--poll 15] [--log <file>]
 *       --secret: a requester secret file (made on first use). --count is the total to send (the log counts, so a restart
 *       carries on); 0 runs until stopped. Each poll reads the
 *       contract once through the indexer (Blockfrost on Preprod), so keep --poll at 15 s or more.
 *   node network/ops/requester.mjs report [--log <file>]
 *       No network: what the log says (answered, void, times).
 *   Every mode: [--network preprod] [--proof-server-port 6304]
 *
 * One request at a time: two requests from the same wallet in one block clash (the second is
 * refused and must be sent again), so the schedule waits for each to land.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { parseArgs } from 'node:util';
import { N, ROOT, appendJsonl, errorText, fromHex, hex, readJson, readJsonl, readRecord, say, send, sleep, withChain, writeSecret } from './common.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wallet: { type: 'string' }, secret: { type: 'string' }, every: { type: 'string', default: '180' }, count: { type: 'string', default: '0' },
    window: { type: 'string', default: '600' }, poll: { type: 'string', default: '15' }, 'stall-after': { type: 'string', default: '10' }, log: { type: 'string' }, network: { type: 'string', default: 'preprod' }, 'proof-server-port': { type: 'string', default: '6304' },
  },
});
const mode = positionals[0];
const logFile = values.log ?? join(ROOT, 'deployments', `${values.network}-requests.jsonl`);

const median = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const fmt = (x) => (Number.isFinite(x) ? `${x.toFixed(0)} s` : '-');

if (mode === 'report') {
  const rows = readJsonl(logFile);
  const sent = rows.filter((r) => r.event === 'sent');
  const done = new Map(rows.filter((r) => r.event === 'finalised' || r.event === 'expired' || r.event === 'void').map((r) => [r.id, r]));
  const fin = sent.filter((r) => done.get(r.id)?.event === 'finalised');
  const voids = sent.filter((r) => ['expired', 'void'].includes(done.get(r.id)?.event));
  const open = sent.length - fin.length - voids.length;
  say(`${sent.length} requests: ${fin.length} answered by all three, ${voids.length} void, ${open} still open`);
  const toLand = fin.map((r) => r.landSeconds);
  const toShares = fin.map((r) => done.get(r.id).sharesAfter);
  const total = fin.map((r) => done.get(r.id).totalSeconds);
  say(`time to land the request: median ${fmt(median(toLand))}, slowest ${fmt(Math.max(...toLand))}`);
  say(`time from landing to all three shares: median ${fmt(median(toShares))}, slowest ${fmt(Math.max(...toShares))}`);
  say(`send to random value on chain (incl. finalise): median ${fmt(median(total))}, slowest ${fmt(Math.max(...total))}`);
  const retries = sent.filter((r) => r.tries > 1).length;
  if (retries) say(`${retries} requests needed more than one try to land`);
  for (const v of voids) say(`void: ${v.id.slice(0, 8)} (group ${v.group.join(', ')})${done.get(v.id)?.missing ? `, missing ${done.get(v.id).missing.join(', ')}` : ''}`);
  process.exit(0);
}
if (mode !== 'run') throw new Error('usage: requester.mjs run|report ...');
if (!values.wallet || !values.secret) throw new Error('--wallet <file> and --secret <file> are required');
if (!existsSync(values.secret)) writeSecret(values.secret, { role: 'nightcast-network-requester', secret: hex(webcrypto.getRandomValues(new Uint8Array(32))) });
const requesterSecret = fromHex(readJson(values.secret).secret);
const record = readRecord(values.network);
const every = Number(values.every) * 1000;
const count = Number(values.count);
const windowSecs = BigInt(values.window);

// the requester restarts itself when its wallet stops following the chain (stall-watch.mjs)
await withChain({ network: values.network, proofServerPort: Number(values['proof-server-port']), walletFile: values.wallet, address: record.contractAddress, watch: Number(values['stall-after']) }, async ({ read, handle, me, meBytes }) => {
  const h = await handle('net-requester', { requesterSecret });
  say(`requesting from ${me} on ${record.contractAddress}, every ${values.every} s${count ? `, ${count} in all` : ''}`);
  const open = new Map(); // id hex -> { sentAt, landedAt, group }
  let n = readJsonl(logFile).filter((r) => r.event === 'sent').length;
  let sentHere = n; // --count is the total in the log, so a restart carries on where it stopped
  let nextAt = Date.now();

  const tick = async () => {
    const l = await read();
    // The active operators in key id order: request n goes to the n-th, (n+1)-th and (n+2)-th.
    const active = [...l.operators].filter(([, o]) => o.active).map(([k]) => hex(k)).sort();
    // Look after open requests: finalise when all three shares are in, note a void.
    for (const [id, o] of open) {
      const idBytes = fromHex(id);
      if (!l.requests.member(idBytes)) continue;
      const r = l.requests.lookup(idBytes);
      const missing = r.operators.filter((k) => !l.shares.member(N.pureCircuits.shareKeyOf(idBytes, k))).map((k) => hex(k).slice(0, 6));
      if (r.status === N.Status.fulfilled) {
        appendJsonl(logFile, { event: 'finalised', id, by: 'someone else', output: hex(r.output), totalSeconds: (Date.now() - o.sentAt) / 1000, sharesAfter: o.sharesAt ? (o.sharesAt - o.landedAt) / 1000 : undefined });
        open.delete(id);
        continue;
      }
      if (r.status === N.Status.expired) {
        appendJsonl(logFile, { event: 'void', id, missing });
        say(`${id.slice(0, 8)} is void (expired), missing ${missing.join(', ')}`);
        open.delete(id);
        continue;
      }
      if (missing.length === 0) {
        o.sharesAt ??= Date.now();
        try {
          const f = await send(`finalise ${id.slice(0, 8)}`, () => h.callTx.finalise(idBytes), { tries: 3, waitMs: 10_000 });
          const total = (Date.now() - o.sentAt) / 1000;
          appendJsonl(logFile, { event: 'finalised', id, output: hex(f.result ?? new Uint8Array()), totalSeconds: total, sharesAfter: (o.sharesAt - o.landedAt) / 1000, finaliseSeconds: f.seconds });
          say(`${id.slice(0, 8)}: all three answered ${((o.sharesAt - o.landedAt) / 1000).toFixed(0)} s after it landed; random value on chain ${total.toFixed(0)} s after sending`);
          open.delete(id);
        } catch (e) {
          say(`finalise ${id.slice(0, 8)} failed: ${errorText(e).slice(0, 160)}`);
        }
      } else if (Math.floor(Date.now() / 1000) > Number(r.deadline) + 30) {
        try {
          await send(`expire ${id.slice(0, 8)}`, () => h.callTx.expire(idBytes), { tries: 2, waitMs: 10_000 });
          appendJsonl(logFile, { event: 'expired', id, missing });
          say(`${id.slice(0, 8)} expired, missing ${missing.join(', ')}: their fees and collateral were refunded`);
        } catch (e) {
          say(`expire ${id.slice(0, 8)} failed (maybe an operator did it): ${errorText(e).slice(0, 120)}`);
        }
        open.delete(id);
      }
    }
    // Send the next request when it's due.
    if ((count === 0 || sentHere < count) && Date.now() >= nextAt) {
      if (active.length < 3) { say(`only ${active.length} active operators: waiting`); return; }
      const group = [0, 1, 2].map((j) => active[(n + j) % active.length]);
      const seed = webcrypto.getRandomValues(new Uint8Array(32));
      const tag = new Uint8Array(32); tag.set(new TextEncoder().encode('network-test'));
      const sentAt = Date.now();
      const deadline = BigInt(Math.floor(sentAt / 1000)) + windowSecs;
      try {
        const r = await send(`request ${n + 1}`, () => h.callTx.request(tag, seed, deadline, { bytes: meBytes }, group.map(fromHex)), { tries: 4, waitMs: 15_000 });
        const id = hex(r.result);
        const landedAt = Date.now();
        open.set(id, { sentAt, landedAt, group });
        n++; sentHere++;
        appendJsonl(logFile, { event: 'sent', n, id, group: group.map((g) => g.slice(0, 6)), sentAt: new Date(sentAt).toISOString(), landSeconds: (landedAt - sentAt) / 1000, tries: r.tries, deadline: deadline.toString(), txId: r.txId });
        say(`request ${n} (${id.slice(0, 8)}) landed in ${((landedAt - sentAt) / 1000).toFixed(0)} s${r.tries > 1 ? ` (try ${r.tries})` : ''}; operators ${group.map((g) => g.slice(0, 6)).join(', ')}`);
      } catch (e) {
        say(`request ${n + 1} failed: ${errorText(e).slice(0, 200)}`);
      }
      nextAt = sentAt + every;
    }
  };

  for (;;) {
    try { await tick(); } catch (e) { say(`tick failed: ${errorText(e).slice(0, 200)}`); }
    if (count > 0 && sentHere >= count && open.size === 0) { say(`done: ${sentHere} requests`); return; }
    await sleep(Number(values.poll) * 1000);
  }
});
