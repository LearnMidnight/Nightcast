#!/usr/bin/env node
/**
 * Read-only: ask a Midnight node who produces its blocks. The threshold network's pool list is
 * to be built from this (decided 24 Nov 2026: an operator must be a Cardano stake pool that is a
 * Midnight block producer), so first: does the node answer, and what does the answer hold?
 *
 *   node network/threshold/ops/midnight-committee.mjs [--network preprod]
 *
 * Four or five small requests to the network's node (Blockfrost's, with the project id the CLI
 * uses). Sends nothing and needs no wallet. Prints public keys only, never the project id.
 */
import { parseArgs } from 'node:util';
import { BLOCKFROST, blockfrostProjectId, redact } from '@nightcast/deploy';

const { values } = parseArgs({ options: { network: { type: 'string', default: 'preprod' } } });
const say = (m) => process.stdout.write(`${m}\n`);
const projectId = blockfrostProjectId(values.network);
if (!projectId || !BLOCKFROST[values.network]) throw new Error(`no Blockfrost node or project id for ${values.network}`);
const url = new URL(BLOCKFROST[values.network].node);
url.searchParams.set('project_id', projectId);
const clean = (s) => redact(String(s)).split(projectId).join('<id>');

let id = 0;
const rpc = async (method, params = []) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: ${clean(text).slice(0, 200)}`); }
  if (j.error) throw new Error(`${j.error.code ?? ''} ${clean(j.error.message ?? JSON.stringify(j.error))}`.trim());
  return j.result;
};
const brief = (v, n = 700) => { const s = clean(JSON.stringify(v)); return s.length > n ? `${s.slice(0, n)} ... (${s.length} characters)` : s; };
const attempt = async (what, f) => {
  try { return await f(); } catch (e) { say(`FAIL ${what}: ${clean(e?.message ?? e)}`); return undefined; }
};
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
/** The first number found under any of these key names, anywhere in the object. */
const find = (o, names) => {
  if (!o || typeof o !== 'object') return undefined;
  for (const [k, v] of Object.entries(o)) if (names.includes(k) && num(v) !== undefined) return num(v);
  for (const v of Object.values(o)) { const x = find(v, names); if (x !== undefined) return x; }
  return undefined;
};

const methods = await attempt('rpc_methods', async () => (await rpc('rpc_methods')).methods ?? []);
if (methods) say(`the node answers; its sidechain calls: ${methods.filter((m) => m.startsWith('sidechain_')).join(', ') || 'none'}`);

const status = await attempt('sidechain_getStatus', () => rpc('sidechain_getStatus'));
if (status) say(`status: ${brief(status)}`);
const scEpoch = find(status?.sidechain ?? status, ['epoch']);
const mcEpoch = find(status?.mainchain ?? {}, ['epoch']);

const params = await attempt('sidechain_getParams', () => rpc('sidechain_getParams'));
if (params) say(`params: ${brief(params, 400)}`);

if (mcEpoch !== undefined) {
  const a = await attempt(`sidechain_getAriadneParameters(${mcEpoch})`, () => rpc('sidechain_getAriadneParameters', [mcEpoch]));
  if (a) {
    say(`Cardano epoch ${mcEpoch}: the split between permissioned and registered seats (D parameter): ${brief(a.dParameter ?? a.d_parameter ?? '?', 200)}`);
    const permissioned = a.permissionedCandidates ?? a.permissioned_candidates;
    say(`permissioned candidates (named by Midnight): ${Array.isArray(permissioned) ? permissioned.length : brief(permissioned ?? 'none', 200)}`);
    const regs = a.candidateRegistrations ?? a.candidate_registrations ?? {};
    const pools = Object.keys(regs);
    const valid = pools.filter((p) => (Array.isArray(regs[p]) ? regs[p] : [regs[p]]).some((x) => x?.isValid ?? x?.is_valid));
    say(`stake pools registered as candidates: ${pools.length}, of which ${valid.length} with a valid registration`);
    for (const p of pools.slice(0, 5)) say(`  pool key ${p}: ${brief(regs[p], 420)}`);
    if (!pools.length) say(`  (the whole answer: ${brief(a, 600)})`);
  }
} else {
  say('no Cardano epoch in the status: not asking for the candidates');
}

const committee = await attempt(`sidechain_getEpochCommittee(${scEpoch ?? 'current'})`, () => rpc('sidechain_getEpochCommittee', scEpoch !== undefined ? [scEpoch] : []));
if (committee) {
  const seats = committee.committee ?? committee;
  if (Array.isArray(seats)) {
    const keys = seats.map((s) => s?.stakePoolPubKey ?? s?.stake_pool_pub_key).filter(Boolean);
    say(`Midnight epoch ${committee.sidechainEpoch ?? scEpoch ?? '?'}: a committee of ${seats.length} seats; ${keys.length} name a Cardano stake pool key, ${new Set(keys).size} different pools`);
    for (const s of seats.slice(0, 3)) say(`  seat: ${brief(s, 300)}`);
  } else {
    say(`committee: ${brief(committee)}`);
  }
}
