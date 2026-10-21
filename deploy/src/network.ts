import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { type Logger } from 'pino';
import { filter, firstValueFrom, throttleTime } from 'rxjs';
import { WebSocket as WsWebSocket } from 'ws';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { CompiledContract, type ProvableCircuitId } from '@midnight-ntwrk/compact-js';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js/types';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  defaultContainersConfiguration,
  DynamicProofServerContainer,
  type EnvironmentConfiguration,
  inMemoryPrivateStateProvider,
  LocalTestEnvironment,
  logger as testkitLogger,
  MidnightWalletProvider,
  PreprodTestEnvironment,
  PreviewTestEnvironment,
  setContainersConfiguration,
  StaticProofServerContainer,
  waitForFunds,
} from '@midnight-ntwrk/testkit-js';
import { Nightcast, type NightcastPrivateState, witnesses } from '@nightcast/contract';
import { zkConfigPath } from './fingerprints.js';
import { buildWallet } from './wallet.js';

export const NETWORKS = ['preprod', 'preview', 'local'] as const;
export type Network = (typeof NETWORKS)[number];

export const isNetwork = (s: string): s is Network => (NETWORKS as readonly string[]).includes(s);

export const NIGHTCAST_PRIVATE_STATE_ID = 'nightcast';

export type NightcastContract = Nightcast.Contract<NightcastPrivateState>;
export type NightcastCircuits = ProvableCircuitId<NightcastContract>;
export type NightcastProviders = MidnightProviders<NightcastCircuits, typeof NIGHTCAST_PRIVATE_STATE_ID, NightcastPrivateState>;

const dockerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docker');

import { redact } from './redact-output.js';
export { redact };

export const createLogger = (level = process.env.NIGHTCAST_LOG_LEVEL ?? 'info'): Logger =>
  pino({
    level,
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((a) => (typeof a === 'string' ? redact(a) : a)) as typeof args);
      },
    },
    transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } },
  });

// The testkit's own logger prints wallet settings (including indexer URLs, so
// any project id) at info level, to the terminal and to ./logs/tests. Quiet it.
testkitLogger.level = process.env.NIGHTCAST_LOG_LEVEL === 'debug' ? 'debug' : 'warn';

/** The compiled Nightcast contract with its witnesses and proving keys, as midnight-js expects it. */
export const compiledNightcast = (dir = zkConfigPath()) =>
  CompiledContract.make('nightcast', Nightcast.Contract<NightcastPrivateState>).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(dir),
  );

export type Session = {
  network: Network;
  logger: Logger;
  config: EnvironmentConfiguration;
  /** Services that didn't answer when connecting (empty when all is well). */
  problems: string[];
  shutdown(): Promise<void>;
};

/**
 * Networks whose public node and indexer are run by Blockfrost and need a
 * project id. Midnight retired its own Preprod endpoints on 9 October 2026
 * (they now answer 410 Gone); see docs.midnight.network/relnotes/network.
 */
export const BLOCKFROST: Partial<Record<Network, { indexer: string; indexerWS: string; node: string; nodeWS: string }>> = {
  preprod: {
    indexer: 'https://midnight-preprod.blockfrost.io/api/v0',
    indexerWS: 'wss://midnight-preprod.blockfrost.io/api/v0/ws',
    node: 'https://rpc.midnight-preprod.blockfrost.io',
    nodeWS: 'wss://rpc.midnight-preprod.blockfrost.io',
  },
};

/** Where `./nightcast blockfrost save` keeps the project id by default. */
export const defaultBlockfrostFile = (network: Network): string =>
  join(homedir(), 'nightcast-secrets', `blockfrost-${network}.secret`);

/**
 * The Blockfrost project id for a network: NIGHTCAST_BLOCKFROST_PROJECT_ID,
 * else the given file, else the default file. Undefined if none is set.
 */
export const blockfrostProjectId = (network: Network, file?: string): string | undefined => {
  const fromEnv = process.env.NIGHTCAST_BLOCKFROST_PROJECT_ID?.trim();
  if (fromEnv) return fromEnv;
  const path = file ?? defaultBlockfrostFile(network);
  if (!existsSync(path)) {
    if (file) throw new Error(`${file} does not exist`);
    return undefined;
  }
  const id = readFileSync(path, 'utf8').trim();
  return id || undefined;
};

const withProjectId = (url: string, projectId: string): string => {
  const u = new URL(url);
  u.searchParams.set('project_id', projectId);
  return u.toString();
};

/**
 * Public endpoints (node, indexer) for a remote network; the proof server is
 * added by `connect`. Blockfrost-served networks need `projectId`.
 */
export const publicEndpoints = (
  network: Exclude<Network, 'local'>,
  logger: Logger,
  projectId?: string,
): EnvironmentConfiguration => {
  const blockfrost = BLOCKFROST[network];
  if (blockfrost) {
    if (!projectId) {
      throw new Error(
        `${network} needs a Blockfrost project id (Midnight's own ${network} servers were retired on 9 October 2026).\n` +
          `  1. Sign up at https://blockfrost.io and create a project for Midnight ${network}.\n` +
          `  2. Run: ./nightcast blockfrost save --network ${network}\n` +
          `     and paste the project id when asked.`,
      );
    }
    // Network ids from the testkit; endpoints replaced with Blockfrost's.
    return {
      ...new PreprodTestEnvironment(logger).getEnvironmentConfiguration(),
      indexer: withProjectId(blockfrost.indexer, projectId),
      indexerWS: withProjectId(blockfrost.indexerWS, projectId),
      node: withProjectId(blockfrost.node, projectId),
      nodeWS: withProjectId(blockfrost.nodeWS, projectId),
      faucet: undefined,
    };
  }
  // The testkit's faucet API needs no captcha only in CI; use the faucet web page instead.
  return { ...new PreviewTestEnvironment(logger).getEnvironmentConfiguration(), faucet: undefined };
};

const errorText = (err: unknown): string => {
  const e = err as { message?: string; cause?: { message?: string; code?: string } };
  return [e?.message ?? String(err), e?.cause?.code ?? e?.cause?.message].filter(Boolean).join(': ');
};

/**
 * POST a small request and expect a 2xx answer, allowing for slow links (the
 * testkit's own checks give up after 1 second, which is too short from far
 * away). Returns an error message, or undefined when it works.
 */
const answers = async (
  name: string,
  url: string,
  init: { method?: string; body?: string } = {},
  timeoutMs = 20_000,
): Promise<string | undefined> => {
  const shown = redact(url);
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return undefined;
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    const hint =
      res.status === 401 || res.status === 403
        ? ' (the Blockfrost project id was refused: check it is for this network)'
        : res.status === 410
          ? ' (this endpoint has been retired)'
          : '';
    return redact(`${name} at ${shown} answered ${res.status}${hint}${body ? `: ${body}` : ''}`);
  } catch (err) {
    return redact(`${name} at ${shown} did not answer (${errorText(err)})`);
  }
};

const withPath = (base: string, path: string): string => new URL(path, new URL(base).origin).toString();

type WsLike = {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
};
type WsConstructor = new (url: string, protocols?: string[]) => WsLike;

/**
 * The wallet syncs over WebSockets to the indexer and uses whatever global
 * `WebSocket` exists. Like Midnight's own examples, Nightcast installs the
 * `ws` package's implementation; NIGHTCAST_WEBSOCKET=builtin keeps Node's own.
 */
export const installWebSocket = (): string => {
  if (process.env.NIGHTCAST_WEBSOCKET === 'builtin' && (globalThis as { WebSocket?: unknown }).WebSocket) return 'builtin';
  (globalThis as { WebSocket?: unknown }).WebSocket = WsWebSocket;
  return 'ws';
};

const describeWsError = (ev: unknown): string => {
  const e = ev as { message?: string; error?: { message?: string; code?: string; cause?: { message?: string; code?: string } } };
  const parts = [e.message, e.error?.message, e.error?.code, e.error?.cause?.message, e.error?.cause?.code].filter(
    (p, i, all): p is string => !!p && all.indexOf(p) === i,
  );
  return parts.length ? parts.join(': ') : 'connection error (no details given)';
};

/**
 * Open the indexer's GraphQL WebSocket the way the wallet does and wait for
 * the server to acknowledge. Returns an error message, or undefined when it works.
 */
export const probeIndexerWebSocket = (url: string, timeoutMs = 20_000): Promise<string | undefined> =>
  new Promise((resolvePromise) => {
    const Impl = (globalThis as { WebSocket?: unknown }).WebSocket as WsConstructor | undefined;
    if (!Impl) return resolvePromise('no WebSocket implementation available');
    let socket: WsLike | undefined;
    let settled = false;
    const done = (result?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      resolvePromise(result === undefined ? undefined : redact(`indexer WebSocket at ${url}: ${result}`));
    };
    const timer = setTimeout(() => done(`no answer within ${timeoutMs / 1000}s`), timeoutMs);
    try {
      socket = new Impl(url, ['graphql-transport-ws']);
    } catch (err) {
      return done(err instanceof Error ? err.message : String(err));
    }
    socket.onopen = () => socket!.send(JSON.stringify({ type: 'connection_init' }));
    socket.onmessage = (ev) => {
      let type: string | undefined;
      try {
        type = (JSON.parse(String(ev.data)) as { type?: string }).type;
      } catch {
        type = undefined;
      }
      done(type === 'connection_ack' ? undefined : `unexpected first message (${String(ev.data).slice(0, 120)})`);
    };
    socket.onerror = (ev) => done(describeWsError(ev));
    socket.onclose = (ev) => done(`closed before answering (code ${ev.code ?? '?'}${ev.reason ? `, ${ev.reason}` : ''})`);
  });

/**
 * Connect to a network. For Preprod and Preview a proof server is started in
 * Docker unless `proofServerPort` points at one already running; `local`
 * starts a whole throwaway network (node, indexer, proof server) in Docker.
 */
export const connect = async (
  network: Network,
  opts: { proofServerPort?: number; logger?: Logger; projectId?: string } = {},
): Promise<Session> => {
  const logger = opts.logger ?? createLogger();
  const webSocket = installWebSocket();
  setContainersConfiguration({
    ...defaultContainersConfiguration,
    proofServer: { ...defaultContainersConfiguration.proofServer, path: dockerDir, fileName: 'proof-server.yml' },
    standalone: { ...defaultContainersConfiguration.standalone, path: dockerDir, fileName: 'compose.yml' },
  });

  if (network === 'local') {
    setNetworkId('undeployed');
    const env = new LocalTestEnvironment(logger);
    const config = await env.start();
    return { network, logger, config, problems: [], shutdown: () => env.shutdown() };
  }

  const base = publicEndpoints(network, logger, opts.projectId);
  setNetworkId(base.networkId);
  logger.info(opts.proofServerPort ? `Using the proof server on port ${opts.proofServerPort}` : 'Starting a proof server in Docker...');
  const proofServer = opts.proofServerPort
    ? new StaticProofServerContainer(opts.proofServerPort)
    : await DynamicProofServerContainer.start(logger, undefined, base.networkId);
  const config: EnvironmentConfiguration = { ...base, proofServer: proofServer.getUrl() };

  logger.info(`Checking the ${network} node, indexer and proof server...`);
  logger.debug(`WebSocket implementation: ${webSocket}`);
  const problems = (
    await Promise.all([
      answers('node', config.node, { method: 'POST', body: '{"id":1,"jsonrpc":"2.0","method":"system_chain","params":[]}' }),
      answers('indexer', config.indexer, { method: 'POST', body: '{"query":"{ __typename }"}' }),
      probeIndexerWebSocket(config.indexerWS),
      answers('proof server', withPath(config.proofServer, '/health'), {}, 60_000),
    ])
  ).filter((p): p is string => p !== undefined);
  for (const p of problems) logger.warn(`${p}; carrying on, but the next steps may fail`);
  if (problems.length === 0) logger.info('All reachable.');

  return { network, logger, config, problems, shutdown: () => proofServer.stop() };
};

/** Seeds of the pre-funded wallets on a `local` network. */
export const LOCAL_GENESIS_SEEDS = [
  '0000000000000000000000000000000000000000000000000000000000000002',
  '0000000000000000000000000000000000000000000000000000000000000001',
  '0000000000000000000000000000000000000000000000000000000000000003',
  '0000000000000000000000000000000000000000000000000000000000000004',
] as const;

export type WalletOptions = {
  /** Hex wallet seed. On `local`, defaults to the first genesis wallet. */
  seed?: string;
  /** Called with the wallet's unshielded address before waiting for funds. */
  onAddress?: (address: string) => void;
  /** Called once if the wallet has no NIGHT yet (it then waits for some to arrive). */
  onNoFunds?: (address: string) => void;
  /** Called once while waiting for the first DUST after registration. */
  onWaitingForDust?: () => void;
};

/** Faucet pages for test NIGHT (from Midnight's "Acquire tokens" guide). */
export const FAUCETS: Partial<Record<Network, string>> = {
  preprod: 'https://midnight-tmnight-preprod.nethermind.dev/',
  preview: 'https://midnight-tmnight-preview.nethermind.dev/',
};

/**
 * Open and sync a wallet, ready to pay fees. If it holds no NIGHT it waits
 * for some to arrive (send it from the faucet); then it registers the NIGHT
 * for DUST generation if needed and waits for the first DUST (DUST pays
 * transaction fees and builds up over time).
 */
export const openWallet = async (session: Session, opts: WalletOptions = {}): Promise<MidnightWalletProvider> => {
  const seed = opts.seed ?? (session.network === 'local' ? LOCAL_GENESIS_SEEDS[0] : undefined);
  if (!seed) throw new Error('No wallet: pass --wallet <file from `./nightcast wallet new`> or set NIGHTCAST_WALLET_SEED.');
  // Remember sync progress between runs on public networks (a first sync takes
  // hours); `local` networks are throwaway, so start fresh there.
  const persist = session.network !== 'local' && process.env.NIGHTCAST_NO_WALLET_STATE !== '1';
  const built = await buildWallet(session.config, session.network, seed, session.logger.child({}, { level: 'warn' }), persist);
  const wallet = built.provider;
  const address = walletAddress(wallet);
  opts.onAddress?.(address);
  if (built.restored) session.logger.info('Carrying on from the saved wallet state.');
  await wallet.start(false);

  // Save every 2 minutes and when the wallet stops, so an interrupted sync resumes.
  const saveQuietly = () => built.save().catch((e) => session.logger.warn(`Could not save wallet state: ${e}`));
  const autosave = setInterval(saveQuietly, 120_000);
  const stop = wallet.stop.bind(wallet);
  wallet.stop = async () => {
    clearInterval(autosave);
    await saveQuietly();
    return stop();
  };

  const synced = () => firstValueFrom(wallet.wallet.state().pipe(filter((s) => s.isSynced)));
  const progress = wallet.wallet
    .state()
    .pipe(throttleTime(30_000))
    .subscribe((s) => {
      if (!s.isSynced) session.logger.info(`Syncing: ${describeSync(s)}`);
    });
  const slow = setTimeout(
    () =>
      session.logger.warn(
        'Still syncing. If you see repeated "Wallet.Sync" errors, press Ctrl+C and run `./nightcast doctor --network ' +
          `${session.network}\` to see which connection is failing.`,
      ),
    180_000,
  );
  let state = await synced().finally(() => {
    clearTimeout(slow);
    progress.unsubscribe();
  });
  await saveQuietly();
  if ((state.unshielded.balances[unshieldedToken().raw] ?? 0n) === 0n) {
    opts.onNoFunds?.(address);
    state = await firstValueFrom(
      wallet.wallet
        .state()
        .pipe(filter((s) => s.isSynced && (s.unshielded.balances[unshieldedToken().raw] ?? 0n) > 0n)),
    );
  }
  if (state.dust.balance(new Date()) === 0n) {
    // Registers any unregistered NIGHT for DUST generation (no faucet calls).
    await waitForFunds(wallet.wallet, { ...session.config, faucet: undefined }, false, wallet.unshieldedKeystore);
    opts.onWaitingForDust?.();
    await firstValueFrom(
      wallet.wallet.state().pipe(
        throttleTime(5_000),
        filter((s) => s.isSynced && s.dust.balance(new Date()) > 0n),
      ),
    );
  }
  return wallet;
};

type ProgressLike = {
  appliedIndex?: bigint;
  appliedId?: bigint;
  highestRelevantWalletIndex?: bigint;
  highestTransactionId?: bigint;
  highestIndex?: bigint;
  isConnected?: boolean;
  isStrictlyComplete?: () => boolean;
};

const describeProgress = (name: string, p: ProgressLike | undefined): string => {
  if (!p) return `${name} ?`;
  if (p.isStrictlyComplete?.()) return `${name} done`;
  if (p.isConnected === false) return `${name} connecting`;
  const applied = p.appliedIndex ?? p.appliedId;
  const target = p.highestRelevantWalletIndex ?? p.highestTransactionId ?? p.highestIndex;
  if (applied === undefined || target === undefined || target === 0n) return `${name} starting`;
  const pct = Number((applied * 1000n) / target) / 10;
  return `${name} ${Math.min(pct, 100).toFixed(1)}% (${applied}/${target})`;
};

/** One line on how far each part of the wallet has synced. */
export const describeSync = (state: unknown): string => {
  const s = state as {
    shielded?: { state?: { progress?: ProgressLike } };
    dust?: { state?: { progress?: ProgressLike } };
    unshielded?: { progress?: ProgressLike };
  };
  return [
    describeProgress('shielded', s.shielded?.state?.progress),
    describeProgress('unshielded', s.unshielded?.progress),
    describeProgress('dust', s.dust?.state?.progress),
  ].join(', ');
};

/** The address to send test NIGHT to (faucet, transfers). */
export const walletAddress = (wallet: MidnightWalletProvider): string =>
  wallet.unshieldedKeystore.getBech32Address().asString();

/**
 * After a transaction, wait until the wallet has caught up and holds DUST it
 * can spend again (the fee's change only comes back once the transaction is
 * on chain and synced), so the next transaction can pay its fee.
 */
export const waitForSpendableDust = async (
  wallet: MidnightWalletProvider,
  logger?: Logger,
  timeoutMs = 5 * 60_000,
): Promise<boolean> => {
  // Coins spent by a transaction that isn't confirmed yet are "pending"; wait
  // until none are and at least one coin is available to pay with.
  const states = wallet.wallet.state();
  const status = states.pipe(throttleTime(30_000)).subscribe((s) => {
    logger?.info(
      `Waiting for spendable DUST: ${s.dust.availableCoins.length} coin(s) available, ` +
        `${s.dust.pendingCoins.length} pending, balance ${s.dust.balance(new Date())}, ` +
        `${s.isSynced ? 'synced' : `syncing (${describeSync(s)})`}`,
    );
  });
  const ready = firstValueFrom(
    states.pipe(
      filter(
        (s) =>
          s.isSynced &&
          s.dust.pendingCoins.length === 0 &&
          s.dust.availableCoins.length > 0 &&
          s.dust.balance(new Date()) > 0n,
      ),
    ),
  ).then(() => true);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([ready, timedOut]);
  } finally {
    clearTimeout(timer);
    status.unsubscribe();
  }
};

/** NIGHT and DUST balances of a synced wallet. */
export const walletBalances = async (wallet: MidnightWalletProvider): Promise<{ night: bigint; dust: bigint }> => {
  const state = await firstValueFrom(wallet.wallet.state().pipe(filter((s) => s.isSynced)));
  return {
    night: state.unshielded.balances[unshieldedToken().raw] ?? 0n,
    dust: state.dust.balance(new Date()),
  };
};

/**
 * midnight-js providers for Nightcast. Private state is kept in memory only:
 * the deployer's temporary maintenance key and any oracle secret passed in
 * never touch the disk.
 */
export const nightcastProviders = (
  session: Session,
  wallet: MidnightWalletProvider,
  dir = zkConfigPath(),
): NightcastProviders => {
  const zkConfigProvider = new NodeZkConfigProvider<NightcastCircuits>(dir);
  return {
    privateStateProvider: inMemoryPrivateStateProvider<typeof NIGHTCAST_PRIVATE_STATE_ID, NightcastPrivateState>(),
    publicDataProvider: indexerPublicDataProvider(session.config.indexer, session.config.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(session.config.proofServer, zkConfigProvider),
    walletProvider: wallet,
    midnightProvider: wallet,
  };
};

