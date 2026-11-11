import { webcrypto } from 'node:crypto';
import type { Logger } from 'pino';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { ledgerOf, oraclePublicKey, type Request, Status } from '@nightcast/contract';
import { MidnightChain, NightcastOracle, type OracleOptions } from '@nightcast/sdk';
import { compiledNightcast, decodeContractState, decodedPublicData, NIGHTCAST_PRIVATE_STATE_ID, type NightcastProviders, readContractState } from './network.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** A 32-byte label from text (UTF-8, zero-padded, truncated to 32 bytes). */
export const textLabel = (text: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(text).slice(0, 32));
  return out;
};

export type RunningOracle = {
  oracle: NightcastOracle;
  stop(): Promise<void>;
};

/**
 * Join a deployment as its oracle and start answering requests. Checks first
 * that the contract's active key is this oracle's key.
 */
export const startOracleService = async (
  providers: NightcastProviders,
  contractAddress: string,
  secretKey: bigint,
  logger: Logger,
  options: Pick<OracleOptions, 'pollMs' | 'safetyMarginSecs' | 'requesters'> = {},
): Promise<RunningOracle> => {
  const state = await readContractState(providers.publicDataProvider, contractAddress);
  if (!state) throw new Error(`no Nightcast contract at ${contractAddress}`);
  const ledger = ledgerOf(state);
  const pk = oraclePublicKey(secretKey);
  if (!ledger.oracleKeyReady) {
    throw new Error('the oracle key is not active yet: run `./nightcast accept-key` first');
  }
  if (ledger.oracleKey.x !== pk.x || ledger.oracleKey.y !== pk.y) {
    logger.warn('this key is not the contract\'s current oracle key; only requests bound to it will be answered');
  }

  const nightcast = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiledNightcast(),
    privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
    initialPrivateState: { oracleSecretKey: secretKey },
  });
  const chain = new MidnightChain(nightcast, decodedPublicData(providers.publicDataProvider), contractAddress);
  // `expire` is a small call: on ledger 9 its fee needs two DUST spends (see withTwoDustSpends).
  const expire = chain.expire.bind(chain);
  chain.expire = (id) => withTwoDustSpends(() => expire(id));
  const oracle = new NightcastOracle({
    chain,
    secretKey,
    // The oracle hands back what it owes for a request it missed (NIGHTCAST_EXPIRE_MISSED=0 turns that off).
    expireMissed: process.env.NIGHTCAST_EXPIRE_MISSED !== '0',
    logger: {
      info: (m) => logger.info(m),
      warn: (m) => logger.warn(m),
      error: (m) => logger.error(m),
    },
    ...options,
  });
  oracle.start();
  logger.info(`Oracle running for ${contractAddress}; polling every ${(options.pollMs ?? 5_000) / 1000}s`);
  return { oracle, stop: () => oracle.stop() };
};

/**
 * Run one transaction with its fee paid by two DUST spends where the wallet
 * has two coins (NIGHTCAST_DUST_MIN_SPENDS=2, patch-dust-two-spends.mjs).
 * Ledger 9 refuses a small call paid with exactly one spend (1010, custom
 * error 231). For the small calls only: expire and the bond's deposit and
 * withdrawal. The setting is the process's, so callers run one at a time.
 */
export const withTwoDustSpends = async <T>(run: () => Promise<T>): Promise<T> => {
  const before = process.env.NIGHTCAST_DUST_MIN_SPENDS;
  if (before === undefined) process.env.NIGHTCAST_DUST_MIN_SPENDS = '2';
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.NIGHTCAST_DUST_MIN_SPENDS;
  }
};

export type SubmittedRequest = { id: Uint8Array; tag: Uint8Array; seed: Uint8Array; deadline: bigint; txId: string };

/**
 * Make a request as the holder of `requesterSecret`. The seed is random unless
 * given (a raffle passes its list's fingerprint, listCommitment, so the
 * answer is bound to that list).
 */
export const submitRequest = async (
  providers: NightcastProviders,
  contractAddress: string,
  requesterSecret: Uint8Array,
  opts: { tag?: string; deadlineSecs?: number; seed?: Uint8Array; refundTo: Uint8Array },
): Promise<SubmittedRequest> => {
  const nightcast = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiledNightcast(),
    privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
    initialPrivateState: { requesterSecret },
  });
  const tag = textLabel(opts.tag ?? 'nightcast-test');
  const seed = opts.seed ?? webcrypto.getRandomValues(new Uint8Array(32));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSecs ?? 30 * 60));
  const result = await nightcast.callTx.request(tag, seed, deadline, { bytes: opts.refundTo });
  return { id: result.private.result, tag, seed, deadline, txId: result.public.txId };
};

/** Mark a missed request as expired (anyone may, once its deadline has passed). */
export const expireRequest = async (
  providers: NightcastProviders,
  contractAddress: string,
  id: Uint8Array,
): Promise<string> => {
  const nightcast = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiledNightcast(),
    privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
    initialPrivateState: {},
  });
  const result = await nightcast.callTx.expire(id);
  return result.public.txId;
};

/** Read a request from public chain data. */
export const readRequest = async (
  providers: { publicDataProvider: Pick<NightcastProviders['publicDataProvider'], 'queryContractState'> | ReturnType<typeof decodedPublicData> },
  contractAddress: string,
  id: Uint8Array,
): Promise<Request | undefined> => {
  const read = await providers.publicDataProvider.queryContractState(contractAddress);
  const state = read && 'contractState' in read ? decodeContractState(read) : read;
  if (!state) throw new Error(`no Nightcast contract at ${contractAddress}`);
  const requests = ledgerOf(state).requests;
  return requests.member(id) ? requests.lookup(id) : undefined;
};

/** Poll until the request is fulfilled or expired (or `timeoutMs` passes). */
export const waitForResult = async (
  providers: Parameters<typeof readRequest>[0],
  contractAddress: string,
  id: Uint8Array,
  opts: { pollMs?: number; timeoutMs?: number; onPoll?: (r: Request | undefined) => void } = {},
): Promise<Request | undefined> => {
  const end = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  for (;;) {
    const r = await readRequest(providers, contractAddress, id);
    opts.onPoll?.(r);
    if (r && r.status !== Status.pending) return r;
    if (Date.now() > end) return r;
    await new Promise((res) => setTimeout(res, opts.pollMs ?? 10_000));
  }
};

export const describeRequest = (id: Uint8Array, r: Request | undefined): string => {
  if (!r) return `request ${hex(id)}: not found`;
  const status = ['pending', 'fulfilled', 'expired'][r.status] ?? String(r.status);
  const lines = [
    `request  ${hex(id)}`,
    `status   ${status}`,
    `deadline ${new Date(Number(r.deadline) * 1000).toISOString()}`,
  ];
  if (r.status === Status.fulfilled) lines.push(`output   ${hex(r.output)}`);
  return lines.join('\n');
};
