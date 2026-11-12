/**
 * Counting what this process asks of Blockfrost, and noticing when Blockfrost
 * says no.
 *
 * Preprod is read through Blockfrost, and a Blockfrost project has a daily
 * request allowance (50,000 on the free plan; the day runs midnight to
 * midnight UTC). Past it, every request is answered `402 Project Over Limit`,
 * and a wallet then sits at "connecting" for ever with nothing in the log
 * saying why. An address that keeps knocking after a 402 can be banned (418).
 *
 * On 12 Nov 2026 that stopped every service on the VM for 17 hours: 140,000
 * and 108,000 requests on the two days before, against 50,000. Nobody could
 * say which service had used them. So:
 *
 *  - every request to Blockfrost is counted here (HTTP requests, WebSocket
 *    connections, WebSocket messages), per UTC day, logged hourly and kept in
 *    a small file (NIGHTCAST_BLOCKFROST_USAGE) that a monitor can add up;
 *  - a 402 or 418 is remembered, so a service can say so plainly and stop
 *    knocking (see blockfrostGate).
 *
 * Counted where the requests leave: `https.request` (node-fetch, cross-fetch
 * and the `ws` package's handshake all go through it), the global `fetch`,
 * and the `ws` package's sockets.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';

export type UsageCounts = {
  /** HTTP requests (GraphQL queries to the indexer). */
  http: number;
  /** WebSocket connections opened (each wallet part and each subscription client is one). */
  sockets: number;
  /** WebSocket messages received and sent on those connections. */
  messagesIn: number;
  messagesOut: number;
  /** Of the requests and connections, how many Blockfrost refused for the limit (402) or a ban (418). */
  refused: number;
};

export type Usage = UsageCounts & {
  /** The UTC day these counts are for (YYYY-MM-DD): Blockfrost's day. */
  day: string;
  /** When this was last written. */
  at: string;
  /** Set while Blockfrost is refusing the project: when it started, and with which status. */
  overLimitSince?: string;
  overLimitStatus?: number;
};

const zero = (): UsageCounts => ({ http: 0, sockets: 0, messagesIn: 0, messagesOut: 0, refused: 0 });

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A Blockfrost host (midnight-preprod.blockfrost.io and the like). */
export const isBlockfrostHost = (host: string | undefined): boolean => !!host && /(^|\.)blockfrost\.io$/i.test(host.replace(/:\d+$/, ''));

/** The statuses that mean "stop asking": over the daily limit, or banned for asking on regardless. */
export const isOverLimit = (status: number | undefined): boolean => status === 402 || status === 418;

/** What a refusal means, in words. */
export const overLimitText = (status: number): string =>
  status === 418
    ? 'Blockfrost has banned this address for sending too much after the project went over its request limit (HTTP 418)'
    : 'Blockfrost refuses this project: it is over its daily request limit (HTTP 402, "Project Over Limit")';

export class BlockfrostMeter {
  private counts = zero();
  private day: string;
  private over?: { since: number; status: number };
  private dirty = false;

  constructor(private readonly clock: () => number = Date.now) {
    this.day = dayOf(clock());
  }

  private roll(): void {
    const today = dayOf(this.clock());
    if (today !== this.day) {
      this.day = today;
      this.counts = zero();
    }
  }

  /** A request is leaving for Blockfrost. */
  request(kind: 'http' | 'socket'): void {
    this.roll();
    if (kind === 'http') this.counts.http += 1;
    else this.counts.sockets += 1;
    this.dirty = true;
  }

  /** Blockfrost answered a request (101 for a WebSocket that opened). */
  answered(status: number | undefined): void {
    if (status === undefined) return;
    this.roll();
    if (isOverLimit(status)) {
      this.counts.refused += 1;
      this.over ??= { since: this.clock(), status };
      this.over.status = status;
    } else if (status < 400) {
      this.over = undefined;
    }
    this.dirty = true;
  }

  message(direction: 'in' | 'out'): void {
    this.roll();
    if (direction === 'in') this.counts.messagesIn += 1;
    else this.counts.messagesOut += 1;
    this.dirty = true;
  }

  /** Set while Blockfrost is refusing the project (cleared by the next request it accepts). */
  overLimit(): { since: number; status: number } | undefined {
    return this.over ? { ...this.over } : undefined;
  }

  usage(): Usage {
    this.roll();
    return {
      day: this.day,
      at: new Date(this.clock()).toISOString(),
      ...this.counts,
      ...(this.over ? { overLimitSince: new Date(this.over.since).toISOString(), overLimitStatus: this.over.status } : {}),
    };
  }

  /** Carry on from a saved count of the same day (a restart mustn't hide what was used before it). */
  load(saved: Partial<Usage> | undefined): void {
    this.roll();
    if (!saved || saved.day !== this.day) return;
    for (const k of Object.keys(this.counts) as (keyof UsageCounts)[]) {
      const v = saved[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) this.counts[k] += Math.floor(v);
    }
  }

  /** True once since the last call if anything was counted (for the saver). */
  changed(): boolean {
    const d = this.dirty;
    this.dirty = false;
    return d;
  }
}

/** One line for the log: today's counts. */
export const usageLine = (u: Usage): string =>
  `Blockfrost today (UTC ${u.day}): ${u.http} request(s), ${u.sockets} connection(s), ${u.messagesIn} message(s) received and ${u.messagesOut} sent` +
  (u.refused ? `; ${u.refused} refused for the limit` : '');

/** The process's meter. */
export const meter = new BlockfrostMeter();

/** The host and whether it's a WebSocket handshake, from the arguments of `https.request`. */
export const requestTarget = (args: readonly unknown[]): { host?: string; upgrade: boolean } => {
  let host: string | undefined;
  let upgrade = false;
  for (const a of args.slice(0, 2)) {
    if (typeof a === 'string') {
      try {
        host ??= new URL(a).hostname;
      } catch {
        // not a URL
      }
    } else if (a instanceof URL) {
      host ??= a.hostname;
    } else if (a && typeof a === 'object') {
      const o = a as { hostname?: unknown; host?: unknown; headers?: unknown };
      const h = typeof o.hostname === 'string' ? o.hostname : typeof o.host === 'string' ? o.host : undefined;
      host ??= h?.replace(/:\d+$/, '');
      if (o.headers && typeof o.headers === 'object' && !Array.isArray(o.headers)) {
        for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
          if (k.toLowerCase() === 'upgrade' && String(v).toLowerCase() === 'websocket') upgrade = true;
        }
      }
    }
  }
  return { host, upgrade };
};

const hostOfFetch = (input: unknown): string | undefined => {
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string } | undefined)?.url;
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
};

type Emitterish = { once(event: string, listener: (...args: never[]) => void): unknown };
type WsClass = { prototype: { emit(event: string, ...rest: unknown[]): boolean; send(...args: unknown[]): unknown } };

let requestsCounted = false;
let socketsCounted = false;

/**
 * Start counting. `ws` is the `ws` package's WebSocket class, for the message
 * counts. Each part is fitted once per process, so a program may call this
 * early without the class and `connect` again with it. Never throws: a meter
 * that can't be fitted must not stop the service.
 */
export const installMeter = (ws?: unknown, m: BlockfrostMeter = meter): void => {
  if (!requestsCounted) {
    requestsCounted = true;
    countRequests(m);
  }
  if (ws && !socketsCounted) {
    socketsCounted = true;
    countMessages(ws, m);
  }
};

const countRequests = (m: BlockfrostMeter): void => {
  try {
    const wrap = <F extends (...args: never[]) => unknown>(original: F): F =>
      function (this: unknown, ...args: unknown[]) {
        const req = (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
        try {
          const { host, upgrade } = requestTarget(args);
          if (isBlockfrostHost(host)) {
            m.request(upgrade ? 'socket' : 'http');
            const r = req as Emitterish;
            // Listeners are only added where the caller has its own (node-fetch and ws both do), so nothing is left unread.
            r.once('response', ((res: { statusCode?: number }) => m.answered(res.statusCode)) as never);
            if (upgrade) r.once('upgrade', (() => m.answered(101)) as never);
          }
        } catch {
          // counting only
        }
        return req;
      } as unknown as F;
    https.request = wrap(https.request);
    https.get = wrap(https.get);
    syncBuiltinESMExports();
  } catch {
    // counting only
  }
  try {
    const original = globalThis.fetch;
    if (typeof original === 'function') {
      globalThis.fetch = (async (input: unknown, init?: unknown) => {
        if (!isBlockfrostHost(hostOfFetch(input))) return (original as (...a: unknown[]) => Promise<Response>)(input, init);
        m.request('http');
        const res = await (original as (...a: unknown[]) => Promise<Response>)(input, init);
        m.answered(res.status);
        return res;
      }) as typeof fetch;
    }
  } catch {
    // counting only
  }
};

const countMessages = (ws: unknown, m: BlockfrostMeter): void => {
  try {
    const proto = (ws as WsClass | undefined)?.prototype;
    if (proto && typeof proto.emit === 'function' && typeof proto.send === 'function') {
      const ours = new WeakMap<object, boolean>();
      const isOurs = (socket: object): boolean => {
        let known = ours.get(socket);
        if (known === undefined) {
          try {
            known = isBlockfrostHost(new URL(String((socket as { url?: unknown }).url)).hostname);
          } catch {
            known = false;
          }
          ours.set(socket, known);
        }
        return known;
      };
      const emit = proto.emit;
      proto.emit = function (this: object, event: string, ...rest: unknown[]): boolean {
        if (event === 'message' && isOurs(this)) m.message('in');
        return emit.call(this, event, ...rest);
      };
      const send = proto.send;
      proto.send = function (this: object, ...args: unknown[]): unknown {
        if (isOurs(this)) m.message('out');
        return send.apply(this, args);
      };
    }
  } catch {
    // counting only
  }
};

/** Write the counts in one step (a reader never sees half a file). */
export const saveUsage = (file: string, u: Usage): void => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(u)}\n`);
  renameSync(tmp, file);
};

export const readUsage = (file: string): Partial<Usage> | undefined => {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? (v as Partial<Usage>) : undefined;
  } catch {
    return undefined;
  }
};

type Log = { info(msg: string): void };

let reporting = false;

/**
 * Keep the counts in NIGHTCAST_BLOCKFROST_USAGE (if set): carried on from the
 * same day's file at the start, saved every minute and when the process ends.
 * Logs the day's counts every hour. Once per process.
 */
export const reportUsage = (logger: Log, env: NodeJS.ProcessEnv = process.env, m: BlockfrostMeter = meter): void => {
  if (reporting) return;
  reporting = true;
  const file = env.NIGHTCAST_BLOCKFROST_USAGE?.trim();
  if (file) {
    m.load(readUsage(file));
    const save = (): void => {
      try {
        saveUsage(file, m.usage());
      } catch {
        // the next minute tries again
      }
    };
    setInterval(() => {
      if (m.changed()) save();
    }, 60_000).unref();
    process.once('exit', save);
  }
  setInterval(() => logger.info(usageLine(m.usage())), 3_600_000).unref();
};

/**
 * For a running service's regular check: the reason to stop and wait, once
 * Blockfrost has refused the project for `graceMs` with nothing accepted
 * since. The service exits for a restart, and blockfrostGate holds the new
 * process until Blockfrost answers again.
 */
export const overLimitReason = (m: BlockfrostMeter = meter, now: number = Date.now(), graceMs = 120_000): string | undefined => {
  const over = m.overLimit();
  return over && now - over.since >= graceMs ? overLimitText(over.status) : undefined;
};

/** How long a service waits between looks while Blockfrost is refusing the project. */
export const OVER_LIMIT_WAIT_MS = 15 * 60_000;

/**
 * Before anything is opened: ask Blockfrost one small question. If it refuses
 * the project for its limit, either wait here (a service: one question every
 * 15 minutes, nothing else) or stop with the reason (a one-off command).
 * Any other answer, or none, is left to the usual checks.
 */
export const blockfrostGate = async (
  o: {
    /** Asks the indexer one small question; its HTTP status, or undefined if it didn't answer. */
    probe: () => Promise<number | undefined>;
    logger: { warn(msg: string): void; error(msg: string): void; info(msg: string): void };
    /** Wait until Blockfrost lets the project back in, instead of throwing. */
    wait: boolean;
    sleep?: (ms: number) => Promise<void>;
    waitMs?: number;
  },
): Promise<void> => {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = o.waitMs ?? OVER_LIMIT_WAIT_MS;
  const advice = "Its day runs midnight to midnight UTC; the project's usage is on its Blockfrost dashboard";
  for (let n = 0; ; n++) {
    const status = await o.probe();
    if (!isOverLimit(status)) {
      if (n > 0) o.logger.info(`Blockfrost answers again after ${Math.round((n * waitMs) / 60_000)} minutes: carrying on.`);
      return;
    }
    const what = overLimitText(status as number);
    if (!o.wait) throw new Error(`${what}. Nothing can be read from the network until it lets the project back in. ${advice}.`);
    if (n === 0) {
      o.logger.error(`${what}. Waiting here without opening the wallet, and asking again every ${Math.round(waitMs / 60_000)} minutes. ${advice}.`);
    } else if (n % 4 === 0) {
      o.logger.warn(`Still refused by Blockfrost for its request limit (${Math.round((n * waitMs) / 60_000)} minutes so far).`);
    }
    await sleep(waitMs);
  }
};
