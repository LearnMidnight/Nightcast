/**
 * The MCP server (issue #39), against the in-memory simulator: a fair raffle
 * end to end through the tools, the limits, and the HTTP transport.
 */
import { describe, expect, it } from 'vitest';
import { generateOperatorSecret, generateOracleSecretKey, NightcastSimulator, oraclePublicKey, Status } from '@nightcast/contract';
import { listCommitment, pick } from '@nightcast/sdk';
import { checkRequest } from '../check.js';
import { clientOf, serveHttp } from '../mcp/http.js';
import { handle, type Tool } from '../mcp/rpc.js';
import { isStaleFee, positionsOf, SERVER_INFO, Watchdog } from '../mcp/serve.js';
import { INSTRUCTIONS, nightcastTools, type RandomnessBackend } from '../mcp/tools.js';
import type { DeploymentRecord } from '../record.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const REQUESTER = new Uint8Array(32).fill(5);

/** A backend over the simulator. `submitDelay` makes submissions slow; `failWith` makes them fail. */
const simBackend = (o: { canRequest?: boolean; submitDelayMs?: number; failWith?: () => Error } = {}) => {
  const sk = generateOracleSecretKey();
  const sim = new NightcastSimulator({ oracleSecretKey: sk, operatorSecret: generateOperatorSecret(), minWindow: 60n, maxWindow: 86_400n });
  const pk = oraclePublicKey(sk);
  const record = {
    network: 'local',
    contractAddress: sim.address,
    parameters: { oraclePublicKey: { x: pk.x.toString(), y: pk.y.toString() }, minWindow: '60', maxWindow: '86400' },
  } as unknown as DeploymentRecord;
  let submits = 0;
  const backend: RandomnessBackend = {
    network: 'local',
    contractAddress: sim.address,
    minWindow: 60,
    maxWindow: 86_400,
    canRequest: o.canRequest ?? true,
    idFor: (tag, seed) => sim.idFor(tag, seed, REQUESTER),
    async submit(tag, seed, deadline) {
      submits += 1;
      if (o.submitDelayMs) await new Promise((r) => setTimeout(r, o.submitDelayMs));
      if (o.failWith) throw o.failWith();
      sim.request(tag, seed, deadline, { requesterSecret: REQUESTER });
      return { txId: `tx${submits}` };
    },
    async read(id, inputs) {
      const requests = sim.getLedger().requests;
      const request = requests.member(id) ? requests.lookup(id) : undefined;
      return { request, checks: checkRequest(record, {} as never, id, request, { inputs, deployment: false }) };
    },
    now: () => sim.now,
  };
  return { sim, backend, submits: () => submits };
};

const call = async (tools: Tool[], name: string, args: Record<string, unknown>, client = 'a') => {
  const t = tools.find((x) => x.name === name)!;
  return t.run(args, { client });
};
const field = (text: string, name: string) => new RegExp(`${name}: ([^\\n]+)`).exec(text)?.[1];

describe('the MCP tools', () => {
  it('run a fair raffle end to end: fingerprint, request, answer, check, derive', async () => {
    const { sim, backend } = simBackend();
    const tools = nightcastTools(backend);
    const names = ['Ava', 'Ben', 'Chloe', 'Dev', 'Ella'];
    const fp = field((await call(tools, 'nightcast_list_fingerprint', { items: names })).text, 'fingerprint')!;
    expect(fp).toBe(listCommitment(names));

    const req = await call(tools, 'nightcast_request_random', { purpose: 'raffle-2026-11-06', seed: fp });
    expect(req.isError).toBeFalsy();
    const id = field(req.text, 'request id')!;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(req.text).toMatch(/On chain/);

    // Before the answer: pending.
    const before = await call(tools, 'nightcast_check_request', { id, purpose: 'raffle-2026-11-06', seed: fp });
    expect(before.text).toMatch(/status: pending/);

    sim.fulfil(Uint8Array.from(Buffer.from(id, 'hex')));
    const after = await call(tools, 'nightcast_check_request', { id, purpose: 'raffle-2026-11-06', seed: fp });
    expect(after.isError).toBe(false);
    expect(after.text).toMatch(/status: fulfilled/);
    expect(after.text).toMatch(/PASS {2}id matches/i);
    const output = field(after.text, 'output')!;

    const winner = (await call(tools, 'nightcast_derive', { output, kind: 'pick', items: names })).text;
    expect(winner).toBe(pick(output, names));
    // Anyone repeating it gets the same.
    expect((await call(tools, 'nightcast_derive', { output, kind: 'pick', items: names })).text).toBe(winner);
  });

  it('the id check fails for a different list', async () => {
    const { sim, backend } = simBackend();
    const tools = nightcastTools(backend);
    const fp = listCommitment(['a', 'b']);
    const id = field((await call(tools, 'nightcast_request_random', { purpose: 'x', seed: fp })).text, 'request id')!;
    sim.fulfil(Uint8Array.from(Buffer.from(id, 'hex')));
    const swapped = await call(tools, 'nightcast_check_request', { id, purpose: 'x', seed: listCommitment(['a', 'b', 'c']) });
    expect(swapped.isError).toBe(true);
    expect(swapped.text).toMatch(/FAIL/);
  });

  it('derives integers, winners, orders, dice, weights and words, the same each time', async () => {
    const { backend } = simBackend();
    const tools = nightcastTools(backend);
    const output = 'ab'.repeat(32);
    const n = Number((await call(tools, 'nightcast_derive', { output, kind: 'integer', min: 1, max: 6 })).text.split('\n')[0]);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(6);
    const three = (await call(tools, 'nightcast_derive', { output, kind: 'pick_many', items: ['a', 'b', 'c', 'd'], count: 3 })).text.split('\n');
    expect(three).toHaveLength(3);
    expect(new Set(three.map((l) => l.slice(3))).size).toBe(3);
    const order = (await call(tools, 'nightcast_derive', { output, kind: 'shuffle', items: ['a', 'b', 'c', 'd'] })).text;
    expect(order.split('\n').map((l) => l.slice(3)).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect((await call(tools, 'nightcast_derive', { output, kind: 'dice', count: 2, sides: 6 })).text).toMatch(/^[1-6] [1-6]\n/);
    expect(['gold', 'silver']).toContain((await call(tools, 'nightcast_derive', { output, kind: 'weighted', weights: [{ item: 'gold', weight: 1 }, { item: 'silver', weight: 9 }] })).text);
    expect((await call(tools, 'nightcast_derive', { output, kind: 'words', count: 2, from: 3 })).text).toMatch(/^3: [0-9a-f]{64}\n4: [0-9a-f]{64}$/);
    // from gives a separate result
    expect((await call(tools, 'nightcast_derive', { output, kind: 'words', count: 1, from: 1 })).text).not.toBe((await call(tools, 'nightcast_derive', { output, kind: 'words', count: 1 })).text);
    expect((await call(tools, 'nightcast_derive', { output, kind: 'pick_many', items: ['a'], count: 2 })).isError).toBe(true);
    await expect(call(tools, 'nightcast_derive', { output: 'nope', kind: 'pick', items: ['a'] })).rejects.toThrow(/64 hex/);
  });

  it('limits requests per client and per day, and reuses an id already asked for', async () => {
    const { backend, submits } = simBackend();
    const tools = nightcastTools(backend, { requestsPerClientHour: 2, requestsPerDay: 3 });
    expect((await call(tools, 'nightcast_request_random', { purpose: 'one' }, 'a')).isError).toBeFalsy();
    expect((await call(tools, 'nightcast_request_random', { purpose: 'two' }, 'a')).isError).toBeFalsy();
    const third = await call(tools, 'nightcast_request_random', { purpose: 'three' }, 'a');
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/2 requests an hour/);
    expect((await call(tools, 'nightcast_request_random', { purpose: 'four' }, 'b')).isError).toBeFalsy();
    expect((await call(tools, 'nightcast_request_random', { purpose: 'five' }, 'c')).text).toMatch(/3 requests for today/);
    // Same purpose and seed: the same id, not a new request (and not counted).
    const seed = 'cd'.repeat(32);
    const tools2 = nightcastTools(simBackend().backend);
    const first = await call(tools2, 'nightcast_request_random', { purpose: 'same', seed }, 'z');
    const again = await call(tools2, 'nightcast_request_random', { purpose: 'same', seed }, 'y');
    expect(again.text).toMatch(/Already (requested|on chain)/);
    expect(field(again.text, 'id') ?? again.text).toContain(field(first.text, 'request id')!);
    expect(submits()).toBe(3);
  });

  it('answers at once with the id when the transaction is slow, and check_request follows it', async () => {
    const { backend } = simBackend({ submitDelayMs: 200 });
    const tools = nightcastTools(backend, { answerWithinMs: 20 });
    const r = await call(tools, 'nightcast_request_random', { purpose: 'slow' });
    expect(r.text).toMatch(/Submitting/);
    const id = field(r.text, 'request id')!;
    expect((await call(tools, 'nightcast_check_request', { id })).text).toMatch(/still being submitted/);
    await new Promise((res) => setTimeout(res, 300));
    expect((await call(tools, 'nightcast_check_request', { id })).text).toMatch(/status: pending/);
  });

  it('reports a failed request, and requests one at a time', async () => {
    const { backend } = simBackend({ failWith: () => new Error('1010: Invalid Transaction: Custom error: 170') });
    const tools = nightcastTools(backend);
    const r = await call(tools, 'nightcast_request_random', { purpose: 'fails' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not made: .*170/);
    expect((await call(tools, 'nightcast_check_request', { id: field(r.text, 'request id')! })).text).toMatch(/was not made/);

    const slow = simBackend({ submitDelayMs: 50 });
    let running = 0;
    let most = 0;
    const submit = slow.backend.submit.bind(slow.backend);
    slow.backend.submit = async (...a) => {
      most = Math.max(most, ++running);
      try {
        return await submit(...a);
      } finally {
        running -= 1;
      }
    };
    const t = nightcastTools(slow.backend);
    await Promise.all(['p', 'q', 'r'].map((p, i) => call(t, 'nightcast_request_random', { purpose: p }, `c${i}`)));
    expect(most).toBe(1);
  });

  it('a read-only server says it cannot request, and a server whose wallet is opening says so', async () => {
    const ro = nightcastTools(simBackend({ canRequest: false }).backend);
    expect((await call(ro, 'nightcast_request_random', { purpose: 'x' })).text).toMatch(/no wallet/);
    expect((await call(ro, 'nightcast_about', {})).text).toMatch(/cannot make requests/);
    const { backend } = simBackend();
    backend.notReady = () => "this server's wallet is still opening and syncing";
    expect((await call(nightcastTools(backend), 'nightcast_request_random', { purpose: 'x' })).text).toMatch(/Not ready.*still opening/);
  });

  it('refuses a purpose over 32 bytes and a bad seed', async () => {
    const tools = nightcastTools(simBackend().backend);
    await expect(call(tools, 'nightcast_request_random', { purpose: 'x'.repeat(33) })).rejects.toThrow(/at most 32/);
    await expect(call(tools, 'nightcast_request_random', { purpose: 'x', seed: '12' })).rejects.toThrow(/64 hex/);
  });

  it('an expired request says the draw is void', async () => {
    const { sim, backend } = simBackend();
    const tools = nightcastTools(backend);
    const id = field((await call(tools, 'nightcast_request_random', { purpose: 'late', deadline_minutes: 5 })).text, 'request id')!;
    sim.advance(3600);
    expect((await call(tools, 'nightcast_check_request', { id })).text).toMatch(/deadline has passed/);
    sim.expire(Uint8Array.from(Buffer.from(id, 'hex')));
    const out = await call(tools, 'nightcast_check_request', { id });
    expect(out.text).toMatch(/status: expired/);
    expect(out.text).toMatch(/void/);
    expect(sim.getLedger().requests.lookup(Uint8Array.from(Buffer.from(id, 'hex'))).status).toBe(Status.expired);
  });
});

describe('the JSON-RPC layer', () => {
  it('initializes, lists the five tools and calls one', async () => {
    const tools = nightcastTools(simBackend().backend);
    const init = (await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, tools, SERVER_INFO, INSTRUCTIONS, { client: 'x' })) as {
      result: { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    };
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.serverInfo.name).toBe('nightcast');
    const list = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools, SERVER_INFO, INSTRUCTIONS, { client: 'x' })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['nightcast_about', 'nightcast_list_fingerprint', 'nightcast_request_random', 'nightcast_check_request', 'nightcast_derive']);
    const bad = (await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nightcast_derive', arguments: { output: 'zz', kind: 'pick' } } }, tools, SERVER_INFO, INSTRUCTIONS, { client: 'x' })) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(bad.result.isError).toBe(true);
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, SERVER_INFO, INSTRUCTIONS, { client: 'x' })).toBeUndefined();
  });
});

describe('the HTTP transport', () => {
  const post = (port: number, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('answers MCP over POST, refuses other origins, big bodies and too many calls', async () => {
    const tools = nightcastTools(simBackend().backend);
    const server = await serveHttp(tools, SERVER_INFO, INSTRUCTIONS, { port: 0, callsPerMinute: 5, health: () => ({ network: 'local' }) });
    const port = (server.address() as { port: number }).port;
    try {
      const list = await post(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(list.status).toBe(200);
      expect(((await list.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(5);
      expect((await post(port, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
      expect((await post(port, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await post(port, 'x'.repeat(70_000))).status).toBe(413);
      expect((await fetch(`http://127.0.0.1:${port}/mcp`)).status).toBe(405);
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({ ok: true, network: 'local' });
      // 5 a minute: the POSTs above used 3 (the 403 and the GETs aren't counted)
      expect((await post(port, { jsonrpc: '2.0', id: 9, method: 'ping' })).status).toBe(200);
      expect((await post(port, { jsonrpc: '2.0', id: 10, method: 'ping' })).status).toBe(200);
      expect((await post(port, { jsonrpc: '2.0', id: 11, method: 'ping' })).status).toBe(429);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('takes the client from X-Forwarded-For only behind a trusted proxy', () => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } } as never;
    expect(clientOf(req, true)).toBe('203.0.113.9');
    expect(clientOf(req, false)).toBe('127.0.0.1');
  });
});

describe('the watchdog', () => {
  it('asks for a restart when the sync stops moving, or after three stale-fee refusals in a row', () => {
    let now = 0;
    const w = new Watchdog(20, () => now);
    const at = (d: number) => ({ dust: { state: { progress: { appliedIndex: BigInt(d) } } } });
    w.see(at(1));
    now = 19 * 60_000;
    expect(w.check()).toBeUndefined();
    w.see(at(2));
    now += 19 * 60_000;
    expect(w.check()).toBeUndefined();
    now += 2 * 60_000;
    expect(w.check()).toMatch(/hasn't moved for 21 minutes/);

    const v = new Watchdog(20, () => 0);
    const stale = Object.assign(new Error('Transaction submission error'), { cause: new Error('1010: Invalid Transaction: Custom error: 170') });
    expect(isStaleFee(stale)).toBe(true);
    expect(isStaleFee(new Error('Custom error: 1701'))).toBe(false);
    v.failed(stale);
    v.failed(stale);
    v.submitted();
    v.failed(stale);
    v.failed(stale);
    expect(v.check()).toBeUndefined();
    v.failed(stale);
    expect(v.check()).toMatch(/three requests in a row/);
  });

  it("follows wallet SDK 2's state, where each part has its own progress", () => {
    let now = 0;
    const w = new Watchdog(20, () => now);
    const sdk2 = (d: number) => ({ shielded: { progress: { appliedIndex: 5n } }, unshielded: { progress: { appliedId: 7n } }, dust: { progress: { appliedIndex: BigInt(d) } } });
    expect(positionsOf(sdk2(9))).toBe('shielded:5|unshielded:7|dust:9');
    w.see(sdk2(1));
    now = 19 * 60_000;
    w.see(sdk2(50_000)); // only DUST moves, as in a long DUST sync
    now += 19 * 60_000;
    expect(w.check()).toBeUndefined();
    const early = { shielded: { get progress(): never { throw new Error('not started'); } }, dust: {} };
    expect(positionsOf(early)).toBe('shielded:?|unshielded:?|dust:?');
  });
});
