/**
 * `./nightcast mcp`: Nightcast as an MCP server (issue #39).
 *
 * Without --wallet it only checks requests and derives results (no chain
 * writes). With --wallet and --requester it also makes requests, from that
 * wallet. Over stdio (default) for an AI app on this computer, or over HTTP
 * (--http host:port) to host it for agents anywhere.
 *
 * A long-running wallet can stop following the chain after a dropped
 * WebSocket (Preprod, via Blockfrost, every few hours): its fees are then
 * refused (node error 1010, custom 170) until a restart. So in HTTP mode the
 * server exits with code 75 (for systemd to restart it) when the wallet's sync
 * hasn't moved for `stallMinutes`, after three requests in a row fail
 * with 170, or when its DUST coins are stuck as booked (wallet-health.ts).
 */
import type { Server } from 'node:http';
import { inspect } from 'node:util';
import type { Logger } from 'pino';
import { serveHttp } from './http.js';
import type { ServerInfo } from './rpc.js';
import { serveStdio } from './stdio.js';
import { DEFAULT_LIMITS, INSTRUCTIONS, type Limits, MCP_VERSION, nightcastTools, type RandomnessBackend } from './tools.js';
import { type HealthOptions, WalletHealth } from '../wallet-health.js';

export const SERVER_INFO: ServerInfo = { name: 'nightcast', title: 'Nightcast: verifiable randomness', version: MCP_VERSION };

/** Exit code asking the service manager for a restart. */
export const RESTART = 75;

export type McpMode = { kind: 'stdio'; out: (s: string) => boolean } | { kind: 'http'; host: string; port: number; trustProxy: boolean; origins: string[] };

/** The wallet parts the watchdog follows. */
type Subscribable = { subscribe(next: (s: unknown) => void): { unsubscribe(): void } };

type Progress = { appliedIndex?: bigint; appliedId?: bigint };
/** A wallet part: wallet SDK 2 has `progress` on the part itself, SDK 1 had it under `state`. */
type Part = { progress?: Progress; state?: { progress?: Progress } };
const progressOf = (p: Part | undefined): Progress | undefined => {
  try {
    return p?.progress ?? p?.state?.progress;
  } catch {
    return undefined; // a getter that throws before its part has started
  }
};
/**
 * How far each part of the wallet has applied the chain's events (changes as it follows the chain).
 * Reads wallet SDK 2's state (and SDK 1's): with SDK 1's paths only the unshielded part showed on
 * SDK 2, so a long DUST sync looked stalled and the watchdog restarted the server.
 */
export const positionsOf = (state: unknown): string => {
  const s = state as { shielded?: Part; dust?: Part; unshielded?: Part };
  const pos = (p: Progress | undefined) => String(p?.appliedIndex ?? p?.appliedId ?? '?');
  return `shielded:${pos(progressOf(s.shielded))}|unshielded:${pos(progressOf(s.unshielded))}|dust:${pos(progressOf(s.dust))}`;
};

/** Whether an error is the node's stale-fee refusal (it's often only in the error's text, not its message). */
export const isStaleFee = (err: unknown): boolean => /Custom error: 170\b/.test(`${String(err)} ${inspect(err, { depth: 6 })}`);

/** Follows a wallet and the submissions, and says when a restart is due. */
export class Watchdog {
  private positions = '';
  private movedAt: number;
  private staleInARow = 0;
  restartFor?: string;

  /** Only when asked for (the HTTP server's wallet): restarts for coins stuck as booked, wallet-health.ts. */
  private readonly health?: WalletHealth;

  constructor(
    private readonly stallMinutes: number,
    private readonly clock: () => number = Date.now,
    health?: HealthOptions,
  ) {
    this.movedAt = clock();
    if (health) this.health = new WalletHealth(health, clock);
  }

  see(state: unknown): void {
    this.health?.see(state);
    const p = positionsOf(state);
    if (p !== this.positions) {
      this.positions = p;
      this.movedAt = this.clock();
    }
  }

  submitted(): void {
    this.staleInARow = 0;
  }

  failed(err: unknown): void {
    this.health?.failed(err);
    if (isStaleFee(err)) this.staleInARow += 1;
    if (this.staleInARow >= 3) this.restartFor ??= 'three requests in a row were refused for a stale fee (node error 170)';
  }

  /** A reason to restart now, if there is one. */
  check(): string | undefined {
    const stalled = (this.clock() - this.movedAt) / 60_000;
    if (this.positions !== '' && stalled >= this.stallMinutes) this.restartFor ??= `the wallet's sync hasn't moved for ${Math.floor(stalled)} minutes`;
    this.restartFor ??= this.health?.stuck();
    return this.restartFor;
  }
}

export const runMcp = async (o: {
  backend: RandomnessBackend;
  mode: McpMode;
  logger: Logger;
  limits?: Partial<Limits>;
  /** The open wallet's state stream, for the watchdog (HTTP mode). */
  walletState?: Promise<Subscribable>;
  watchdog?: Watchdog;
  /** The wallet's address and NIGHT (atoms), once it is open: shown on /health for whoever tops it up. */
  walletInfo?: () => { address: string; night: string } | undefined;
}): Promise<number> => {
  const tools = nightcastTools(o.backend, o.limits);
  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  if (o.mode.kind === 'stdio') {
    o.logger.info(`Nightcast MCP server (stdio) for ${o.backend.network} at ${o.backend.contractAddress}${o.backend.canRequest ? '' : ' (read-only: no wallet)'}`);
    await serveStdio(tools, SERVER_INFO, INSTRUCTIONS, o.mode.out);
    return 0;
  }
  const server: Server = await serveHttp(tools, SERVER_INFO, INSTRUCTIONS, {
    host: o.mode.host,
    port: o.mode.port,
    trustProxy: o.mode.trustProxy,
    origins: o.mode.origins,
    health: () => ({
      ...(o.backend.stateReads ? { stateReads: o.backend.stateReads() } : {}),
      network: o.backend.network,
      contract: o.backend.contractAddress,
      canRequest: o.backend.canRequest && !o.backend.notReady?.(),
      version: MCP_VERSION,
      ...(o.walletInfo?.() ?? {}),
    }),
  });
  o.logger.info(
    `Nightcast MCP server on http://${o.mode.host}:${o.mode.port}/mcp for ${o.backend.network} at ${o.backend.contractAddress}` +
      (o.backend.canRequest ? `; requests: ${limits.requestsPerClientHour}/hour per client, ${limits.requestsPerDay}/day in all` : ' (read-only: no wallet)'),
  );
  let sub: { unsubscribe(): void } | undefined;
  void o.walletState?.then((s) => {
    sub = s.subscribe((state) => o.watchdog?.see(state));
  }, () => undefined);
  const code = await new Promise<number>((resolve) => {
    const timer = setInterval(() => {
      const why = o.watchdog?.check();
      if (why) {
        o.logger.error(`Restarting: ${why} (exit ${RESTART}; the service manager starts it again, which resyncs the wallet).`);
        clearInterval(timer);
        resolve(RESTART);
      }
    }, 30_000);
    const stop = () => {
      clearInterval(timer);
      resolve(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  sub?.unsubscribe();
  await new Promise<void>((r) => server.close(() => r()));
  return code;
};
