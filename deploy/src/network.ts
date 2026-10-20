import { dirname, resolve } from 'node:path';
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
  MidnightWalletProvider,
  PreprodTestEnvironment,
  PreviewTestEnvironment,
  setContainersConfiguration,
  StaticProofServerContainer,
  waitForFunds,
} from '@midnight-ntwrk/testkit-js';
import { Nightcast, type NightcastPrivateState, witnesses } from '@nightcast/contract';
import { zkConfigPath } from './fingerprints.js';

export const NETWORKS = ['preprod', 'preview', 'local'] as const;
export type Network = (typeof NETWORKS)[number];

export const isNetwork = (s: string): s is Network => (NETWORKS as readonly string[]).includes(s);

export const NIGHTCAST_PRIVATE_STATE_ID = 'nightcast';

export type NightcastContract = Nightcast.Contract<NightcastPrivateState>;
export type NightcastCircuits = ProvableCircuitId<NightcastContract>;
export type NightcastProviders = MidnightProviders<NightcastCircuits, typeof NIGHTCAST_PRIVATE_STATE_ID, NightcastPrivateState>;

const dockerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docker');

export const createLogger = (level = process.env.NIGHTCAST_LOG_LEVEL ?? 'info'): Logger =>
  pino({ level, transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } } });

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

/** Public endpoints (node, indexer) for a remote network; the proof server is added by `connect`. */
export const publicEndpoints = (network: Exclude<Network, 'local'>, logger: Logger): EnvironmentConfiguration => {
  const env = network === 'preprod' ? new PreprodTestEnvironment(logger) : new PreviewTestEnvironment(logger);
  // The testkit's faucet API needs no captcha only in CI; use the faucet web page instead.
  return { ...env.getEnvironmentConfiguration(), faucet: undefined };
};

/**
 * Check a service answers, allowing for slow links (the testkit's own checks
 * give up after 1 second, which is too short from far away). Returns an
 * error message, or undefined when it's reachable.
 */
const reachable = async (name: string, url: string, timeoutMs = 20_000): Promise<string | undefined> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500 ? undefined : `${name} at ${url} answered ${res.status}`;
  } catch (err) {
    return `${name} at ${url} did not answer (${err instanceof Error ? err.message : String(err)})`;
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
      resolvePromise(result === undefined ? undefined : `indexer WebSocket at ${url}: ${result}`);
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
export const connect = async (network: Network, opts: { proofServerPort?: number; logger?: Logger } = {}): Promise<Session> => {
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

  const base = publicEndpoints(network, logger);
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
      reachable('node', withPath(config.node, '/health')),
      reachable('indexer', withPath(config.indexer, '/ready')),
      probeIndexerWebSocket(config.indexerWS),
      reachable('proof server', `${config.proofServer}/health`, 60_000),
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
  // The testkit logs the wallet seed at info level; give it a quieter logger so
  // the secret never reaches the terminal.
  const wallet = await MidnightWalletProvider.build(session.logger.child({}, { level: 'warn' }), session.config, seed);
  const address = walletAddress(wallet);
  opts.onAddress?.(address);
  await wallet.start(false);

  const synced = () => firstValueFrom(wallet.wallet.state().pipe(filter((s) => s.isSynced)));
  const slow = setTimeout(
    () =>
      session.logger.warn(
        'Still syncing. If you see repeated "Wallet.Sync" errors, press Ctrl+C and run `./nightcast doctor --network ' +
          `${session.network}\` to see which connection is failing.`,
      ),
    180_000,
  );
  let state = await synced().finally(() => clearTimeout(slow));
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

/** The address to send test NIGHT to (faucet, transfers). */
export const walletAddress = (wallet: MidnightWalletProvider): string =>
  wallet.unshieldedKeystore.getBech32Address().asString();

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

