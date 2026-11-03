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
import { DustSecretKey, LedgerParameters, ZswapSecretKeys } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import {
  Capabilities,
  createKeystore,
  type DefaultConfiguration,
  DustWallet,
  InMemoryTransactionHistoryStorage,
  mergeWalletEntries,
  PublicKey,
  ShieldedWallet,
  UnshieldedWallet,
  WalletEntrySchema,
  WalletFacade,
} from '@midnight-ntwrk/wallet-sdk';
import {
  DEFAULT_DUST_OPTIONS,
  type EnvironmentConfiguration,
  MidnightWalletProvider,
  WalletSeeds,
} from '@midnight-ntwrk/testkit-js';

type SavedWallet = {
  version: 1;
  network: string;
  savedAt: string;
  shielded: string;
  unshielded: string;
  dust: string;
};

/** A wallet's unshielded address (mn_addr_...) from its seed, offline. */
export const addressFromSeed = (seed: string, walletNetworkId: Parameters<typeof createKeystore>[1]): string =>
  createKeystore(WalletSeeds.fromMasterSeed(seed).unshielded, walletNetworkId).getBech32Address().asString();

type KeyMaterialProvider = NonNullable<NonNullable<Parameters<typeof Capabilities.makeWasmProvingService>[0]>['keyMaterialProvider']>;

/**
 * Where the in-process prover keeps the keys and parameters it downloads
 * (NIGHTCAST_KEY_CACHE overrides it). They are public, about 100 MB, and the
 * same for every wallet, so they live outside the secrets folder.
 */
export const keyCacheDir = (): string => process.env.NIGHTCAST_KEY_CACHE ?? join(homedir(), '.cache', 'nightcast', 'keys');

/**
 * The wallet SDK's key material for in-process (WASM) proving, kept on disk.
 * Same files and addresses as the SDK's own provider
 * (wallet-sdk-prover-client 1.2.2, WasmProver.makeDefaultKeyMaterialProvider),
 * which keeps them in memory only, so every run downloaded them again; and
 * this one refuses an error page instead of caching it as a key.
 */
export const diskKeyMaterialProvider = (
  dir: string = keyCacheDir(),
  base = 'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com',
  fetcher: typeof fetch = fetch,
): KeyMaterialProvider => {
  const ver = 9;
  const paths: Record<string, string> = {
    'midnight/zswap/spend': `zswap/${ver}/spend`,
    'midnight/zswap/output': `zswap/${ver}/output`,
    'midnight/zswap/sign': `zswap/${ver}/sign`,
    'midnight/dust/spend': `dust/${ver}/spend`,
  };
  const memory = new Map<string, Promise<Uint8Array>>();
  const file = (name: string): Promise<Uint8Array> => {
    let p = memory.get(name);
    if (!p) {
      p = (async () => {
        const path = join(dir, name);
        if (existsSync(path)) return new Uint8Array(readFileSync(path));
        let last: unknown;
        for (let i = 0; i < 5; i++) {
          try {
            const r = await fetcher(`${base}/${name}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const bytes = new Uint8Array(await r.arrayBuffer());
            if (bytes.length === 0) throw new Error('empty');
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(`${path}.tmp`, bytes);
            renameSync(`${path}.tmp`, path);
            return bytes;
          } catch (err) {
            last = err;
            await new Promise((res) => setTimeout(res, 1000 * 2 ** (i + 1)));
          }
        }
        memory.delete(name);
        throw new Error(`could not download ${base}/${name}: ${last instanceof Error ? last.message : String(last)}`);
      })();
      memory.set(name, p);
    }
    return p;
  };
  return {
    lookupKey: async (keyLocation: string) => {
      const pth = paths[keyLocation];
      if (pth === undefined) return undefined;
      const [proverKey, verifierKey, ir] = await Promise.all([file(`${pth}.prover`), file(`${pth}.verifier`), file(`${pth}.bzkir`)]);
      return { proverKey, verifierKey, ir };
    },
    getParams: (k: number) => file(`bls_midnight_2p${k}`),
  } as unknown as KeyMaterialProvider;
};

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

/** Same mapping as the testkit's (not exported there), plus larger sync batches. */
const walletConfiguration = (env: EnvironmentConfiguration): DefaultConfiguration => ({
  batchUpdates: { size: syncBatchSize(), timeout: 100, spacing: 0 },
  indexerClientConnection: { indexerHttpUrl: env.indexer, indexerWsUrl: env.indexerWS },
  provingServerUrl: new URL(env.proofServer),
  networkId: env.walletNetworkId,
  relayURL: new URL(env.nodeWS),
  txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  costParameters: { feeBlocksMargin: 5 },
});

const readSaved = (file: string, network: string): SavedWallet | undefined => {
  if (!existsSync(file)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedWallet;
    return saved.version === 1 && saved.network === network ? saved : undefined;
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
  const config = walletConfiguration(env);
  const dustConfig = {
    ...config,
    costParameters: {
      ledgerParams: DEFAULT_DUST_OPTIONS.ledgerParams,
      additionalFeeOverhead: DEFAULT_DUST_OPTIONS.additionalFeeOverhead,
      feeBlocksMargin: DEFAULT_DUST_OPTIONS.feeBlocksMargin,
    },
  };
  const unshieldedConfig = {
    ...config,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
  };
  const keystore = createKeystore(seeds.unshielded, env.walletNetworkId);

  const fresh = () => ({
    shielded: ShieldedWallet(config).startWithSeed(seeds.shielded),
    unshielded: UnshieldedWallet(unshieldedConfig).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: DustWallet(dustConfig).startWithSeed(seeds.dust, LedgerParameters.initialParameters().dust),
  });

  const file = walletStateFile(network, seed);
  const saved = persist ? readSaved(file, network) : undefined;
  let parts: ReturnType<typeof fresh> | undefined;
  if (saved) {
    try {
      parts = {
        shielded: ShieldedWallet(config).restore(saved.shielded),
        unshielded: UnshieldedWallet(unshieldedConfig).restore(saved.unshielded),
        dust: DustWallet(dustConfig).restore(saved.dust),
      };
    } catch (err) {
      logger.warn(`Saved wallet state could not be used (${err instanceof Error ? err.message : String(err)}); syncing from the start.`);
      parts = undefined;
    }
  }
  const restored = parts !== undefined;
  parts ??= fresh();

  const { shielded, unshielded, dust } = parts;
  const facade = await WalletFacade.init({
    configuration: config,
    ...(prover === 'wasm' ? { provingService: () => Capabilities.makeWasmProvingService({ keyMaterialProvider: diskKeyMaterialProvider() }) } : {}),
    ...(steady ? { submissionService: () => steadySubmissionService(new URL(env.nodeWS), steady) as never } : {}),
    shielded: () => shielded,
    unshielded: () => unshielded,
    dust: () => dust,
  });
  const provider = await MidnightWalletProvider.withWallet(
    logger,
    env,
    facade,
    ZswapSecretKeys.fromSeed(seeds.shielded),
    DustSecretKey.fromSeed(seeds.dust),
    keystore,
  );

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
      const data: SavedWallet = { version: 1, network, savedAt: new Date().toISOString(), shielded: s, unshielded: u, dust: d };
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
