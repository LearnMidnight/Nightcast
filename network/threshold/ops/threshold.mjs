// Reading the threshold contract's ledger, and what a transaction looks like to the ledger's limits.
// Shared by the Preprod test script (ops.mjs) and the operator (operator.mjs). Nothing here talks
// to the chain.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ecMul, ecMulGenerator } from '@midnight-ntwrk/compact-runtime';
import { LedgerParameters, Transaction } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { R, T, errorText, hex, randomScalar, readJson, writeSecret } from './common.mjs';

export const short = (b) => hex(b).slice(0, 12);
export const isZero = (b) => /^0+$/.test(hex(b));
/** The occupied place in the ring just before `place` (0: none). */
export const priorOf = (l, place) => { let best = 0n; for (const [p] of l.ringOp) if (p < place && p > best) best = p; return best; };
export const phaseName = (p) => Object.keys(T.Phase).find((k) => T.Phase[k] === p) ?? String(p);
/** The proof system's field: a parcel's share and pad are added in it. */
export const FP = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
export const modn = (v, m) => ((v % m) + m) % m;
export const seatKeyOf = (e, i) => T.pureCircuits.seatKey(e, BigInt(i));
export const cellKeyOf = (e, d, i) => T.pureCircuits.cellKey(e, BigInt(d), BigInt(i));
export const shareKeyOf = (number, i) => T.pureCircuits.shareKey(number, BigInt(i));
export const clock = (seconds) => new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
const samePoint = (p, q) => p.x === q.x && p.y === q.y;

/** Position i's share of epoch e's key: its parcels from the finished dealers, opened with its operator secret and added up; checked against its share key on chain. */
export const shareOf = (l, e, i, secret) => {
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

/** Epoch e's seats: position, operator id, and its name where `names` (hex id -> name) knows it. */
export const seatedIn = (l, e, names = new Map()) => Array.from({ length: Number(l.committees.lookup(e).seated) }, (_, k) => {
  const id = l.members.lookup(seatKeyOf(e, k + 1));
  return { position: k + 1, id, name: names.get(hex(id)) };
});
/** An operator's position in epoch e (0: none). */
export const positionOf = (l, e, id) => seatedIn(l, e).find((x) => hex(x.id) === hex(id))?.position ?? 0;

/** Where a dealer keeps its polynomial for an epoch. */
export const polynomialFile = (dir, name, e) => join(dir, `epoch-${e}-${name}.poly.secret`);
/** A dealer's polynomial for an epoch: made once and kept (mode 600), zeros past the threshold. */
export const polynomialFor = (dir, name, e, t) => {
  const file = polynomialFile(dir, name, e);
  if (!existsSync(file)) {
    writeSecret(file, { role: 'threshold-polynomial', operator: name, epoch: e.toString(), coefficients: Array.from({ length: 4 }, (_, k) => (k < t ? randomScalar() : 0n).toString(16).padStart(64, '0')) });
  }
  const p = readJson(file);
  if (p.role !== 'threshold-polynomial') throw new Error(`${file} is not a polynomial file`);
  return p.coefficients.map((c) => BigInt('0x' + c));
};
export const hasPolynomial = (dir, name, e) => existsSync(polynomialFile(dir, name, e));

/** Specks as DUST (10^15 specks each). */
export const dustText = (specks) => (Number(specks) / 1e15).toLocaleString('en', { maximumFractionDigits: 3 });
/** Picoseconds (the ledger's unit of time) as milliseconds. */
const msOf = (ps) => Math.round(Number(ps) / 1e6) / 1e3;
const timeOf = (cost) => (cost.computeTime > cost.readTime ? cost.computeTime : cost.readTime);
/**
 * What a transaction about to be sent looks like to the ledger's limits: its size, its DUST
 * spends, how many of the call's steps run before the fee is taken (guaranteed) and after
 * (fallible), and its price. Whatever can't be read is left out: this never stops a call.
 */
export const describeTx = (handle) => {
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
export const txText = (d) => {
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
