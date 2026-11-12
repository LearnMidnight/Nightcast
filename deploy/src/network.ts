import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { type Logger } from 'pino';
import { filter, firstValueFrom, throttleTime } from 'rxjs';
import { WebSocket as WsWebSocket } from 'ws';
import { ContractState as Ledger8ContractState } from '@midnight-ntwrk/midnight-js-protocol/v8';
import { ContractState as Ledger9ContractState, unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/v9';
import type { Ledger8CircuitId, Ledger8Contract } from '@midnight-ntwrk/midnight-js/contracts';
import type { ContractStateRead, MidnightProviders, PublicDataProvider } from '@midnight-ntwrk/midnight-js/types';
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
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
import { Nightcast, type NightcastPrivateState, witnesses } from '@nightcast/contract';
import { zkConfigPath } from './fingerprints.js';
import { addressFromSeed, buildWallet } from './wallet.js';

export const NETWORKS = ['preprod', 'preview', 'local'] as const;
export type Network = (typeof NETWORKS)[number];

export const isNetwork = (s: string): s is Network => (NETWORKS as readonly string[]).includes(s);

export const NIGHTCAST_PRIVATE_STATE_ID = 'nightcast';

export type NightcastContract = Nightcast.Contract<NightcastPrivateState>;
export type NightcastCircuits = Ledger8CircuitId<NightcastContract>;
export type NightcastProviders = MidnightProviders<NightcastCircuits, typeof NIGHTCAST_PRIVATE_STATE_ID, NightcastPrivateState>;

/**
 * A ledger `ContractState`, decoded from what Midnight.js 5 reads: a ledger 8
 * state (written before the hard fork) or a ledger 9 one. Both carry the
 * maintenance authority, the verifier keys (`operations`) and `data`, whose
 * state value `encode()`s era-neutrally for the contracts' own `ledgerOf`.
 */
export type DecodedContractState = Ledger8ContractState | Ledger9ContractState;

/** Decode a Midnight.js 5 contract-state read with the ledger of the era that wrote it. */
export const decodeContractState = (read: ContractStateRead | null | undefined): DecodedContractState | null =>
  read ? (read.contractState.deserialize({ v8: Ledger8ContractState, v9: Ledger9ContractState }) as DecodedContractState) : null;

/** A public data provider's `queryContractState`, answering decoded ledger states (for the chain adapters). */
export const decodedPublicData = (publicData: Pick<PublicDataProvider, 'queryContractState'>) => ({
  queryContractState: async (address: string): Promise<DecodedContractState | null> => decodeContractState(await publicData.queryContractState(address)),
});

/** Read a contract's state, decoded (null if there is no contract at the address). */
export const readContractState = (publicData: Pick<PublicDataProvider, 'queryContractState'>, address: string): Promise<DecodedContractState | null> =>
  decodedPublicData(publicData).queryContractState(address);

const dockerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docker');

import { type DustTimeWallet, declareFeesAtDustTime } from './dust-time.js';
import { type RefusalWallet, explainRefusals } from './explain-refusal.js';
import { blockfrostGate, installMeter, reportUsage } from './blockfrost-meter.js';
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
    // NIGHTCAST_LOG_FD=2 sends the log to stderr, for programs whose stdout is
    // a protocol (an MCP server's JSON-RPC, say).
    transport: {
      target: 'pino-pretty',
      options: { colorize: process.env.NIGHTCAST_LOG_FD !== '2', ignore: 'pid,hostname', destination: process.env.NIGHTCAST_LOG_FD === '2' ? 2 : 1 },
    },
  });

// The testkit's own logger prints wallet settings (including indexer URLs, so
// any project id) at info level, to the terminal and to ./logs/tests. Quiet it.
testkitLogger.level = process.env.NIGHTCAST_LOG_LEVEL === 'debug' ? 'debug' : 'warn';

/**
 * The Nightcast contract with its witnesses, as Midnight.js 5 takes a contract
 * compiled by the previous toolchain (Compact 0.31 / compact-runtime 0.16): the
 * generated contract instance itself, not a `CompiledContract` container. Its
 * proving keys come from the providers' ZK config provider (`contractProviders`).
 */
export const compiledNightcast = (): NightcastContract => new Nightcast.Contract<NightcastPrivateState>(witnesses);

export type Session = {
  network: Network;
  logger: Logger;
  config: EnvironmentConfiguration;
  /** Services that didn't answer when connecting (empty when all is well). */
  problems: string[];
  /**
   * The proof server is a remote prover for one contract's circuits (e.g.
   * Lunardraw's player prover), so a wallet opened in this session proves its
   * own parts (DUST fees, shielded coins) in-process instead (see buildWallet).
   */
  remoteProver?: boolean;
  shutdown(): Promise<void>;
};

/**
 * Networks whose indexer is run by Blockfrost and needs a project id. Midnight
 * decommissioned its own Preprod indexer on 9 October 2026; see
 * docs.midnight.network/guides/networks-and-environments. The node is
 * Midnight's public RPC (the testkit's `rpc.preprod.midnight.network`, which
 * still answers, WebSocket subscriptions included): wallet SDK 2 follows the
 * chain's protocol version through a node subscription
 * (`state_subscribeRuntimeVersion`), and Blockfrost's RPC WebSocket drops it
 * (1006 Abnormal Closure, then "No response received from RPC endpoint in
 * 60s"), which stalled every wallet after the ledger 9 upgrade (9 Nov 2026).
 * NIGHTCAST_NODE_URL / NIGHTCAST_NODE_WS override the node; `blockfrost` there
 * selects Blockfrost's RPC (with the project id) as before.
 */
export const BLOCKFROST: Partial<Record<Network, { indexer: string; indexerWS: string; node: string; nodeWS: string }>> = {
  preprod: {
    indexer: 'https://midnight-preprod.blockfrost.io/api/v0',
    indexerWS: 'wss://midnight-preprod.blockfrost.io/api/v0/ws',
    node: 'https://rpc.midnight-preprod.blockfrost.io',
    nodeWS: 'wss://rpc.midnight-preprod.blockfrost.io',
  },
};

/** The node endpoints for a Blockfrost-indexed network: Midnight's public RPC unless overridden. */
const nodeEndpoints = (
  base: EnvironmentConfiguration,
  blockfrost: NonNullable<(typeof BLOCKFROST)[Network]>,
  projectId: string,
): { node: string; nodeWS: string } => {
  const url = process.env.NIGHTCAST_NODE_URL?.trim();
  const ws = process.env.NIGHTCAST_NODE_WS?.trim();
  if (url === 'blockfrost' || ws === 'blockfrost') return { node: withProjectId(blockfrost.node, projectId), nodeWS: withProjectId(blockfrost.nodeWS, projectId) };
  return { node: url || base.node, nodeWS: ws || base.nodeWS };
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
        `${network} needs a Blockfrost project id (Midnight's own ${network} indexer was decommissioned on 9 October 2026).\n` +
          `  1. Sign up at https://blockfrost.io and create a project for Midnight ${network}.\n` +
          `  2. Run: ./nightcast blockfrost save --network ${network}\n` +
          `     and paste the project id when asked.`,
      );
    }
    // Network ids and the node from the testkit; the indexer replaced with Blockfrost's.
    const base = new PreprodTestEnvironment(logger).getEnvironmentConfiguration();
    return {
      ...base,
      indexer: withProjectId(blockfrost.indexer, projectId),
      indexerWS: withProjectId(blockfrost.indexerWS, projectId),
      ...nodeEndpoints(base, blockfrost, projectId),
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

/** The HTTP status the indexer gives one small question; undefined if it doesn't answer. */
const indexerStatus = async (indexer: string): Promise<number | undefined> => {
  try {
    const res = await fetch(indexer, {
      method: 'POST',
      body: '{"query":"{ __typename }"}',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return undefined;
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
 * Docker unless `proofServerPort` points at one already running on this
 * machine, or `proofServerUrl` at a remote prover (for example Lunardraw's
 * player prover, which proves one circuit and answers `/health`); `local`
 * starts a whole throwaway network (node, indexer, proof server) in Docker.
 */
export const connect = async (
  network: Network,
  opts: {
    proofServerPort?: number;
    proofServerUrl?: string;
    logger?: Logger;
    projectId?: string;
    /**
     * A service: if Blockfrost refuses the project for its request limit, wait
     * here (asking again every 15 minutes) instead of failing. See blockfrost-meter.ts.
     */
    waitForBlockfrost?: boolean;
  } = {},
): Promise<Session> => {
  const logger = opts.logger ?? createLogger();
  const webSocket = installWebSocket();
  installMeter(WsWebSocket);
  reportUsage(logger);
  setContainersConfiguration({
    ...defaultContainersConfiguration,
    proofServer: { ...defaultContainersConfiguration.proofServer, path: dockerDir, fileName: 'proof-server.yml' },
    standalone: { ...defaultContainersConfiguration.standalone, path: dockerDir, fileName: 'compose.yml' },
  });

  if (network === 'local') {
    const env = new LocalTestEnvironment(logger);
    const config = await env.start();
    return { network, logger, config, problems: [], shutdown: () => env.shutdown() };
  }

  const base = publicEndpoints(network, logger, opts.projectId);
  if (BLOCKFROST[network]) await blockfrostGate({ probe: () => indexerStatus(base.indexer), logger, wait: opts.waitForBlockfrost === true });
  const remote = opts.proofServerUrl?.replace(/\/+$/, '');
  if (remote !== undefined && !/^https?:\/\/[^\s/]+/.test(remote)) throw new Error(`not a prover address: ${opts.proofServerUrl}`);
  logger.info(
    remote ? `Using the prover at ${remote}` : opts.proofServerPort ? `Using the proof server on port ${opts.proofServerPort}` : 'Starting a proof server in Docker...',
  );
  const proofServer: { getUrl(): string; stop(): Promise<void> } = remote
    ? { getUrl: () => remote, stop: async () => undefined }
    : opts.proofServerPort
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

  return { network, logger, config, problems, remoteProver: remote !== undefined, shutdown: () => proofServer.stop() };
};

/**
 * A wallet's unshielded address (mn_addr_...) from its seed, without opening
 * it or touching the network: what to paste into the faucet.
 */
export const walletAddressOf = (network: Exclude<Network, 'local'>, seed: string): string => {
  const quiet = pino({ level: 'silent' });
  const env = (BLOCKFROST[network] ? new PreprodTestEnvironment(quiet) : new PreviewTestEnvironment(quiet)).getEnvironmentConfiguration();
  return addressFromSeed(seed, env.walletNetworkId);
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
  /**
   * Called with the wallet as soon as it's built, before it syncs: to follow
   * its state (`wallet.wallet.state()`), e.g. for a progress bar.
   */
  onWallet?: (wallet: MidnightWalletProvider) => void;
  /** Called once if the wallet has no NIGHT yet (it then waits for some to arrive). */
  onNoFunds?: (address: string) => void;
  /** Called once while waiting for the first DUST after registration. */
  onWaitingForDust?: () => void;
  /**
   * Where the wallet proves its own parts of a transaction (the DUST fee
   * spend, shielded coins): `server` (the session's proof server) or `wasm`
   * (in this process; keys and parameters are fetched from Midnight once).
   * Default: `wasm` when the session uses a remote prover, else `server`.
   */
  prover?: 'server' | 'wasm';
  /**
   * Send transactions on a fresh node connection each time, with time limits
   * and retries (see steadySubmissionService). Default: on when the session
   * uses a remote prover (agents on other people's machines), else off.
   */
  steadySubmit?: boolean;
  /**
   * Declare each fee at the time the wallet's DUST view is from (see
   * dust-time.ts): without it, a wallet whose DUST subscription lags has its
   * fees refused (node error 1010, custom 170). Default: on.
   */
  declareFeesAtDustTime?: boolean;
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
  const prover = opts.prover ?? (session.remoteProver ? 'wasm' : 'server');
  if (prover === 'wasm') session.logger.info("The wallet proves its own fees in-process (keys from Midnight's servers, fetched once).");
  const steady = opts.steadySubmit ?? session.remoteProver === true;
  const indexer = steady ? indexerPublicDataProvider(session.config.indexer, session.config.indexerWS) : undefined;
  const built = await buildWallet(
    session.config,
    session.network,
    seed,
    session.logger.child({}, { level: 'warn' }),
    persist,
    prover,
    steady
      ? {
          log: (m) => session.logger.info(m),
          // the indexer has it in a block: give it a few seconds to say so
          seen: async (txId) =>
            Promise.race([
              indexer!.watchForTxData(txId).then(() => true),
              new Promise<boolean>((r) => setTimeout(() => r(false), 10_000).unref()),
            ]),
        }
      : undefined,
  );
  const wallet = built.provider;
  const address = walletAddress(wallet);
  if (opts.declareFeesAtDustTime !== false) declareFeesAtDustTime(wallet as unknown as DustTimeWallet, session.logger);
  explainRefusals(wallet as unknown as RefusalWallet, session.logger);
  opts.onAddress?.(address);
  opts.onWallet?.(wallet);
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
  if (process.env.NIGHTCAST_REGISTER_NEW_NIGHT === '1' && state.dust.balance(new Date()) > 0n) {
    await registerNewNight(wallet, session.logger);
  }
  if (state.dust.balance(new Date()) === 0n) {
    // Registers any unregistered NIGHT for DUST generation (no faucet calls).
    await waitForFunds(wallet.wallet, { ...session.config, faucet: undefined }, false, wallet.unshieldedKeystore);
    opts.onWaitingForDust?.();
    // Say what the wallet sees every minute, so a long wait isn't silent.
    const started = Date.now();
    const dustProgress = wallet.wallet
      .state()
      .pipe(throttleTime(60_000))
      .subscribe((s) => {
        const minutes = Math.round((Date.now() - started) / 60_000);
        session.logger.info(
          `Waiting for DUST: ${s.dust.availableCoins.length} coin(s) available, ${s.dust.pendingCoins.length} pending, ` +
            `balance ${s.dust.balance(new Date())}, ${s.isSynced ? 'synced' : `syncing (${describeSync(s)})`}` +
            (minutes > 0 ? `, ${minutes} min so far` : ''),
        );
        if (minutes >= 15 && minutes < 16) {
          session.logger.warn(
            'Still no DUST after 15 minutes. If this wallet had DUST before, its saved state may be stale: stop with ' +
              `Ctrl+C and run \`./nightcast wallet forget --network ${session.network} --wallet <file>\` to sync it from the start.`,
          );
        }
      });
    try {
      await firstValueFrom(
        wallet.wallet.state().pipe(
          throttleTime(5_000),
          filter((s) => s.isSynced && s.dust.balance(new Date()) > 0n),
        ),
      );
    } finally {
      dustProgress.unsubscribe();
    }
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

/** One line on how far each part of the wallet has synced (wallet SDK 2's state, or SDK 1's). */
export const describeSync = (state: unknown): string => {
  type Part = { progress?: ProgressLike; state?: { progress?: ProgressLike } };
  const s = state as { shielded?: Part; dust?: Part; unshielded?: Part };
  const progressOf = (p: Part | undefined): ProgressLike | undefined => {
    try {
      return p?.progress ?? p?.state?.progress;
    } catch {
      return undefined; // a getter that throws before its part has started
    }
  };
  return [
    describeProgress('shielded', progressOf(s.shielded)),
    describeProgress('unshielded', progressOf(s.unshielded)),
    describeProgress('dust', progressOf(s.dust)),
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

/** The NIGHT (atoms) in a wallet state's unshielded part. */
export const nightIn = (state: { unshielded: { balances: Record<string, bigint> } }): bigint => state.unshielded.balances[unshieldedToken().raw] ?? 0n;

/**
 * The NIGHT (atoms) a wallet is in the middle of spending: coins booked for a
 * transaction that hasn't landed yet. While one is in flight the balance above
 * drops by the whole coin (a wallet with one 10,000 NIGHT coin shows 0 until
 * its change comes back), so anything judging "is this wallet low?" adds this.
 */
export const pendingNightIn = (state: { unshielded: unknown }): bigint => {
  try {
    const raw = unshieldedToken().raw;
    const pending = (state.unshielded as { pendingCoins?: readonly { utxo?: { type?: string; value?: bigint } }[] }).pendingCoins ?? [];
    return pending.reduce((sum, c) => (c.utxo?.type === raw && typeof c.utxo.value === 'bigint' ? sum + c.utxo.value : sum), 0n);
  } catch {
    return 0n;
  }
};

/**
 * Send NIGHT from this wallet to an unshielded address (`mn_addr_...`).
 * Returns the transaction id once the node has taken it.
 */
export const sendNight = async (wallet: MidnightWalletProvider, to: string, atoms: bigint, networkId: string): Promise<string> => {
  const receiverAddress = MidnightBech32m.parse(to.trim()).decode(UnshieldedAddress, networkId as never);
  const w = wallet.wallet as unknown as {
    transferTransaction(outputs: unknown[], options: { ttl: Date }): Promise<unknown>;
    signRecipe(recipe: unknown, sign: (payload: Uint8Array) => Promise<unknown>): Promise<unknown>;
    finalizeRecipe(recipe: unknown): Promise<unknown>;
    submitTransaction(tx: unknown): Promise<string>;
  };
  const ks = wallet.unshieldedKeystore as unknown as { signDataAsync(p: Uint8Array): Promise<unknown> };
  const recipe = await w.transferTransaction([{ type: 'unshielded', outputs: [{ amount: atoms, receiverAddress, type: unshieldedToken().raw }] }], {
    ttl: new Date(Date.now() + TX_TTL_SECONDS * 1000),
  });
  const signed = await w.signRecipe(recipe, (payload) => ks.signDataAsync(payload));
  return w.submitTransaction(await w.finalizeRecipe(signed));
};

type NightCoin = { utxo: { type: string }; meta: { registeredForDustGeneration?: boolean } };

/**
 * Register NIGHT UTXOs that aren't generating DUST yet. openWallet registers only when the wallet has no
 * DUST at all; this covers NIGHT that arrives later (opt-in: NIGHTCAST_REGISTER_NEW_NIGHT=1). A second
 * registered UTXO gives the wallet a second DUST coin, which the two-spend fee workaround needs
 * (deploy/scripts/patch-dust-two-spends.mjs, ledger 9 OutsideTimeToDismiss).
 */
export const registerNewNight = async (wallet: MidnightWalletProvider, logger: { info(m: string): void }): Promise<string | undefined> => {
  const state = await firstValueFrom(wallet.wallet.state().pipe(filter((s) => s.isSynced)));
  const raw = unshieldedToken().raw;
  const coins = (state.unshielded as unknown as { availableCoins: NightCoin[] }).availableCoins.filter((c) => c.utxo.type === raw);
  const unregistered = coins.filter((c) => c.meta.registeredForDustGeneration === false);
  if (unregistered.length === 0) {
    logger.info(`All ${coins.length} NIGHT UTXO(s) already generate DUST.`);
    return undefined;
  }
  logger.info(`Registering ${unregistered.length} of ${coins.length} NIGHT UTXO(s) for DUST generation...`);
  const w = wallet.wallet as unknown as {
    registerNightUtxosForDustGeneration(c: unknown[], key: unknown, sign: (p: Uint8Array) => Promise<unknown>): Promise<unknown>;
    finalizeRecipe(r: unknown): Promise<unknown>;
    submitTransaction(t: unknown): Promise<string>;
  };
  const ks = wallet.unshieldedKeystore as unknown as { getPublicKey(): unknown; signDataAsync(p: Uint8Array): Promise<unknown> };
  const recipe = await w.registerNightUtxosForDustGeneration(unregistered, ks.getPublicKey(), (p) => ks.signDataAsync(p));
  const txId = await w.submitTransaction(await w.finalizeRecipe(recipe));
  logger.info(`DUST registration sent: ${txId}. The new DUST coin appears once it lands (a minute or two).`);
  return txId;
};

/** NIGHT and DUST balances of a synced wallet, and how many coins each is in. */
export const walletBalances = async (
  wallet: MidnightWalletProvider,
): Promise<{ night: bigint; dust: bigint; nightUtxos: number; nightRegistered: number; dustCoins: number }> => {
  const state = await firstValueFrom(wallet.wallet.state().pipe(filter((s) => s.isSynced)));
  const raw = unshieldedToken().raw;
  let nightUtxos = 0;
  let nightRegistered = 0;
  let dustCoins = 0;
  try {
    const coins = (state.unshielded as unknown as { availableCoins: NightCoin[] }).availableCoins.filter((c) => c.utxo.type === raw);
    nightUtxos = coins.length;
    nightRegistered = coins.filter((c) => c.meta.registeredForDustGeneration !== false).length;
    dustCoins = state.dust.availableCoins.length;
  } catch {
    // counts are for information only
  }
  return {
    night: state.unshielded.balances[raw] ?? 0n,
    dust: state.dust.balance(new Date()),
    nightUtxos,
    nightRegistered,
    dustCoins,
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
): NightcastProviders => contractProviders<NightcastCircuits, typeof NIGHTCAST_PRIVATE_STATE_ID, NightcastPrivateState>(session, wallet, dir);

/**
 * midnight-js providers for any compiled contract whose assets (`keys/`,
 * `zkir/`) are in `dir`, paying with `wallet`. Private state is kept in
 * memory only.
 */
/** How long to wait for one proof, in ms: NIGHTCAST_PROVE_TIMEOUT_MS or an hour. */
export const proveTimeoutMs = (): number => {
  const v = Number(process.env.NIGHTCAST_PROVE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 60 * 60_000;
};

/** Transactions are valid for this long after they are built (Midnight.js's `ttlSeconds`). */
export const TX_TTL_SECONDS = 3600;

export const contractProviders = <C extends string, PSI extends string, PS>(
  session: Session,
  wallet: MidnightWalletProvider,
  dir: string,
): MidnightProviders<C, PSI, PS> => {
  // Contracts compiled with Compact 0.31 ship no contract-manifest.json, so
  // the artifacts are verified only when a manifest is present.
  const zkConfigProvider = new NodeZkConfigProvider<C>(dir, { verify: 'require-if-present' });
  return {
    privateStateProvider: inMemoryPrivateStateProvider<PSI, PS>() as MidnightProviders<C, PSI, PS>['privateStateProvider'],
    publicDataProvider: indexerPublicDataProvider(session.config.indexer, session.config.indexerWS),
    zkConfigProvider,
    // The proof server is asked over HTTP; midnight-js gives up after 5
    // minutes by default, which a big circuit (Lunardraw's computeNumbers,
    // k=19) exceeds on a home PC. Allow an hour (NIGHTCAST_PROVE_TIMEOUT_MS).
    proofProvider: httpClientProofProvider({ url: session.config.proofServer, zkConfigProvider, timeout: proveTimeoutMs() }),
    walletProvider: wallet,
    midnightProvider: wallet,
    config: { networkId: session.config.networkId, ttlSeconds: TX_TTL_SECONDS },
  };
};

