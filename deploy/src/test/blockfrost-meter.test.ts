import { mkdtempSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blockfrostGate,
  BlockfrostMeter,
  installMeter,
  isBlockfrostHost,
  isOverLimit,
  overLimitReason,
  readUsage,
  requestTarget,
  saveUsage,
  usageLine,
} from '../blockfrost-meter.js';

const at = (h: number, m = 0, day = 12) => Date.UTC(2026, 10, day, h, m, 0);

describe('the Blockfrost meter', () => {
  it('counts requests, connections and messages for the UTC day', () => {
    let now = at(8);
    const m = new BlockfrostMeter(() => now);
    m.request('http');
    m.answered(200);
    m.request('http');
    m.answered(200);
    m.request('socket');
    m.answered(101);
    m.message('in');
    m.message('in');
    m.message('out');
    expect(m.usage()).toEqual({ day: '2026-11-12', at: '2026-11-12T08:00:00.000Z', http: 2, sockets: 1, messagesIn: 2, messagesOut: 1, refused: 0 });
    expect(usageLine(m.usage())).toBe('Blockfrost today (UTC 2026-11-12): about 3 counted against the limit (2 request(s) and 1 message(s) sent); 1 connection(s), 2 message(s) received');
    // Blockfrost's day ends at midnight UTC: the counts start again
    now = at(0, 1, 13);
    m.request('http');
    expect(m.usage()).toMatchObject({ day: '2026-11-13', http: 1, sockets: 0, messagesIn: 0 });
  });

  it('remembers a refusal for the limit until Blockfrost accepts a request again', () => {
    let now = at(8);
    const m = new BlockfrostMeter(() => now);
    m.request('http');
    m.answered(200);
    expect(m.overLimit()).toBeUndefined();
    m.request('http');
    m.answered(402);
    now = at(8, 1);
    m.request('socket');
    m.answered(402);
    expect(m.overLimit()).toEqual({ since: at(8), status: 402 });
    expect(m.usage()).toMatchObject({ refused: 2, overLimitSince: '2026-11-12T08:00:00.000Z', overLimitStatus: 402 });
    expect(usageLine(m.usage())).toContain('2 refused for the limit');
    // a service's check gives it two minutes before stopping to wait
    expect(overLimitReason(m, at(8, 1))).toBeUndefined();
    expect(overLimitReason(m, at(8, 2))).toMatch(/over its daily request limit \(HTTP 402/);
    // other failures are not the limit, and don't clear it either
    m.answered(500);
    m.answered(undefined);
    expect(m.overLimit()?.status).toBe(402);
    m.answered(418);
    expect(overLimitReason(m, at(8, 5))).toMatch(/banned this address/);
    m.answered(200);
    expect(m.overLimit()).toBeUndefined();
    expect(overLimitReason(m, at(9))).toBeUndefined();
    expect([isOverLimit(402), isOverLimit(418), isOverLimit(429), isOverLimit(undefined)]).toEqual([true, true, false, false]);
  });

  it("carries on from the same day's saved counts after a restart, and not from another day's", () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightcast-usage-'));
    const file = join(dir, 'usage', 'oracle.json');
    const before = new BlockfrostMeter(() => at(8));
    for (let i = 0; i < 5; i++) before.request('http');
    before.request('socket');
    saveUsage(file, before.usage());
    expect(readUsage(file)).toMatchObject({ day: '2026-11-12', http: 5, sockets: 1 });

    const after = new BlockfrostMeter(() => at(9));
    after.load(readUsage(file));
    after.request('http');
    expect(after.usage()).toMatchObject({ http: 6, sockets: 1 });

    const nextDay = new BlockfrostMeter(() => at(1, 0, 13));
    nextDay.load(readUsage(file));
    expect(nextDay.usage()).toMatchObject({ day: '2026-11-13', http: 0, sockets: 0 });
    // a missing or broken file is just no history
    expect(readUsage(join(dir, 'none.json'))).toBeUndefined();
    nextDay.load(undefined);
    nextDay.load({ day: '2026-11-13', http: Number.NaN, sockets: -4 });
    expect(nextDay.usage()).toMatchObject({ http: 0, sockets: 0 });
    expect(before.changed()).toBe(true);
    expect(before.changed()).toBe(false);
  });

  it('knows a Blockfrost host and a WebSocket handshake when it sees one', () => {
    expect(isBlockfrostHost('midnight-preprod.blockfrost.io')).toBe(true);
    expect(isBlockfrostHost('rpc.midnight-preprod.blockfrost.io:443')).toBe(true);
    expect(isBlockfrostHost('blockfrost.io')).toBe(true);
    expect(isBlockfrostHost('notblockfrost.io')).toBe(false);
    expect(isBlockfrostHost('rpc.preprod.midnight.network')).toBe(false);
    expect(isBlockfrostHost(undefined)).toBe(false);

    expect(requestTarget(['https://midnight-preprod.blockfrost.io/api/v0?project_id=x'])).toEqual({ host: 'midnight-preprod.blockfrost.io', upgrade: false });
    expect(requestTarget([new URL('https://midnight-preprod.blockfrost.io/api/v0'), { headers: { accept: '*/*' } }])).toEqual({ host: 'midnight-preprod.blockfrost.io', upgrade: false });
    // what the `ws` package passes for its handshake
    expect(requestTarget([{ host: 'midnight-preprod.blockfrost.io', port: 443, headers: { Connection: 'Upgrade', Upgrade: 'websocket' } }])).toEqual({
      host: 'midnight-preprod.blockfrost.io',
      upgrade: true,
    });
    expect(requestTarget([{ hostname: 'example.org' }])).toEqual({ host: 'example.org', upgrade: false });
    expect(requestTarget([])).toEqual({ host: undefined, upgrade: false });
  });

  it('counts where the requests leave: fetch, https.request and the ws sockets', async () => {
    const m = new BlockfrostMeter(() => at(8));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => ({ status: String(input).includes('blockfrost') ? 402 : 200 })) as unknown as typeof fetch;
    class FakeSocket {
      events: string[] = [];
      sent: unknown[] = [];
      constructor(readonly url: string) {}
      emit(event: string): boolean {
        this.events.push(event);
        return true;
      }
      send(data: unknown): void {
        this.sent.push(data);
      }
    }
    try {
      installMeter(undefined, m); // a program without a wallet: requests only
      installMeter(FakeSocket, m); // and again once there are sockets: nothing is counted twice
      installMeter(FakeSocket, m);
      await fetch('https://midnight-preprod.blockfrost.io/api/v0?project_id=abc', { method: 'POST' });
      await fetch('https://rpc.preprod.midnight.network');
      expect(m.usage()).toMatchObject({ http: 1, refused: 1 });
      expect(m.overLimit()?.status).toBe(402);

      const ours = new FakeSocket('wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=abc');
      const other = new FakeSocket('wss://rpc.preprod.midnight.network');
      ours.emit('open');
      ours.emit('message');
      ours.emit('message');
      ours.send('{"type":"ping"}');
      other.emit('message');
      other.send('x');
      expect(m.usage()).toMatchObject({ messagesIn: 2, messagesOut: 1 });
      expect([ours.events, ours.sent, other.events]).toEqual([['open', 'message', 'message'], ['{"type":"ping"}'], ['message']]);

      // an HTTPS request and a WebSocket handshake, dropped before they go anywhere
      for (const headers of [{}, { Connection: 'Upgrade', Upgrade: 'websocket' }]) {
        const req = https.request({ host: 'midnight-preprod.blockfrost.io', port: 443, path: '/api/v0', headers });
        req.on('error', () => undefined);
        req.destroy();
      }
      const elsewhere = https.request({ host: 'rpc.preprod.midnight.network', port: 443 });
      elsewhere.on('error', () => undefined);
      elsewhere.destroy();
      expect(m.usage()).toMatchObject({ http: 2, sockets: 1 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the gate before a wallet is opened', () => {
  const quiet = () => {
    const lines: string[] = [];
    const say = (level: string) => (msg: string) => void lines.push(`${level}: ${msg}`);
    return { lines, logger: { info: say('info'), warn: say('warn'), error: say('error') } };
  };

  it('lets everything through when Blockfrost answers, or when the trouble is something else', async () => {
    for (const status of [200, 403, 500, undefined]) {
      const { lines, logger } = quiet();
      let asked = 0;
      await blockfrostGate({ probe: async () => (asked++, status), logger, wait: false });
      expect([asked, lines]).toEqual([1, []]);
    }
  });

  it('stops a one-off command with the reason', async () => {
    const { logger } = quiet();
    await expect(blockfrostGate({ probe: async () => 402, logger, wait: false })).rejects.toThrow(/over its daily request limit \(HTTP 402, "Project Over Limit"\).*midnight to midnight UTC/s);
    await expect(blockfrostGate({ probe: async () => 418, logger, wait: false })).rejects.toThrow(/banned this address/);
  });

  it('holds a service, asking once every 15 minutes, until Blockfrost answers again', async () => {
    const { lines, logger } = quiet();
    const answers = [402, 402, 402, 402, 402, 200];
    const slept: number[] = [];
    let asked = 0;
    await blockfrostGate({
      probe: async () => answers[asked++],
      logger,
      wait: true,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(asked).toBe(6);
    expect(slept).toEqual(Array(5).fill(15 * 60_000));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^error: Blockfrost refuses this project: it is over its daily request limit .* asking again every 15 minutes/);
    expect(lines[1]).toBe("warn: Still refused by Blockfrost for its request limit (60 minutes so far).");
    expect(lines[2]).toBe('info: Blockfrost answers again after 75 minutes: carrying on.');
  });
});
