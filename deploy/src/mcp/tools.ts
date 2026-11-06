/**
 * Nightcast's MCP tools: verifiable randomness for AI agents (issue #39).
 *
 *   nightcast_about            what Nightcast is, and how to make a draw fair
 *   nightcast_list_fingerprint the fingerprint of a list, to fix it before the draw
 *   nightcast_request_random   ask the oracle for a random value (needs this server's wallet)
 *   nightcast_check_request    a request's status, its answer, and the checks anyone can run
 *   nightcast_derive           turn an answer into a number, a winner, an order, dice...
 *
 * The chain is behind `RandomnessBackend`, so the tools run the same against
 * Preprod (backend.ts) and the in-memory simulator (the tests).
 */
import { webcrypto } from 'node:crypto';
import { type Request, Status } from '@nightcast/contract';
import { listCommitment, pick, pickMany, randomInt, randomWords, rollDice, shuffle, weightedPick } from '@nightcast/sdk';
import type { Check } from '../verify.js';
import type { CallContext, Tool, ToolText } from './rpc.js';

export const MCP_VERSION = '0.1.0';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));

/** A 32-byte tag from text: UTF-8, zero-padded (the same as `./nightcast request --tag`). */
export const tagOf = (text: string): Uint8Array => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 32) throw new RangeError(`purpose is ${bytes.length} bytes; at most 32 (UTF-8)`);
  const out = new Uint8Array(32);
  out.set(bytes);
  return out;
};

export interface RandomnessBackend {
  network: string;
  contractAddress: string;
  /** Request windows allowed by the contract, in seconds. */
  minWindow: number;
  maxWindow: number;
  /** Whether this server can make requests (it has a wallet and a requester secret). */
  canRequest: boolean;
  /** Why requests can't be made just now (the wallet is still opening, say), or undefined when they can. */
  notReady?(): string | undefined;
  /** The id a request with this tag and seed will have (it depends only on the contract, this server's requester, tag and seed). */
  idFor(tag: Uint8Array, seed: Uint8Array): Uint8Array;
  /** Submit a request; resolves once it's on chain. */
  submit(tag: Uint8Array, seed: Uint8Array, deadline: bigint): Promise<{ txId: string }>;
  /** The request as the chain has it, and the public checks of it (with tag and seed, the id check too). */
  read(id: Uint8Array, inputs?: { tag: Uint8Array; seed: Uint8Array }): Promise<{ request: Request | undefined; checks: Check[] }>;
  /** Seconds since the epoch. */
  now(): number;
}

export type Limits = {
  /** Requests one client may make in an hour (default 6). */
  requestsPerClientHour: number;
  /** Requests this server makes in a day, all clients together (default 200). */
  requestsPerDay: number;
  /** How long request_random waits for its transaction before answering "submitting" (default 40 s). */
  answerWithinMs: number;
};

export const DEFAULT_LIMITS: Limits = { requestsPerClientHour: 6, requestsPerDay: 200, answerWithinMs: 40_000 };

export const INSTRUCTIONS =
  'Nightcast gives verifiable random values on Midnight (currently the Preprod test network). ' +
  'Use it when a choice must be provably fair: a raffle winner, a random reviewer or juror, a spot-check sample, dice or a loot drop. ' +
  'For a fair draw: fix the list first (nightcast_list_fingerprint), publish the list and the request id before the answer exists, ' +
  'then request with the fingerprint as the seed (nightcast_request_random). The oracle answers in about 1-3 minutes: ' +
  'poll nightcast_check_request, then turn the answer into the result with nightcast_derive. Anyone can repeat every step. ' +
  'Outputs are public: never put secrets in a purpose or seed.';

type Pending = { state: 'submitting' } | { state: 'submitted'; txId: string } | { state: 'failed'; reason: string };

/** Sliding-window counters for the request limits. */
class Counter {
  private readonly times = new Map<string, number[]>();
  count(key: string, windowMs: number, now: number): number {
    const kept = (this.times.get(key) ?? []).filter((t) => t > now - windowMs);
    this.times.set(key, kept);
    return kept.length;
  }
  add(key: string, now: number): void {
    const list = this.times.get(key) ?? [];
    list.push(now);
    this.times.set(key, list);
  }
}

const str = (v: unknown, name: string, max = 1000): string => {
  if (typeof v !== 'string') throw new RangeError(`${name} must be text`);
  if (v.length > max) throw new RangeError(`${name} is too long`);
  return v;
};
const int = (v: unknown, name: string, dflt?: number): number => {
  if (v === undefined && dflt !== undefined) return dflt;
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new RangeError(`${name} must be a whole number`);
  return v;
};
const hex64 = (v: unknown, name: string): Uint8Array => {
  const h = str(v, name, 70).trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new RangeError(`${name} must be 64 hex characters`);
  return fromHex(h);
};
const items = (v: unknown, name = 'items'): string[] => {
  if (!Array.isArray(v) || v.length === 0) throw new RangeError(`${name} must be a non-empty list`);
  if (v.length > 10_000) throw new RangeError(`${name} has more than 10,000 entries`);
  return v.map((x, i) => str(typeof x === 'number' ? String(x) : x, `${name}[${i}]`, 500));
};

const STATUS = ['pending', 'fulfilled', 'expired'];
const iso = (secs: bigint | number) => new Date(Number(secs) * 1000).toISOString();
const formatChecks = (checks: Check[]) => checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`).join('\n');

const ok = (lines: (string | false | undefined)[]): ToolText => ({ text: lines.filter((l): l is string => typeof l === 'string').join('\n') });
const no = (text: string): ToolText => ({ text, isError: true });

export const nightcastTools = (backend: RandomnessBackend, limits: Partial<Limits> = {}, clock: () => number = Date.now): Tool[] => {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const pending = new Map<string, Pending>();
  const counter = new Counter();
  // One request at a time: one wallet must not spend the same coins twice.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const run = queue.then(f, f);
    queue = run.catch(() => undefined);
    return run;
  };

  const about: Tool = {
    name: 'nightcast_about',
    title: 'About Nightcast',
    description: 'What Nightcast is, how a request works, how to make a draw provably fair, and its limits. Read it before the first request.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async () =>
      ok([
        `Nightcast: verifiable random values on Midnight (${backend.network}, contract ${backend.contractAddress}).`,
        '',
        'How it works: a request fixes an input (from its purpose and seed). The oracle answers with a value only its secret key can produce, ' +
          "and the network checks a zero-knowledge proof that the answer is the one value fixed by the input and the oracle's published key. " +
          'So the oracle cannot choose the answer; it can only refuse to answer before the deadline (then the request expires, publicly).',
        '',
        'A fair draw, step by step:',
        '1. Fix the list of entries. nightcast_list_fingerprint gives its fingerprint.',
        '2. nightcast_request_random with a purpose (e.g. "raffle-2026-11-06") and the fingerprint as the seed. Publish the list and the request id now, before the answer exists.',
        '3. Poll nightcast_check_request with the id until it is fulfilled (usually 1-3 minutes).',
        '4. nightcast_derive with the output, kind "pick" (or pick_many, shuffle...) and the same list, in the same order.',
        'Anyone can repeat steps 3 and 4 and get the same winner; the id check (with purpose and seed) shows the list was fixed first.',
        '',
        'Limits:',
        `- ${backend.network === 'preprod' || backend.network === 'preview' ? 'This is a test network: the values are real randomness, but nothing here has money value. ' : ''}Unaudited.`,
        '- Outputs, purposes and seeds are public. Never put secrets in them.',
        '- One answer decides one thing. For another decision, make another request (or use "from" in nightcast_derive).',
        backend.canRequest
          ? `- This server makes requests from its own wallet: at most ${L.requestsPerClientHour} an hour for you, ${L.requestsPerDay} a day in all.`
          : '- This server has no wallet, so it cannot make requests; it can still check requests and derive results.',
        '',
        'More: https://github.com/LearnMidnight/Nightcast/blob/main/docs/GUIDE.md',
      ]),
  };

  const fingerprint: Tool = {
    name: 'nightcast_list_fingerprint',
    title: 'Fingerprint a list',
    description:
      'The fingerprint of a list of entries (names, ids...), in order: use it as the seed of a request so the answer is bound to this exact list. Same list, same order, same fingerprint, on any machine.',
    inputSchema: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10000, description: 'The entries, in the order they will be drawn from.' } },
      required: ['items'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a) => {
      const list = items(a.items);
      return ok([`fingerprint: ${listCommitment(list)}`, `entries: ${list.length}`, 'Pass it as the seed of nightcast_request_random, and publish the list in this order.']);
    },
  };

  const request: Tool = {
    name: 'nightcast_request_random',
    title: 'Request a random value',
    description:
      'Ask the Nightcast oracle for a random value, bound to a purpose and a seed (for a fair draw, the list fingerprint). ' +
      'Returns the request id at once (it is fixed by purpose and seed); the transaction takes up to a minute, the answer 1-3 minutes more. ' +
      'Then call nightcast_check_request. Purpose and seed are public.',
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', maxLength: 32, description: 'What the value is for, at most 32 bytes, e.g. "raffle-2026-11-06". Public.' },
        seed: { type: 'string', pattern: '^(0x)?[0-9a-fA-F]{64}$', description: 'Optional 64 hex characters: a list fingerprint, or any value you fixed in advance. Random if left out. Public.' },
        deadline_minutes: { type: 'integer', minimum: 5, maximum: 1440, description: 'How long the oracle has to answer (default 30). After it, anyone can mark the request expired.' },
      },
      required: ['purpose'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (a, ctx: CallContext) => {
      if (!backend.canRequest) return no('This server has no wallet, so it cannot make requests. Run your own (`./nightcast mcp --wallet ... --requester ...`) or use a server that has one.');
      const waitFor = backend.notReady?.();
      if (waitFor) return no(`Not ready to make requests yet: ${waitFor}. Try again in a few minutes.`);
      const purpose = str(a.purpose, 'purpose', 200);
      const tag = tagOf(purpose);
      const seed = a.seed === undefined ? webcrypto.getRandomValues(new Uint8Array(32)) : hex64(a.seed, 'seed');
      const minutes = int(a.deadline_minutes, 'deadline_minutes', 30);
      const secs = Math.max(backend.minWindow + 120, Math.min(backend.maxWindow - 60, minutes * 60));
      const id = backend.idFor(tag, seed);
      const idHex = hex(id);
      const ref = `purpose "${purpose}", seed ${hex(seed)}`;

      // Already asked (by anyone using this server): the same id, the same answer.
      const known = pending.get(idHex);
      if (known && known.state !== 'failed') return ok([`Already requested: id ${idHex} (${ref}).`, 'Call nightcast_check_request with this id.']);
      const existing = (await backend.read(id)).request;
      if (existing) return ok([`Already on chain: id ${idHex} (${ref}), ${STATUS[existing.status]}.`, 'Call nightcast_check_request with this id.']);

      const now = clock();
      if (counter.count(`client:${ctx.client}`, 3_600_000, now) >= L.requestsPerClientHour) return no(`Limit reached: ${L.requestsPerClientHour} requests an hour. Try again later.`);
      if (counter.count('all', 86_400_000, now) >= L.requestsPerDay) return no(`This server has made its ${L.requestsPerDay} requests for today. Try again tomorrow.`);
      counter.add(`client:${ctx.client}`, now);
      counter.add('all', now);

      const deadline = BigInt(Math.floor(backend.now()) + secs);
      pending.set(idHex, { state: 'submitting' });
      const done = serial(() => backend.submit(tag, seed, deadline)).then(
        (r) => {
          pending.set(idHex, { state: 'submitted', txId: r.txId });
          return r;
        },
        (err: unknown) => {
          pending.set(idHex, { state: 'failed', reason: err instanceof Error ? err.message : String(err) });
          throw err;
        },
      );
      done.catch(() => undefined);
      const header = [
        `request id: ${idHex}`,
        `purpose: ${purpose}`,
        `seed: ${hex(seed)}`,
        `deadline: ${iso(deadline)}`,
      ];
      const waited = await Promise.race([done.then((r) => r, (e: unknown) => e as Error), new Promise<'later'>((r) => setTimeout(() => r('later'), L.answerWithinMs).unref?.())]);
      if (waited === 'later') return ok([...header, '', 'Submitting (it can take a minute). Publish the id now if this is a fair draw; then call nightcast_check_request in a minute or two.']);
      if (waited instanceof Error) return no([...header, '', `The request was not made: ${waited.message}`].join('\n'));
      return ok([...header, `transaction: ${waited.txId}`, '', 'On chain. The oracle usually answers within 1-3 minutes: call nightcast_check_request with the id.']);
    },
  };

  const check: Tool = {
    name: 'nightcast_check_request',
    title: 'Check a request',
    description:
      "A request's status (pending, fulfilled, expired) and, once fulfilled, its output (64 hex characters), with the checks anyone can run from public data. " +
      'Give purpose and seed as well to check the id is the one asked for (that the list was fixed first).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^(0x)?[0-9a-fA-F]{64}$', description: 'The request id.' },
        purpose: { type: 'string', maxLength: 32, description: 'Optional: the purpose it was requested with.' },
        seed: { type: 'string', pattern: '^(0x)?[0-9a-fA-F]{64}$', description: 'Optional: the seed it was requested with (needs purpose).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (a) => {
      const id = hex64(a.id, 'id');
      const idHex = hex(id);
      if ((a.seed === undefined) !== (a.purpose === undefined)) return no('Give purpose and seed together (or neither).');
      const inputs = a.seed === undefined ? undefined : { tag: tagOf(str(a.purpose, 'purpose', 200)), seed: hex64(a.seed, 'seed') };
      const { request: r, checks } = await backend.read(id, inputs);
      const local = pending.get(idHex);
      if (!r) {
        if (local?.state === 'submitting') return ok([`request ${idHex}: still being submitted by this server. Check again in a minute.`]);
        if (local?.state === 'failed') return no(`request ${idHex} was not made: ${local.reason}`);
        if (local?.state === 'submitted') return ok([`request ${idHex}: submitted (transaction ${local.txId}); the indexer hasn't shown it yet. Check again in a minute.`]);
        return no(`No request ${idHex} on ${backend.network} (contract ${backend.contractAddress}).`);
      }
      const status = STATUS[r.status] ?? String(r.status);
      const lines: (string | false)[] = [`request ${idHex}`, `status: ${status}`, `deadline: ${iso(r.deadline)}`];
      if (r.status === Status.fulfilled) {
        lines.push(`output: ${hex(r.output)}`, '', 'Turn it into the result with nightcast_derive (same list, same order).');
      } else if (r.status === Status.pending) {
        const left = Number(r.deadline) - backend.now();
        lines.push(left > 0 ? `Waiting for the oracle (${Math.ceil(left / 60)} minute(s) before the deadline). Check again in a minute.` : 'The deadline has passed without an answer: the request can be marked expired. Treat the draw as void and run it again with a new request.');
      } else {
        lines.push('The oracle did not answer in time. Treat the draw as void and run it again with a new request; never re-roll an answered one.');
      }
      lines.push('', 'Checks from public data:', formatChecks(checks));
      if (!inputs) lines.push('(Give purpose and seed as well to check the id is the request that was asked for.)');
      return { text: lines.filter((l): l is string => typeof l === 'string').join('\n'), isError: checks.some((c) => !c.ok) };
    },
  };

  const derive: Tool = {
    name: 'nightcast_derive',
    title: 'Turn an answer into a result',
    description:
      'Turn a fulfilled output into a result, the same way on any machine: an integer in a range, one or several winners from a list, a shuffled order, dice, a weighted pick, or raw words. ' +
      'Deterministic: anyone with the output and the same inputs gets the same result. One output decides one thing; use "from" to take a separate result from the same output.',
    inputSchema: {
      type: 'object',
      properties: {
        output: { type: 'string', pattern: '^(0x)?[0-9a-fA-F]{64}$', description: 'The fulfilled output, 64 hex characters.' },
        kind: { type: 'string', enum: ['integer', 'pick', 'pick_many', 'shuffle', 'dice', 'weighted', 'words'], description: 'What to derive.' },
        min: { type: 'integer', description: 'integer: smallest value (included).' },
        max: { type: 'integer', description: 'integer: largest value (included).' },
        items: { type: 'array', items: { type: 'string' }, description: 'pick, pick_many, shuffle: the entries, in the published order.' },
        count: { type: 'integer', minimum: 1, description: 'pick_many: how many winners; dice: how many dice; words: how many words.' },
        sides: { type: 'integer', minimum: 2, description: 'dice: sides on each die (default 6).' },
        weights: {
          type: 'array',
          items: { type: 'object', properties: { item: { type: 'string' }, weight: { type: 'integer', minimum: 1 } }, required: ['item', 'weight'] },
          description: 'weighted: entries with whole-number weights, in the published order.',
        },
        from: { type: 'integer', minimum: 0, description: 'Start at this word of the output (default 0), for a separate result from the same output.' },
      },
      required: ['output', 'kind'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (a) => {
      const output = hex64(a.output, 'output');
      const opts = { from: int(a.from, 'from', 0) };
      const kind = str(a.kind, 'kind', 20);
      switch (kind) {
        case 'integer': {
          const min = int(a.min, 'min');
          const max = int(a.max, 'max');
          return ok([`${randomInt(output, min, max, opts)}`, `(an integer from ${min} to ${max}, both included)`]);
        }
        case 'pick':
          return ok([pick(output, items(a.items), opts)]);
        case 'pick_many': {
          const list = items(a.items);
          const n = int(a.count, 'count');
          if (n > list.length) return no(`count (${n}) is more than the ${list.length} entries`);
          return ok(pickMany(output, list, n, opts).map((x, i) => `${i + 1}. ${x}`));
        }
        case 'shuffle':
          return ok(shuffle(output, items(a.items), opts).map((x, i) => `${i + 1}. ${x}`));
        case 'dice': {
          const n = int(a.count, 'count', 1);
          const sides = int(a.sides, 'sides', 6);
          if (n < 1 || n > 1000) return no('count must be 1-1000');
          return ok([rollDice(output, n, sides, opts).join(' '), `(${n} d${sides})`]);
        }
        case 'weighted': {
          if (!Array.isArray(a.weights) || a.weights.length === 0) return no('weights must be a non-empty list of { item, weight }');
          const w = (a.weights as unknown[]).map((x, i) => {
            const e = x as { item?: unknown; weight?: unknown };
            return [str(e.item, `weights[${i}].item`, 500), int(e.weight, `weights[${i}].weight`)] as const;
          });
          return ok([weightedPick(output, w, opts)]);
        }
        case 'words': {
          const n = int(a.count, 'count', 1);
          if (n < 1 || n > 256) return no('count must be 1-256');
          return ok(randomWords(output, opts.from + n).slice(opts.from).map((w, i) => `${opts.from + i}: ${hex(w)}`));
        }
        default:
          return no(`unknown kind ${kind}`);
      }
    },
  };

  return [about, fingerprint, request, check, derive];
};
