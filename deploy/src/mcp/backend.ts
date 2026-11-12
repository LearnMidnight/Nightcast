/**
 * The MCP tools' view of a real Nightcast deployment: requests through this
 * server's wallet (when it has one), reads and checks from the indexer.
 */
import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import { ledgerOf, Nightcast, pureCircuits } from '@nightcast/contract';
import { checkRequest } from '../check.js';
import { type Fingerprints, localFingerprints } from '../fingerprints.js';
import { compiledNightcast, NIGHTCAST_PRIVATE_STATE_ID, type NightcastProviders, readContractState } from '../network.js';
import type { DeploymentRecord } from '../record.js';
import { cachedReader, stateCacheSecs } from '../state-cache.js';
import type { RandomnessBackend } from './tools.js';

const localOrNone = (): Fingerprints | undefined => {
  try {
    return localFingerprints();
  } catch {
    return undefined;
  }
};

export const midnightBackend = (
  network: string,
  record: DeploymentRecord,
  publicData: PublicDataProvider,
  requester?: {
    secret: Uint8Array;
    /** Where a missed request's fee and collateral go: this server's wallet (known once it's open). */
    refundTo: Promise<Uint8Array>;
    /** The wallet's providers, once the wallet is open (it can take minutes). */
    providers: Promise<NightcastProviders>;
    onSubmitError?: (err: unknown) => void;
    onSubmitted?: () => void;
  },
  /** How long one read of the contract's state answers every check (NIGHTCAST_STATE_CACHE_SECS, default 15 s; 0 = no sharing). */
  stateCacheMs: number = stateCacheSecs() * 1000,
): RandomnessBackend => {
  let opened: NightcastProviders | undefined;
  let openError: string | undefined;
  requester?.providers.then(
    (p) => (opened = p),
    (e: unknown) => (openError = e instanceof Error ? e.message : String(e)),
  );
  const deployment = { bytes: encodeContractAddress(record.contractAddress) };
  const commitment = requester ? pureCircuits.requesterCommitmentOf(requester.secret) : new Uint8Array(32);
  const local = localOrNone();
  // The state holds every request: one read answers every check in the window (state-cache.ts).
  const readState = cachedReader(() => readContractState(publicData, record.contractAddress), stateCacheMs);
  let contract: Promise<Awaited<ReturnType<typeof findDeployedContract>>> | undefined;
  const handle = () =>
    (contract ??= findDeployedContract(opened!, {
      contractAddress: record.contractAddress,
      compiledContract: compiledNightcast(),
      privateStateId: NIGHTCAST_PRIVATE_STATE_ID,
      initialPrivateState: { requesterSecret: requester!.secret },
    } as never).catch((err) => {
      contract = undefined;
      throw err;
    }) as never);
  return {
    network,
    contractAddress: record.contractAddress,
    minWindow: Number(record.parameters.minWindow),
    maxWindow: Number(record.parameters.maxWindow),
    requestFee: BigInt(record.parameters.requestFee ?? '0'),
    collateralPerRequest: BigInt(record.parameters.collateralPerRequest ?? '0'),
    canRequest: requester !== undefined,
    notReady: () => (!requester ? undefined : openError ? `the wallet could not open (${openError})` : opened ? undefined : "this server's wallet is still opening and syncing"),
    idFor: (tag, seed) => pureCircuits.requestId(deployment, commitment, tag, seed),
    async submit(tag, seed, deadline) {
      if (!requester) throw new Error('this server has no wallet');
      if (!opened) throw new Error("this server's wallet is still opening");
      try {
        const c = (await handle()) as unknown as {
          callTx: { request(t: Uint8Array, s: Uint8Array, d: bigint, refundTo: { bytes: Uint8Array }): Promise<{ public: { txId: string } }> };
        };
        // A missed request's fee and collateral come back to this server's wallet.
        const r = await c.callTx.request(tag, seed, deadline, { bytes: await requester.refundTo });
        requester.onSubmitted?.();
        return { txId: r.public.txId };
      } catch (err) {
        requester.onSubmitError?.(err);
        throw err;
      }
    },
    async read(id, inputs) {
      const state = await readState();
      const requests = state ? ledgerOf(state).requests : undefined;
      const request = requests?.member(id) ? requests.lookup(id) : undefined;
      const checks = checkRequest(record, state as never, id, request, { inputs, local });
      return { request, checks };
    },
    now: () => Date.now() / 1000,
    stateReads: readState.reads,
  };
};
