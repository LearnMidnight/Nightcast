import { webcrypto } from 'node:crypto';
import type { Logger } from 'pino';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { Nightcast, oraclePublicKey, type Request, Status } from '@nightcast/contract';
import { MidnightChain, NightcastOracle, type OracleOptions } from '@nightcast/sdk';
import { compiledNightcast, NIGHTCAST_PRIVATE_STATE_ID, type NightcastProviders } from './network.js';

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
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) throw new Error(`no Nightcast contract at ${contractAddress}`);
  const ledger = Nightcast.ledger(state.data);
  const pk = oraclePublicKey(secretKey);
  if (!ledger.oracleKeyReady) {
    throw new Error('the oracle key is not active yet: run `nightcast-deploy accept-key` first');
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
  const chain = new MidnightChain(nightcast, providers.publicDataProvider, contractAddress);
  const oracle = new NightcastOracle({
    chain,
    secretKey,
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

export type SubmittedRequest = { id: Uint8Array; tag: Uint8Array; seed: Uint8Array; deadline: bigint; txId: string };

/** Make a request as the holder of `requesterSecret`. The seed is random. */
export const submitRequest = async (
  providers: NightcastProviders,
  contractAddress: string,
  requesterSecret: Uint8Array,
  opts: { tag?: string; deadlineSecs?: number } = {},
): Promise<SubmittedRequest> => {
  const nightcast = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: compiledNightcast(),
    privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
    initialPrivateState: { requesterSecret },
  });
  const tag = textLabel(opts.tag ?? 'nightcast-test');
  const seed = webcrypto.getRandomValues(new Uint8Array(32));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSecs ?? 30 * 60));
  const result = await nightcast.callTx.request(tag, seed, deadline);
  return { id: result.private.result, tag, seed, deadline, txId: result.public.txId };
};

/** Read a request from public chain data. */
export const readRequest = async (
  providers: Pick<NightcastProviders, 'publicDataProvider'>,
  contractAddress: string,
  id: Uint8Array,
): Promise<Request | undefined> => {
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!state) throw new Error(`no Nightcast contract at ${contractAddress}`);
  const requests = Nightcast.ledger(state.data).requests;
  return requests.member(id) ? requests.lookup(id) : undefined;
};

/** Poll until the request is fulfilled or expired (or `timeoutMs` passes). */
export const waitForResult = async (
  providers: Pick<NightcastProviders, 'publicDataProvider'>,
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
