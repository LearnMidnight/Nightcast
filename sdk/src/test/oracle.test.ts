import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateOperatorSecret,
  generateOracleSecretKey,
  NightcastSimulator,
  oraclePublicKey,
  pureCircuits,
  Status,
} from '@nightcast/contract';
import { SimulatorChain } from '../chain.js';
import { NightcastOracle, selectWork } from '../oracle.js';
import { generateSecret } from '../keygen.js';
import { uniformInt } from '../derive.js';

const label = (s: string): Uint8Array => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(s).slice(0, 32));
  return b;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const setup = (opts: { safetyMarginSecs?: number } = {}) => {
  const sk = generateOracleSecretKey();
  const sim = new NightcastSimulator({
    oracleSecretKey: sk,
    operatorSecret: generateOperatorSecret(),
    minWindow: 60n,
    maxWindow: 3_600n,
  });
  const chain = new SimulatorChain(sim, sk);
  const oracle = new NightcastOracle({ chain, secretKey: sk, safetyMarginSecs: opts.safetyMarginSecs ?? 30 });
  return { sk, sim, chain, oracle };
};

describe('NightcastOracle', () => {
  it('fulfils every pending request with the expected output', async () => {
    const { sim, oracle, sk } = setup();
    const ids = [1, 2, 3].map((i) => sim.request(label('game'), label(`draw-${i}`), BigInt(sim.now + 600)));

    const report = await oracle.tick();
    expect(report.fulfilled.sort()).toEqual(ids.map(hex).sort());

    for (const id of ids) {
      const r = sim.getLedger().requests.lookup(id);
      expect(r.status).toBe(Status.fulfilled);
      expect(hex(r.output)).toBe(hex(pureCircuits.evaluate(sk, id)));
      expect(hex(oracle.expectedOutput({ id, request: r }))).toBe(hex(r.output));
    }
    expect((await oracle.tick()).fulfilled).toEqual([]);
  });

  it('ignores requests bound to another key', async () => {
    const { sim, oracle } = setup();
    const other = generateOracleSecretKey();
    sim.proposeOracleKey(oraclePublicKey(other));
    sim.acceptOracleKey({ oracleSecretKey: other });
    const id = sim.request(label('g'), label('s'), BigInt(sim.now + 600));
    expect((await oracle.tick()).fulfilled).toEqual([]);
    expect(sim.getLedger().requests.lookup(id).status).toBe(Status.pending);
  });

  it('can be limited to known requesters', async () => {
    const { sim, sk, chain } = setup();
    const friend = { requesterSecret: label('friend') };
    const spammer = { requesterSecret: label('spammer') };
    const good = sim.request(label('g'), label('s'), BigInt(sim.now + 600), friend);
    const spam = sim.request(label('g'), label('s'), BigInt(sim.now + 100), spammer);
    const oracle = new NightcastOracle({
      chain,
      secretKey: sk,
      safetyMarginSecs: 30,
      requesters: [hex(pureCircuits.requesterCommitmentOf(friend.requesterSecret)).toUpperCase()],
    });
    expect((await oracle.tick()).fulfilled).toEqual([hex(good)]);
    expect(sim.getLedger().requests.lookup(spam).status).toBe(Status.pending);
  });

  it('leaves requests that are too close to their deadline', async () => {
    const { sim, oracle } = setup();
    const id = sim.request(label('g'), label('s'), BigInt(sim.now + 100));
    sim.advance(80); // 20 s left, under the 30 s margin
    const report = await oracle.tick();
    expect(report.fulfilled).toEqual([]);
    expect(report.skipped).toEqual([{ id: hex(id), reason: 'too close to deadline' }]);
  });

  it('re-checks the deadline before each fulfil', async () => {
    const { sim, sk, chain } = setup();
    const first = sim.request(label('g'), label('a'), BigInt(sim.now + 200));
    const second = sim.request(label('g'), label('b'), BigInt(sim.now + 220));
    // Each fulfil "takes" 190 s, as a slow proof would.
    const slow = {
      listRequests: () => chain.listRequests(),
      now: () => chain.now(),
      fulfil: async (id: Uint8Array) => {
        await chain.fulfil(id);
        sim.advance(190);
      },
    };
    const oracle = new NightcastOracle({ chain: slow, secretKey: sk, safetyMarginSecs: 30 });
    const report = await oracle.tick();
    expect(report.fulfilled).toEqual([hex(first)]);
    expect(report.skipped).toEqual([{ id: hex(second), reason: 'too close to deadline' }]);
  });

  it('retries failures with backoff instead of giving up', async () => {
    const { sim, sk, chain } = setup();
    const id = sim.request(label('g'), label('s'), BigInt(sim.now + 600));
    let failuresLeft = 3;
    const flaky = {
      listRequests: () => chain.listRequests(),
      now: () => chain.now(),
      fulfil: async (rid: Uint8Array) => {
        if (failuresLeft-- > 0) throw new Error('node unavailable');
        await chain.fulfil(rid);
      },
    };
    const oracle = new NightcastOracle({ chain: flaky, secretKey: sk, backoffMs: 5, maxBackoffMs: 20 });
    expect((await oracle.tick()).failed).toEqual([{ id: hex(id), error: 'node unavailable' }]);
    expect((await oracle.tick()).skipped).toEqual([{ id: hex(id), reason: 'backing off' }]);
    for (let i = 0; i < 20 && sim.getLedger().requests.lookup(id).status !== Status.fulfilled; i++) {
      await new Promise((r) => setTimeout(r, 25));
      await oracle.tick();
    }
    expect(sim.getLedger().requests.lookup(id).status).toBe(Status.fulfilled);
  });

  it('never runs two passes at once', async () => {
    const { sim, oracle } = setup();
    sim.request(label('g'), label('s'), BigInt(sim.now + 600));
    const [a, b] = await Promise.all([oracle.tick(), oracle.tick()]);
    expect(a).toBe(b);
    expect(a.fulfilled).toHaveLength(1);
  });

  it('polls until stopped', async () => {
    const { sim, sk, chain } = setup();
    const oracle = new NightcastOracle({ chain, secretKey: sk, pollMs: 10, safetyMarginSecs: 30 });
    oracle.start();
    const id = sim.request(label('g'), label('later'), BigInt(sim.now + 600));
    for (let i = 0; i < 50 && sim.getLedger().requests.lookup(id).status !== Status.fulfilled; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await oracle.stop();
    expect(sim.getLedger().requests.lookup(id).status).toBe(Status.fulfilled);
  });
});

describe('selectWork', () => {
  it('orders by deadline and splits off late requests', () => {
    const key = { x: 1n, y: 2n };
    const mk = (id: number, deadline: bigint, status = Status.pending, k = key) => ({
      id: new Uint8Array([id]),
      request: {
        status,
        requester: new Uint8Array(32),
        tag: new Uint8Array(32),
        point: { x: 0n, y: 1n },
        oracleKey: k,
        deadline,
        output: new Uint8Array(32),
      },
    });
    const { todo, tooLate } = selectWork(
      [mk(1, 500n), mk(2, 200n), mk(3, 120n), mk(4, 400n, Status.fulfilled), mk(5, 300n, Status.pending, { x: 9n, y: 9n })],
      key,
      100,
      30,
    );
    expect(todo.map((e) => e.id[0])).toEqual([2, 1]);
    expect(tooLate.map((e) => e.id[0])).toEqual([3]);
  });
});

describe('keygen', () => {
  it('produces matching public values for each role', () => {
    const o = generateSecret('oracle');
    const pk = oraclePublicKey(BigInt('0x' + o.secret));
    expect(o.public).toEqual({ x: pk.x.toString(), y: pk.y.toString() });
    const op = generateSecret('operator');
    expect(op.public).toBe(hex(pureCircuits.operatorCommitmentOf(Buffer.from(op.secret, 'hex'))));
    const rq = generateSecret('requester');
    expect(rq.public).toBe(hex(pureCircuits.requesterCommitmentOf(Buffer.from(rq.secret, 'hex'))));
  });

  it('writes a private file and never overwrites one', () => {
    const cli = fileURLToPath(new URL('../../dist/keygen.js', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'nightcast-'));
    const out = join(dir, 'oracle.secret');
    execFileSync(process.execPath, [cli, 'oracle', '--out', out]);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(out, 'utf8')).role).toBe('oracle');

    const existing = join(dir, 'existing.secret');
    writeFileSync(existing, 'keep me');
    expect(() => execFileSync(process.execPath, [cli, 'operator', '--out', existing], { stdio: 'pipe' })).toThrow();
    expect(readFileSync(existing, 'utf8')).toBe('keep me');
  });
});

describe('uniformInt bounds', () => {
  it('rejects ranges it cannot sample', () => {
    expect(() => uniformInt(new Uint8Array(32), (1n << 256n) + 1n)).toThrow();
    expect(() => uniformInt(new Uint8Array(32), 0n)).toThrow();
  });
});
