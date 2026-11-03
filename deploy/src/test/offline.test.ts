import { describe, it, expect } from 'vitest';
import { generateOperatorSecret, generateOracleSecretKey, NightcastSimulator, oraclePublicKey } from '@nightcast/contract';
import { checkRequest } from '../check.js';
import { compareFingerprints, onChainFingerprints } from '../fingerprints.js';
import { isLocked } from '../lock.js';
import { blockfrostProjectId, createLogger, publicEndpoints, redact } from '../network.js';
import type { DeploymentRecord } from '../record.js';
import { type ContractStateView, verifyDeployment } from '../verify.js';

const vk = (s: string) => new TextEncoder().encode(s);

const fakeState = (opts: {
  committee: number;
  threshold: number;
  keys: Record<string, string>;
  acceptKey?: boolean;
  /** Propose a replacement key after accepting the first. */
  proposeKey?: boolean;
  sk?: bigint;
}): { state: ContractStateView; sk: bigint } => {
  const sk = opts.sk ?? generateOracleSecretKey();
  const sim = new NightcastSimulator({
    oracleSecretKey: sk,
    operatorSecret: generateOperatorSecret(),
    minWindow: 60n,
    maxWindow: 86_400n,
    acceptKey: opts.acceptKey ?? true,
  });
  if (opts.proposeKey) sim.proposeOracleKey(oraclePublicKey(generateOracleSecretKey()));
  const state: ContractStateView = {
    maintenanceAuthority: { committee: Array(opts.committee).fill('k'), threshold: opts.threshold, counter: 1n },
    operations: () => Object.keys(opts.keys),
    operation: (name) => ({ verifierKey: vk(opts.keys[name as string]) }),
    data: sim.publicState(),
  };
  return { state, sk };
};

const recordFor = (sk: bigint, verifierKeys: Record<string, string>): DeploymentRecord => {
  const pk = oraclePublicKey(sk);
  return {
    network: 'local',
    contractAddress: 'addr',
    deployedAt: '2026-10-20T00:00:00Z',
    compiler: { compiler: '0.31.1', language: '0.23.0', runtime: '0.16.0' },
    parameters: { oraclePublicKey: { x: pk.x.toString(), y: pk.y.toString() }, operatorCommitment: '00', minWindow: '60', maxWindow: '86400' },
    transactions: {},
    verifierKeys,
  };
};

describe('isLocked', () => {
  it('is true only when the threshold exceeds the committee', () => {
    expect(isLocked({ committee: [], threshold: 1, counter: 1n })).toBe(true);
    expect(isLocked({ committee: ['a'], threshold: 2, counter: 1n })).toBe(true);
    expect(isLocked({ committee: ['a'], threshold: 1, counter: 0n })).toBe(false);
    expect(isLocked({ committee: ['a', 'b'], threshold: 2, counter: 0n })).toBe(false);
  });
});

describe('fingerprints', () => {
  it('hashes on-chain verifier keys and reports differences', () => {
    const chain = onChainFingerprints({
      operations: () => ['fulfil', 'request'],
      operation: (n) => ({ verifierKey: vk(`key-${String(n)}`) }),
    });
    expect(Object.keys(chain)).toEqual(['fulfil', 'request']);
    expect(chain.fulfil).toMatch(/^[0-9a-f]{64}$/);
    expect(compareFingerprints(chain, chain)).toEqual([]);
    expect(compareFingerprints({ ...chain, expire: 'x' }, chain)).toEqual(['expire: missing']);
    expect(compareFingerprints(chain, { ...chain, request: 'y' })).toEqual([`request: y (expected ${chain.request})`]);
    expect(compareFingerprints({ fulfil: chain.fulfil }, chain)).toEqual(['request: unexpected circuit']);
  });
});

describe('verifyDeployment', () => {
  const keys = { fulfil: 'kf', request: 'kr' };
  const fps = onChainFingerprints({ operations: () => Object.keys(keys), operation: (n) => ({ verifierKey: vk(keys[n as 'fulfil']) }) });

  it('passes a locked deployment with the published keys and an active oracle key', () => {
    const { state, sk } = fakeState({ committee: 0, threshold: 1, keys });
    const checks = verifyDeployment(recordFor(sk, fps), state, fps);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('fails when the authority can still sign', () => {
    const { state, sk } = fakeState({ committee: 1, threshold: 1, keys });
    const failed = verifyDeployment(recordFor(sk, fps), state).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(['maintenance authority locked']);
  });

  it('fails when a verifier key was swapped', () => {
    const { state, sk } = fakeState({ committee: 0, threshold: 1, keys: { ...keys, fulfil: 'evil' } });
    const failed = verifyDeployment(recordFor(sk, fps), state).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(['verifier keys match the published fingerprints']);
  });

  it('fails when the oracle has not accepted its key', () => {
    const { state, sk } = fakeState({ committee: 0, threshold: 1, keys, acceptKey: false });
    const failed = verifyDeployment(recordFor(sk, fps), state).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(['oracle key accepted']);
  });

  it('reports a pending oracle key change', () => {
    const { state, sk } = fakeState({ committee: 0, threshold: 1, keys, proposeKey: true });
    const checks = verifyDeployment(recordFor(sk, fps), state);
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['no oracle key change pending']);
    expect(checks.find((c) => c.name === 'no oracle key change pending')?.detail).toMatch(/can take effect from/);
  });

  it('reports a missing contract', () => {
    expect(verifyDeployment(recordFor(1n, fps), null)).toEqual([
      { name: 'contract exists', ok: false, detail: 'nothing at addr' },
    ]);
  });
});

describe('Blockfrost endpoints', () => {
  const logger = createLogger('silent');

  it('adds the project id to every Preprod endpoint', () => {
    const c = publicEndpoints('preprod', logger, 'preprodABC123');
    for (const url of [c.indexer, c.indexerWS, c.node, c.nodeWS]) {
      expect(url).toContain('blockfrost.io');
      expect(new URL(url).searchParams.get('project_id')).toBe('preprodABC123');
    }
    expect(new URL(c.indexerWS).pathname).toBe('/api/v0/ws');
    expect(c.networkId).toBe('preprod');
  });

  it('explains how to get a project id when there is none', () => {
    expect(() => publicEndpoints('preprod', logger)).toThrow(/blockfrost save/);
  });

  it('needs no project id for Preview', () => {
    expect(publicEndpoints('preview', logger).indexer).toContain('indexer.preview.midnight.network');
  });

  it('hides project ids in text', () => {
    expect(redact('wss://x/api/v0/ws?project_id=preprodSECRET&a=1 failed')).toBe('wss://x/api/v0/ws?project_id=***&a=1 failed');
    expect(redact('see https://x?project_id=abc)')).toBe('see https://x?project_id=***)');
  });

  it('reads the project id from the environment first', () => {
    process.env.NIGHTCAST_BLOCKFROST_PROJECT_ID = ' fromEnv ';
    try {
      expect(blockfrostProjectId('preprod', '/does/not/exist')).toBe('fromEnv');
    } finally {
      delete process.env.NIGHTCAST_BLOCKFROST_PROJECT_ID;
    }
    expect(() => blockfrostProjectId('preprod', '/does/not/exist')).toThrow(/does not exist/);
  });
});

describe('output redaction', () => {
  it('hides project ids written straight to a stream, as text or bytes', async () => {
    const { redactingWrite } = await import('../redact-output.js');
    const seen: unknown[] = [];
    const write = redactingWrite(((chunk: unknown) => {
      seen.push(chunk);
      return true;
    }) as typeof process.stdout.write);
    write('RPC-CORE: disconnected from wss://rpc.x/?project_id=nightpreprodABC: 1000\n');
    write(Buffer.from('url https://x/api/v0?project_id=nightpreprodXYZ&a=1'));
    write('nothing secret here');
    expect(seen).toEqual([
      'RPC-CORE: disconnected from wss://rpc.x/?project_id=***: 1000\n',
      'url https://x/api/v0?project_id=***&a=1',
      'nothing secret here',
    ]);
  });

  it('is installed on stdout and stderr by the CLI', async () => {
    const cli = await import('node:fs').then((fs) => fs.readFileSync(new URL('../cli.ts', import.meta.url), 'utf8'));
    expect(cli.indexOf("import './redact-output.js'")).toBeLessThan(cli.indexOf("from '@midnight-ntwrk"));
  });
});

describe('wallet error messages', () => {
  // Shaped like the SDK's errors: a tagged error whose message is an object.
  const syncError = (message: unknown, cause?: unknown) =>
    Object.assign(new Error(String(message)), { _tag: 'Wallet.Sync', message, ...(cause ? { cause } : {}) });

  it('finds the reason inside an object message', async () => {
    const { describeWalletError } = await import('../explain-errors.js');
    const err = syncError({ message: 'Unexpected server response: 429', error: new Error('Too Many Requests') });
    expect(describeWalletError(err)).toBe('Unexpected server response: 429: Too Many Requests');
  });

  it('describes a closed WebSocket and a GraphQL error list', async () => {
    const { describeWalletError } = await import('../explain-errors.js');
    expect(describeWalletError(syncError({ code: 1006, reason: '' }))).toBe('connection closed (code 1006)');
    expect(describeWalletError(syncError({ errors: [{ message: 'daily request limit reached' }] }))).toBe(
      'daily request limit reached',
    );
  });

  it('shows a plain object when there is no message to read', async () => {
    const { describeWalletError } = await import('../explain-errors.js');
    expect(describeWalletError(syncError({ status: 503 }))).toBe('{ status: 503 }');
  });

  it('replaces the SDK print with one line, and counts repeats', async () => {
    const { wrapConsoleError } = await import('../explain-errors.js');
    const lines: string[] = [];
    const print = wrapConsoleError((...args: unknown[]) => lines.push(args.map(String).join(' ')));
    const err = syncError({ message: 'socket hang up' });
    for (let i = 0; i < 10; i++) print(err);
    print('something else', 42);
    expect(lines).toEqual([
      'Wallet sync problem: socket hang up. The wallet retries by itself.',
      'Wallet sync problem: socket hang up (seen 10 times; the wallet keeps retrying)',
      'something else 42',
    ]);
  });
});

describe('checkRequest', () => {
  const keys = { expire: 'ke', fulfil: 'kf', request: 'kr' };
  const fps = onChainFingerprints({ operations: () => Object.keys(keys), operation: (n) => ({ verifierKey: vk(keys[n as 'fulfil']) }) });
  const label = (t: string) => {
    const b = new Uint8Array(32);
    b.set(new TextEncoder().encode(t));
    return b;
  };
  const setup = () => {
    const sk = generateOracleSecretKey();
    const sim = new NightcastSimulator({ oracleSecretKey: sk, operatorSecret: generateOperatorSecret(), minWindow: 60n, maxWindow: 86_400n });
    const record = { ...recordFor(sk, fps), contractAddress: sim.address };
    const view = (): ContractStateView => ({
      maintenanceAuthority: { committee: [], threshold: 1, counter: 1n },
      operations: () => Object.keys(keys),
      operation: (name) => ({ verifierKey: vk(keys[name as 'fulfil']) }),
      data: sim.publicState(),
    });
    const tag = label('selftest');
    const seed = label('seed-1');
    const id = sim.request(tag, seed, BigInt(sim.now + 600));
    const lookup = () => sim.getLedger().requests.lookup(id);
    return { sk, sim, record, view, tag, seed, id, lookup };
  };
  const failing = (checks: { name: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.name);

  it('passes a fulfilled request, including the id from its tag and seed', () => {
    const { sk, sim, record, view, tag, seed, id, lookup } = setup();
    sim.fulfil(id, { oracleSecretKey: sk });
    const checks = checkRequest(record, view(), id, lookup(), { inputs: { tag, seed }, local: fps });
    expect(failing(checks)).toEqual([]);
    expect(checks.map((c) => c.name)).toContain('id matches the tag and seed');
    expect(checks.map((c) => c.name)).toContain('input fixed by the request id');
  });

  it('notices a wrong seed, an unanswered request and a missing one', () => {
    const { sk, sim, record, view, tag, id, lookup } = setup();
    expect(failing(checkRequest(record, view(), id, lookup(), { deployment: false }))).toEqual(['answered']);
    sim.fulfil(id, { oracleSecretKey: sk });
    expect(failing(checkRequest(record, view(), id, lookup(), { inputs: { tag, seed: label('other') }, deployment: false }))).toEqual([
      'id matches the tag and seed',
    ]);
    expect(failing(checkRequest(record, view(), label('nope'), undefined, { deployment: false }))).toEqual(['request exists']);
  });

  it('checks an expired request, and says to void rather than redraw', () => {
    const { sim, record, view, id, lookup } = setup();
    sim.advance(601);
    sim.expire(id);
    expect(failing(checkRequest(record, view(), id, lookup(), { expect: 'expired', deployment: false }))).toEqual([]);
    const asFulfilled = checkRequest(record, view(), id, lookup(), { deployment: false });
    expect(asFulfilled.find((c) => c.name === 'answered')?.detail).toMatch(/voided, never redrawn/);
  });
});

describe('dust fee-loop patch for other projects', () => {
  it('patches the dust wallet under a --root folder, once', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdirSync, mkdtempSync: mkd, readFileSync: read, writeFileSync } = await import('node:fs');
    const { join: j } = await import('node:path');
    const { tmpdir: tmp } = await import('node:os');
    const { fileURLToPath } = await import('node:url');
    const project = mkd(j(tmp(), 'consumer-'));
    const dist = j(project, 'node_modules', '@midnight-ntwrk', 'wallet-sdk-dust-wallet', 'dist', 'v1');
    mkdirSync(dist, { recursive: true });
    const file = j(dist, 'Transacting.js');
    writeFileSync(file, "const recipe = (currentFee) => fromEntry('dust', currentFee); // computeBalancingRecipe\n");
    const script = fileURLToPath(new URL('../../scripts/patch-dust-fee-loop.mjs', import.meta.url));
    execFileSync(process.execPath, [script, '--quiet', '--root', project, '--root', project]);
    const patched = read(file, 'utf8');
    expect(patched).toContain('/* nightcast: dust fee-loop fix */ (currentFee > 0n ? -currentFee : currentFee)');
    execFileSync(process.execPath, [script, '--check', '--root', project]);
    expect(read(file, 'utf8')).toBe(patched);
  });
});

describe('agent support', () => {
  it('finds every message in an error, including one behind a symbol key (Effect\'s FiberFailure)', async () => {
    const { errorMessages } = await import('../wallet.js');
    const inner = new Error('disconnected from wss://node: 1006:: Abnormal Closure');
    const tagged = Object.assign(new Error('Transaction submission error'), { cause: { _tag: 'SubmissionError', message: 'Transaction submission error', cause: inner } });
    const failure = Object.assign(new Error('(FiberFailure) SubmissionError: Transaction submission error\n    at file:///x.js:1:1'), { [Symbol.for('effect/Runtime/FiberFailure/Cause')]: { _tag: 'Fail', error: tagged } });
    expect(errorMessages(failure)).toEqual(['(FiberFailure) SubmissionError: Transaction submission error', 'Transaction submission error', 'disconnected from wss://node: 1006:: Abnormal Closure']);
    expect(errorMessages('plain')).toEqual(['plain']);
  });

  it('sends a transaction steadily: a fresh connection per try, a time limit, and the chain or the node already having it counts', async () => {
    const { steadySubmissionService } = await import('../wallet.js');
    const tx = { identifiers: () => ['a', 'tx-1'] };
    const url = new URL('wss://node.example');
    const made: string[] = [];
    const service = (answer: () => Promise<unknown>) => ({ submitTransaction: answer, close: async () => void made.push('closed') });
    const hangs = () => new Promise<never>(() => undefined);
    const logs: string[] = [];

    // the first try hangs, the second gets through
    let n = 0;
    const s1 = steadySubmissionService(url, { settleMs: 0, tryMs: 20, log: (m) => logs.push(m), make: () => (made.push('made'), service(++n === 1 ? hangs : async () => ({ _tag: 'InBlock' }))) });
    expect(await s1.submitTransaction(tx, 'Finalized')).toEqual({ _tag: 'InBlock' });
    // and the next connection is made ahead of time, ready for the next transaction
    expect(made).toEqual(['made', 'closed', 'made', 'closed', 'made']);
    expect(logs[0]).toMatch(/no answer from the node within 0 s.*trying again on a fresh connection \(2 of 3\)/);

    // a new connection is given time to settle before it sends (#327: a send right after
    // it's made goes out on a closing socket); the one made ahead of time is ready sooner
    let clock = 1_000;
    const waits: number[] = [];
    const s0 = steadySubmissionService(url, {
      settleMs: 8_000,
      now: () => clock,
      sleep: async (ms) => void (waits.push(ms), (clock += ms)),
      make: () => service(async () => ({ _tag: 'InBlock' })),
    });
    await s0.submitTransaction(tx);
    clock += 3_000; // the next purchase comes along 3 s later
    await s0.submitTransaction(tx);
    expect(waits).toEqual([8_000, 5_000]);

    // the node says it already has it: sent
    const s2 = steadySubmissionService(url, { settleMs: 0, tryMs: 20, make: () => service(async () => Promise.reject(new Error('submission failed', { cause: new Error('1013: Transaction Already Imported') }))) });
    expect(await s2.submitTransaction(tx)).toEqual({ _tag: 'Submitted' });

    // the answer was lost but the chain has it
    const seen: string[] = [];
    const s3 = steadySubmissionService(url, { settleMs: 0, tryMs: 20, seen: async (id) => (seen.push(id), true), make: () => service(hangs) });
    expect(await s3.submitTransaction(tx)).toEqual({ _tag: 'InBlock' });
    expect(seen).toEqual(['tx-1']);

    // the node refuses it: no point sending it again, the refusal goes straight back
    let tries = 0;
    const refusal = new Error('Transaction submission error', { cause: new Error('1010: Invalid Transaction: Custom error: 170') });
    const s4 = steadySubmissionService(url, { settleMs: 0, tries: 3, tryMs: 20, seen: async () => false, make: () => (tries++, service(async () => Promise.reject(refusal))) });
    await expect(s4.submitTransaction(tx)).rejects.toBe(refusal);
    expect(tries).toBe(1);

    // never gets through on the connection: the last error, after every try
    tries = 0;
    const s5 = steadySubmissionService(url, { settleMs: 0, tries: 2, tryMs: 20, seen: async () => false, make: () => (tries++, service(async () => Promise.reject(new Error('disconnected from wss://node: 1006:: Abnormal Closure')))) });
    await expect(s5.submitTransaction(tx)).rejects.toThrow('1006:: Abnormal Closure');
    expect(tries).toBe(2);
  });

  it("keeps the in-process prover's keys on disk: downloaded once, refused when the server sends an error", async () => {
    const { mkdtempSync, existsSync: exists, readFileSync: readBytes } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: joinPath } = await import('node:path');
    const { diskKeyMaterialProvider } = await import('../wallet.js');
    const dir = mkdtempSync(joinPath(tmpdir(), 'keys-'));
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return new Response(new TextEncoder().encode(`bytes of ${url.replace('https://s3.example/', '')}`));
    }) as unknown as typeof fetch;
    const kmp = diskKeyMaterialProvider(dir, 'https://s3.example', fetcher) as unknown as {
      lookupKey(l: string): Promise<{ proverKey: Uint8Array; verifierKey: Uint8Array; ir: Uint8Array } | undefined>;
      getParams(k: number): Promise<Uint8Array>;
    };
    const key = await kmp.lookupKey('midnight/dust/spend');
    expect(new TextDecoder().decode(key!.proverKey)).toBe('bytes of dust/9/spend.prover');
    expect(urls.sort()).toEqual(['https://s3.example/dust/9/spend.bzkir', 'https://s3.example/dust/9/spend.prover', 'https://s3.example/dust/9/spend.verifier']);
    expect(new TextDecoder().decode(await kmp.getParams(14))).toBe('bytes of bls_midnight_2p14');
    expect(exists(joinPath(dir, 'dust/9/spend.prover'))).toBe(true);
    expect(await kmp.lookupKey('midnight/unknown')).toBeUndefined();
    // a new provider (a new run) reads the disk, not the network
    urls.length = 0;
    const again = diskKeyMaterialProvider(dir, 'https://s3.example', fetcher) as unknown as typeof kmp;
    expect(new TextDecoder().decode((await again.lookupKey('midnight/dust/spend'))!.ir)).toBe('bytes of dust/9/spend.bzkir');
    expect(urls).toEqual([]);
    expect(readBytes(joinPath(dir, 'bls_midnight_2p14'), 'utf8')).toBe('bytes of bls_midnight_2p14');
    // an error page is not a key
    const denied = (async () => new Response('AccessDenied', { status: 403 })) as unknown as typeof fetch;
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => real(fn, 0)) as typeof setTimeout;
    try {
      const bad = diskKeyMaterialProvider(mkdtempSync(joinPath(tmpdir(), 'keys-')), 'https://s3.example', denied) as unknown as typeof kmp;
      await expect(bad.getParams(10)).rejects.toThrow(/HTTP 403/);
    } finally {
      globalThis.setTimeout = real;
    }
  });

  it("gives a wallet's address from its seed without the network", async () => {
    const { walletAddressOf } = await import('../network.js');
    const seed = 'ab'.repeat(32);
    const a = walletAddressOf('preprod', seed);
    expect(a).toMatch(/^mn_addr_preprod1[0-9a-z]+$/);
    expect(walletAddressOf('preprod', seed)).toBe(a);
    expect(walletAddressOf('preview', seed)).toMatch(/^mn_addr_preview1/);
    expect(walletAddressOf('preprod', 'cd'.repeat(32))).not.toBe(a);
  });
});
