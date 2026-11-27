import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits, Status } from '@nightcast/contract';
import { BATCH_TAG, commitOf, leafOf, PUBLIC_SALT, seedFromPath, valueOf } from './batch.js';
import type { NightcastChain } from './chain.js';
import { checkFastAnswer, type FastAnswer, type FastProof, outputOfGamma, samePoint } from './fast-answer.js';

/**
 * A batch receipt: everything needed to check one person's number, as JSON
 * (bytes as hex, curve points as {x, y} in hex). Made by the batch service,
 * checked by anyone with {@link checkReceipt}.
 */
export type BatchReceipt = {
  format: 'nightcast-batch-receipt/1';
  /** The Nightcast deployment (its 32-byte address, hex). */
  contract: string;
  /** The batch service's requester commitment (hex). */
  requester: string;
  /** The oracle key the request is bound to. */
  oracleKey: HexPoint;
  batch: { size: number; requestId: string; requestTx?: string };
  entry: {
    index: number;
    client: string;
    ref: string;
    commit: string;
    /** The sibling hashes from the entry up to the top (hex). */
    path: string[];
    /** Present once the person (or app) shows it: then the number can be checked. */
    salt?: string;
  };
  answer: { gamma: HexPoint; proof: { u: HexPoint; v: HexPoint; s: string }; fulfilTx?: string };
  /** The person's number (hex), when the salt is known. */
  value?: string;
};

export type HexPoint = { x: string; y: string };

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (s: string, what: string, length = 32): Uint8Array => {
  if (typeof s !== 'string' || !/^[0-9a-f]*$/i.test(s) || s.length !== length * 2) throw new TypeError(`${what} must be ${length} bytes of hex`);
  return Uint8Array.from(Buffer.from(s, 'hex'));
};
const big = (s: string, what: string): bigint => {
  if (typeof s !== 'string' || !/^[0-9a-f]{1,64}$/i.test(s)) throw new TypeError(`${what} must be hex`);
  return BigInt(`0x${s}`);
};
export const toHexPoint = (p: JubjubPoint): HexPoint => ({ x: p.x.toString(16), y: p.y.toString(16) });
export const fromHexPoint = (p: HexPoint, what: string): JubjubPoint => ({ x: big(p?.x, `${what}.x`), y: big(p?.y, `${what}.y`) });

/** The id of a batch request, and the point the oracle answers at. */
export const batchRequest = (contract: Uint8Array, requester: Uint8Array, seed: Uint8Array): { id: Uint8Array; point: JubjubPoint } => {
  const id = pureCircuits.requestId({ bytes: contract }, requester, BATCH_TAG, seed);
  return { id, point: pureCircuits.inputPoint(id) };
};

/** A receipt for entry `index` of a sealed batch, once its request has a fast answer. */
export const makeReceipt = (args: {
  contract: Uint8Array;
  requester: Uint8Array;
  oracleKey: JubjubPoint;
  size: number;
  requestId: Uint8Array;
  index: number;
  entry: { client: Uint8Array; ref: Uint8Array; commit: Uint8Array };
  path: Uint8Array[];
  answer: Pick<FastAnswer, 'gamma' | 'proof'>;
  salt?: Uint8Array;
  requestTx?: string;
  fulfilTx?: string;
}): BatchReceipt => {
  const { proof } = args.answer;
  const r: BatchReceipt = {
    format: 'nightcast-batch-receipt/1',
    contract: hex(args.contract),
    requester: hex(args.requester),
    oracleKey: toHexPoint(args.oracleKey),
    batch: { size: args.size, requestId: hex(args.requestId), ...(args.requestTx ? { requestTx: args.requestTx } : {}) },
    entry: { index: args.index, client: hex(args.entry.client), ref: hex(args.entry.ref), commit: hex(args.entry.commit), path: args.path.map(hex) },
    answer: {
      gamma: toHexPoint(args.answer.gamma),
      proof: { u: toHexPoint(proof.u), v: toHexPoint(proof.v), s: proof.s.toString(16) },
      ...(args.fulfilTx ? { fulfilTx: args.fulfilTx } : {}),
    },
  };
  return args.salt ? withSalt(r, args.salt) : r;
};

/** The receipt with the salt shown, and so the number. */
export const withSalt = (r: BatchReceipt, salt: Uint8Array): BatchReceipt => {
  const checked = checkReceipt({ ...r, entry: { ...r.entry, salt: hex(salt) }, value: undefined });
  if (!checked.value) throw new Error(`that salt doesn't fit this receipt: ${checked.problems.join('; ')}`);
  return { ...r, entry: { ...r.entry, salt: hex(salt) }, value: hex(checked.value) };
};

export type ReceiptCheck = {
  /** Everything that could be checked passed (offline, and on chain when a chain was given). */
  ok: boolean;
  /** What failed, in words. */
  problems: string[];
  /** The batch request's output (from the fast answer). */
  output?: Uint8Array;
  /** The point the request is answered at (worked out from the batch). */
  point?: JubjubPoint;
  /** The person's number, when the salt is known and everything checks. */
  value?: Uint8Array;
  /** Whether the chain was asked, and what it showed. */
  onChain?: { requested: boolean; answered: boolean };
};

/**
 * Check a receipt. Offline: the entry is in the batch, the batch is the
 * request's seed, the fast answer is the only one the oracle's key could give
 * for that request, and (with the salt) the number. With a chain: the request
 * is on chain, bound to that key, and, once answered, with the same output.
 */
export const checkReceipt = (r: BatchReceipt): ReceiptCheck => {
  const problems: string[] = [];
  try {
    if (r?.format !== 'nightcast-batch-receipt/1') return { ok: false, problems: ['not a Nightcast batch receipt (format)'] };
    const contract = fromHex(r.contract, 'contract');
    const requester = fromHex(r.requester, 'requester');
    const key = fromHexPoint(r.oracleKey, 'oracleKey');
    const entry = { client: fromHex(r.entry.client, 'client'), ref: fromHex(r.entry.ref, 'ref'), commit: fromHex(r.entry.commit, 'commit') };
    const path = (r.entry.path ?? []).map((p, i) => fromHex(p, `path[${i}]`));
    const leaf = leafOf(entry);
    const seed = seedFromPath(leaf, r.entry.index, r.batch.size, path);
    if (!seed) return { ok: false, problems: [`the entry and its path are not entry ${r.entry.index} of a batch of ${r.batch.size}`] };
    const { id, point } = batchRequest(contract, requester, seed);
    if (hex(id) !== r.batch.requestId.toLowerCase()) problems.push("the batch's seed doesn't make this request id: the entry isn't in that batch");
    const gamma = fromHexPoint(r.answer.gamma, 'gamma');
    const proof: FastProof = { u: fromHexPoint(r.answer.proof.u, 'proof.u'), v: fromHexPoint(r.answer.proof.v, 'proof.v'), s: big(r.answer.proof.s, 'proof.s') };
    if (!checkFastAnswer(key, point, gamma, proof)) problems.push("the answer's proof doesn't check: it isn't the oracle key's answer for this request");
    if (problems.length) return { ok: false, problems };
    const out = outputOfGamma(gamma);
    let value: Uint8Array | undefined;
    if (r.entry.salt !== undefined) {
      const salt = fromHex(r.entry.salt, 'salt');
      if (hex(commitOf(salt)) !== hex(entry.commit)) return { ok: false, problems: ["the salt isn't the one the entry committed to"], output: out, point };
      value = valueOf(out, leaf, salt);
      if (r.value !== undefined && r.value.toLowerCase() !== hex(value)) return { ok: false, problems: ['the number in the receipt is not the one its salt gives'], output: out, point };
    } else if (r.value !== undefined) {
      problems.push('the receipt states a number but not the salt it comes from');
    }
    return { ok: problems.length === 0, problems, output: out, point, value };
  } catch (e) {
    return { ok: false, problems: [`the receipt can't be read: ${e instanceof Error ? e.message : String(e)}`] };
  }
};

/**
 * {@link checkReceipt}, then the chain: the request is there, bound to the
 * receipt's oracle key at the same point, and, if it has been answered, with
 * the same output.
 */
export const checkReceiptOnChain = async (r: BatchReceipt, chain: Pick<NightcastChain, 'listRequests'>): Promise<ReceiptCheck> => {
  const c = checkReceipt(r);
  if (!c.ok) return c;
  const want = r.batch.requestId.toLowerCase();
  const found = (await chain.listRequests()).find((e) => hex(e.id) === want);
  if (!found) return { ...c, ok: false, problems: [...c.problems, 'the request is not on chain'], onChain: { requested: false, answered: false } };
  const req = found.request;
  const problems: string[] = [];
  if (!samePoint(req.oracleKey, fromHexPoint(r.oracleKey, 'oracleKey'))) problems.push('on chain, the request is bound to a different oracle key');
  if (c.point && !samePoint(req.point, c.point)) problems.push('on chain, the request is answered at a different point');
  const answered = req.status === Status.fulfilled;
  if (answered && c.output && hex(req.output) !== hex(c.output)) problems.push("the on-chain answer differs from the fast answer");
  return { ...c, ok: problems.length === 0, problems: [...c.problems, ...problems], onChain: { requested: true, answered } };
};

/** The salt that lets anyone compute a number (hex), for receipts that give up privacy. */
export const PUBLIC_SALT_HEX = hex(PUBLIC_SALT);
