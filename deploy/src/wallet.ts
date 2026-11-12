/**
 * Build a Midnight wallet that remembers how far it has synced.
 *
 * A new wallet reads the whole chain (hundreds of thousands of events on the
 * public test networks, which takes hours), and the testkit's wallet starts
 * from zero every time. This builds the same wallet, but restores the saved
 * state of its three parts (shielded, unshielded, dust) when there is one, and
 * can save it again. The saved state holds public keys, coins and the sync
 * position: no spending keys, but it is still private, so it lives in
 * ~/nightcast-secrets with mode 600.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import {
  Capabilities,
  createKeystore,
  DefaultForkSchedule,
  DustWallet,
  InMemoryTransactionHistoryStorage,
  mergeWalletEntries,
  PublicKey,
  type ResolvedConfiguration,
  ShieldedWallet,
  UnshieldedWallet,
  WalletEntrySchema,
  WalletFacade,
} from '@midnightntwrk/wallet-sdk';
import {
  DEFAULT_DUST_OPTIONS,
  type EnvironmentConfiguration,
  MidnightWalletProvider,
  WalletSeeds,
} from '@midnight-ntwrk/testkit-js';

type SavedWallet = {
  /** 2 since the ledger 9 hard fork (wallet SDK 2); a version 1 save is from the ledger 8 wallet and is not used. */
  version: 2;
  network: string;
  savedAt: string;
  shielded: string;
  unshielded: string;
  dust: string;
};

/** A wallet's unshielded address (mn_addr_...) from its seed, offline. */
export const addressFromSeed = (seed: string, walletNetworkId: Parameters<typeof createKeystore>[1]): string =>
  createKeystore({ kind: 'schnorr', secret: WalletSeeds.fromMasterSeed(seed).unshielded }, walletNetworkId).getBech32Address().asString();

/**
 * Where the wallet SDK's in-process prover keeps the keys and parameters it
 * downloads (NIGHTCAST_KEY_CACHE overrides it). Since wallet SDK 2 the SDK's
 * own key material provider fetches ledger 9's keys from srs.midnight.network,
 * checksummed, so Nightcast no longer keeps its own copy on disk; the folder
 * is only cleaned up by `wallet forget`.
 */
export const keyCacheDir = (): string => process.env.NIGHTCAST_KEY_CACHE ?? join(homedir(), '.cache', 'nightcast', 'keys');

/** Folder for saved wallet state (NIGHTCAST_STATE_DIR overrides it). */
export const walletStateDir = (): string =>
  process.env.NIGHTCAST_STATE_DIR ?? join(homedir(), 'nightcast-secrets', 'wallet-state');

/** One file per network and seed; the name reveals neither. */
export const walletStateFile = (network: string, seed: string): string =>
  join(walletStateDir(), `${network}-${createHash('sha256').update(`nightcast:${network}:${seed}`).digest('hex').slice(0, 16)}.json`);

/**
 * How many indexer events the shielded and dust wallets apply at once. The SDK
 * default is 10 with a pause between batches, and each batch has a fixed cost,
 * which caps a first sync at roughly 20 events a second (over a day for
 * Preprod's 1.7 million dust events). NIGHTCAST_SYNC_BATCH overrides it.
 */
export const syncBatchSize = (): number => {
  const n = Number.parseInt(process.env.NIGHTCAST_SYNC_BATCH ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
};

type SubmissionService = { submitTransaction(tx: unknown, waitFor?: 'Submitted' | 'InBlock' | 'Finalized'): Promise<unknown>; close(): Promise<void> };
type Submittable = { identifiers(): string[] };

export type SteadySubmitOptions = {
  /** Tries in all (default 3). */
  tries?: number;
  /** Time limit for each try (ms, default 75 s). */
  tryMs?: number;
  /** Whether the chain already has the transaction (e.g. the indexer has it in a block). */
  seen?: (txId: string) => Promise<boolean>;
  log?: (msg: string) => void;
  /** A one-off submission service (default: the wallet SDK's, on a fresh node connection). */
  make?: (relayURL: URL) => SubmissionService;
  /** How long a new service needs before it can send (ms, default 8 s; see below). */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const ALREADY_IN = /already imported|AlreadyImported|temporarily banned|\b101[23]\b/i;
/** The node looked at the transaction and refused it: sending it again won't help. */
const REFUSED = /\b101[014-9]\b|Invalid Transaction|custom error/i;
/**
 * Every message in an error, however deep: Effect wraps the node client's
 * error (and polkadot-js's under it) in a FiberFailure whose Cause sits behind
 * a symbol key, so `.cause` alone stops at "Transaction submission error".
 */
export const errorMessages = (err: unknown): string[] => {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > 8 || found.length > 12) return;
    seen.add(v);
    const o = v as Record<string | symbol, unknown>;
    if (typeof o.message === 'string' && o.message && !found.includes(o.message)) found.push(o.message);
    for (const k of [...Object.getOwnPropertyNames(o), ...Object.getOwnPropertySymbols(o)]) {
      if (k === 'stack' || k === 'message') continue;
      let child: unknown;
      try {
        child = o[k];
      } catch {
        continue;
      }
      if (Array.isArray(child)) child.forEach((c) => visit(c, depth + 1));
      else visit(child, depth + 1);
    }
  };
  visit(err, 0);
  if (!found.length) found.push(String(err));
  return found.map((m) => m.split('\n')[0]!.trim()).filter(Boolean);
};
const errText = (err: unknown): string => errorMessages(err).join(': ');

/**
 * An error's message with the reasons under it: `message (cause: a: b)`.
 * Midnight.js 5 reports a failed step as "balanceTx rejected the transaction
 * ... The provider's own failure is on `cause`", which alone says nothing
 * about why; the causes' own messages (already redacted by Midnight.js) do.
 */
export const failureText = (err: unknown, max = 600): string => {
  const [first, ...rest] = errorMessages(err);
  const top = err instanceof Error && err.message ? err.message : (first ?? String(err));
  const causes = [first, ...rest].filter((m): m is string => !!m && m !== top && !top.includes(m));
  return causes.length ? `${top} (cause: ${causes.join(': ').slice(0, max)})` : top;
};

/**
 * Sending transactions to the node, more steadily than the wallet SDK's own
 * service. That one keeps one node connection for the wallet's whole life,
 * and with wallet-sdk-node-client 1.1.x a connection that drops (Blockfrost's
 * node websocket does, now and then) can leave a submission waiting forever
 * (midnight-wallet #327, fixed in 2.x). This one opens a fresh connection for
 * each try, gives each try a time limit, and waits for the transaction to be
 * in a block, not finalised (callers watch the indexer for it anyway). A
 * transaction the node already has, or the chain already shows, counts as
 * sent.
 *
 * A new service can't send straight away: it loads the node's metadata and
 * then closes its socket without waiting for the close to finish, so a send
 * in the next second or two goes out on the closing socket and fails with
 * "disconnected: 1000 Normal Closure" (the same bug, #327; on the VM every
 * try failed that way). So each service is given `settleMs` first, and the
 * next one is made ahead of time, ready for the next transaction.
 */
export const steadySubmissionService = (relayURL: URL, o: SteadySubmitOptions = {}): SubmissionService => {
  const tries = o.tries ?? 3;
  const tryMs = o.tryMs ?? 75_000;
  const make = o.make ?? ((url: URL) => Capabilities.makeDefaultSubmissionService({ relayURL: url }) as unknown as SubmissionService);
  const settleMs = o.settleMs ?? 8_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  type Ready = { service: SubmissionService; readyAt: number };
  const fresh = (): Ready => ({ service: make(relayURL), readyAt: now() + settleMs });
  let next: Ready | undefined;
  const take = async (): Promise<SubmissionService> => {
    const r = next ?? fresh();
    next = undefined;
    const wait = r.readyAt - now();
    if (wait > 0) await sleep(wait);
    return r.service;
  };
  return {
    async submitTransaction(tx: unknown) {
      try {
        return await send(tx);
      } finally {
        next ??= fresh(); // ready for the next transaction
      }
    },
    close: async () => {
      await next?.service.close().catch(() => undefined);
      next = undefined;
    },
  };

  async function send(tx: unknown): Promise<unknown> {
    const id = (tx as Submittable).identifiers?.().at(-1);
    try {
      const bytes = (tx as { serialize?: () => Uint8Array }).serialize?.().length;
      if (bytes) o.log?.(`sending the transaction (${Math.round(bytes / 1024)} KB)`);
    } catch {
      /* size is only for the log */
    }
    let last: unknown;
    for (let i = 1; i <= tries; i++) {
      const service = await take();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          service.submitTransaction(tx, 'InBlock'),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer from the node within ${Math.round(tryMs / 1000)} s`)), tryMs);
          }),
        ]);
      } catch (err) {
        last = err;
        const text = errText(err);
        if (ALREADY_IN.test(text)) {
          o.log?.('the node already has the transaction (an earlier try reached it)');
          return { _tag: 'Submitted' };
        }
        if (REFUSED.test(text) && !ALREADY_IN.test(text)) throw err;
        if (id && o.seen && (await o.seen(id).catch(() => false))) {
          o.log?.('the transaction is on the chain (the answer from the node was lost)');
          return { _tag: 'InBlock' };
        }
        if (i < tries) o.log?.(`sending the transaction didn't finish (${text.slice(0, 400)}); trying again on a fresh connection (${i + 1} of ${tries})`);
        else o.log?.(`sending the transaction failed ${tries} times; the last time: ${text.slice(0, 600)}`);
      } finally {
        clearTimeout(timer);
        service.close().catch(() => undefined);
      }
    }
    throw last;
    throw last;
  }
};

/**
 * Same mapping as the testkit's (not exported there), plus larger sync batches.
 * `forks` is where this chain moved from ledger 8 to ledger 9: the SDK's
 * default schedule (the version a 2.x node reports), which Preprod, Preview and
 * Mainnet all follow. `provers` names a proof server per ledger era; the
 * wallet only builds ledger 9 transactions now, so one (ledger 9) server is
 * named, or the in-process prover.
 */
const walletConfiguration = (env: EnvironmentConfiguration, prover: 'server' | 'wasm'): ResolvedConfiguration => {
  const timers = timerSettings();
  const configuration = {
    forks: DefaultForkSchedule,
    batchUpdates: { size: syncBatchSize(), timeout: 100, spacing: 0 },
    indexerClientConnection: { indexerHttpUrl: env.indexer, indexerWsUrl: env.indexerWS },
    // The wallet's own timers, slowed down (see timerSettings). The shielded and DUST parts read versionWatch and
    // the unshielded part livenessPollInterval from this same object; the facade's type doesn't list them.
    versionWatch: { intervalMs: timers.versionWatchMs },
    livenessPollInterval: timers.livenessMs,
    provers: { v9: prover === 'wasm' ? ({ kind: 'wasm' } as const) : ({ kind: 'server', url: new URL(env.proofServer) } as const) },
    networkId: env.walletNetworkId,
    relayURL: new URL(env.nodeWS),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: { feeBlocksMargin: 5 },
  };
  return configuration as ResolvedConfiguration;
};

/**
 * How often an open wallet asks the indexer things on a timer.
 *
 * Wallet SDK 2 runs three timers per wallet, each every 30 s by default: the
 * DUST part and the shielded part each ask the indexer for its latest block
 * (to notice a protocol upgrade), and the unshielded part compares the
 * indexer's head with the node's (two indexer reads). That is 8 indexer
 * requests a minute, 11,520 a day, for every wallet that is merely open. Seven
 * wallets on one Blockfrost project used 80,000 a day doing nothing, against a
 * 50,000 limit (measured 12 Nov 2026 with blockfrost-meter.ts: two idle
 * services each made 8.1 requests a minute).
 *
 * Here the upgrade watch runs every 10 minutes (an upgrade is announced days
 * ahead, and a transaction the wallet is sent carries the version too) and the
 * head comparison every 2 minutes (it flags an indexer more than 10 blocks
 * behind; our own watchdogs wait 15 minutes or more): 1.2 requests a minute,
 * about 1,700 a day per wallet.
 *
 * NIGHTCAST_VERSION_WATCH_SECS (0 turns the watch off) and
 * NIGHTCAST_LIVENESS_SECS (10 or more) change them.
 */
export const timerSettings = (env: NodeJS.ProcessEnv = process.env): { versionWatchMs: number; livenessMs: number } => {
  const secs = (v: string | undefined, fallback: number, min: number): number => {
    const n = Number(v);
    return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    versionWatchMs: Math.round(secs(env.NIGHTCAST_VERSION_WATCH_SECS, 600, 0) * 1000),
    livenessMs: Math.round(secs(env.NIGHTCAST_LIVENESS_SECS, 120, 10) * 1000),
  };
};

/**
 * How much the dust wallet adds to each fee, from the environment.
 *
 * The wallet prices a fee at the indexer's latest block and adds a margin of
 * `feeBlocksMargin` blocks of the largest price rise (default 5), plus a flat
 * `additionalFeeOverhead` in specks (default 0). If the node's price has moved
 * further than that, it refuses the transaction as underpaid (1010, custom
 * error 138). NIGHTCAST_FEE_MARGIN_BLOCKS (0-500) and
 * NIGHTCAST_FEE_OVERHEAD_SPECKS raise them.
 */
export const feeSettings = (env: NodeJS.ProcessEnv = process.env): { additionalFeeOverhead: bigint; feeBlocksMargin: number } => {
  const blocks = Number(env.NIGHTCAST_FEE_MARGIN_BLOCKS);
  const overhead = /^\d{1,30}$/.test(env.NIGHTCAST_FEE_OVERHEAD_SPECKS ?? '') ? BigInt(env.NIGHTCAST_FEE_OVERHEAD_SPECKS as string) : undefined;
  return {
    additionalFeeOverhead: overhead ?? DEFAULT_DUST_OPTIONS.additionalFeeOverhead,
    feeBlocksMargin: env.NIGHTCAST_FEE_MARGIN_BLOCKS && Number.isInteger(blocks) && blocks >= 0 && blocks <= 500 ? blocks : DEFAULT_DUST_OPTIONS.feeBlocksMargin,
  };
};

const readSaved = (file: string, network: string): SavedWallet | undefined => {
  if (!existsSync(file)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedWallet;
    return saved.version === 2 && saved.network === network ? saved : undefined;
  } catch {
    return undefined;
  }
};

export type PersistentWallet = {
  provider: MidnightWalletProvider;
  /** True if the wallet carried on from saved state. */
  restored: boolean;
  /** Write the current state to disk (atomically). No-op when persistence is off. */
  save(): Promise<void>;
};

/**
 * Build (not start) a wallet for `seed`, restoring saved state when `persist`
 * is true and a usable save exists.
 */
export const buildWallet = async (
  env: EnvironmentConfiguration,
  network: string,
  seed: string,
  logger: Logger,
  persist: boolean,
  /**
   * `server`: the wallet proves its fee and coin spends on env.proofServer.
   * `wasm`: in this process, with the wallet SDK's WASM prover (keys and
   * parameters fetched from Midnight's file share and cached), for a session
   * whose proof server is a remote prover that only proves contract circuits.
   */
  prover: 'server' | 'wasm' = 'server',
  /** Send transactions with {@link steadySubmissionService} instead of the wallet SDK's own. */
  steady?: SteadySubmitOptions,
): Promise<PersistentWallet> => {
  const seeds = WalletSeeds.fromMasterSeed(seed);
  const config = walletConfiguration(env, prover);
  const dustConfig = {
    ...config,
    costParameters: {
      ledgerParams: DEFAULT_DUST_OPTIONS.ledgerParams,
      ...feeSettings(),
    },
  };
  const unshieldedConfig = {
    ...config,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  };
  const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, env.walletNetworkId);

  const fresh = async () => ({
    shielded: await ShieldedWallet(config).startWithSeed(seeds.shielded),
    unshielded: await UnshieldedWallet(unshieldedConfig).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: await DustWallet(dustConfig).startWithSeed(seeds.dust),
  });

  const file = walletStateFile(network, seed);
  const saved = persist ? readSaved(file, network) : undefined;
  let parts: Awaited<ReturnType<typeof fresh>> | undefined;
  if (saved) {
    try {
      parts = {
        shielded: await ShieldedWallet(config).restore(saved.shielded),
        unshielded: await UnshieldedWallet(unshieldedConfig).restore(saved.unshielded),
        dust: await DustWallet(dustConfig).restore(saved.dust),
      };
    } catch (err) {
      logger.warn(`Saved wallet state could not be used (${err instanceof Error ? err.message : String(err)}); syncing from the start.`);
      parts = undefined;
    }
  }
  const restored = parts !== undefined;
  parts ??= await fresh();

  const { shielded, unshielded, dust } = parts;
  const facade = await WalletFacade.init({
    configuration: config,
    ...(steady ? { submissionService: () => steadySubmissionService(new URL(env.nodeWS), steady) as never } : {}),
    shielded: () => shielded,
    unshielded: () => unshielded,
    dust: () => dust,
  });
  const provider = await MidnightWalletProvider.withWallet(logger, env, facade, seeds, keystore);

  let saving: Promise<void> | undefined;
  const save = async (): Promise<void> => {
    if (!persist) return;
    if (saving) return saving;
    saving = (async () => {
      const [s, u, d] = await Promise.all([
        facade.shielded.serializeState(),
        facade.unshielded.serializeState(),
        facade.dust.serializeState(),
      ]);
      const data: SavedWallet = { version: 2, network, savedAt: new Date().toISOString(), shielded: s, unshielded: u, dust: d };
      mkdirSync(walletStateDir(), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    })().finally(() => {
      saving = undefined;
    });
    return saving;
  };

  return { provider, restored, save };
};

/** Forget saved state for a wallet (e.g. after a network reset). */
export const forgetWalletState = (network: string, seed: string): boolean => {
  const file = walletStateFile(network, seed);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
};
