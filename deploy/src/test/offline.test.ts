import { describe, it, expect } from 'vitest';
import { generateOperatorSecret, generateOracleSecretKey, NightcastSimulator, oraclePublicKey } from '@nightcast/contract';
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
