import { describe, expect, it } from 'vitest';
import { healthOptions, isInsufficientFunds, noticingFailures, WalletHealth } from '../wallet-health.js';
import { Watchdog } from '../mcp/serve.js';

/** A wallet state as wallet SDK 2 emits it, with only what the watcher reads. */
const state = (o: { dustAt: bigint; pending?: bigint[]; balance?: bigint }) => ({
  shielded: { progress: { appliedIndex: 1n } },
  unshielded: { progress: { appliedId: 1n } },
  dust: {
    progress: { appliedIndex: o.dustAt },
    pendingCoins: (o.pending ?? []).map((nonce) => ({ token: { nonce } })),
    balance: () => o.balance ?? 7_000n,
  },
});

const clockAt = () => {
  const c = { now: 0, tick: (minutes: number) => (c.now += minutes * 60_000) };
  return c;
};

describe('a stuck wallet', () => {
  it('is healthy while its booked coins are freed and its DUST view moves', () => {
    const c = clockAt();
    const h = new WalletHealth({ pendingMinutes: 8, dustStallMinutes: 10 }, () => c.now);
    h.see(state({ dustAt: 1n, pending: [5n] }));
    c.tick(3);
    h.see(state({ dustAt: 2n, pending: [] }));
    c.tick(6);
    h.see(state({ dustAt: 3n, pending: [6n] }));
    expect(h.stuck()).toBeUndefined();
  });

  it('is stuck when a coin stays booked too long', () => {
    const c = clockAt();
    const h = new WalletHealth({ pendingMinutes: 8, dustStallMinutes: 60 }, () => c.now);
    h.see(state({ dustAt: 1n, pending: [5n] }));
    c.tick(4);
    h.see(state({ dustAt: 2n, pending: [5n, 6n] }));
    expect(h.stuck()).toBeUndefined();
    c.tick(4);
    h.see(state({ dustAt: 3n, pending: [5n, 6n] }));
    expect(h.stuck()).toBe('a DUST coin has been booked for 8 minutes without the wallet seeing its transaction');
  });

  it("is stuck when its DUST view doesn't move", () => {
    const c = clockAt();
    const h = new WalletHealth({ pendingMinutes: 60, dustStallMinutes: 10 }, () => c.now);
    h.see(state({ dustAt: 9n }));
    c.tick(10);
    h.see(state({ dustAt: 9n }));
    expect(h.stuck()).toBe("the wallet's DUST view hasn't moved for 10 minutes");
  });

  it('is stuck when a fee fails for insufficient funds while it holds DUST, not when it is empty', () => {
    const err = Object.assign(new Error('balanceTx rejected the transaction'), { cause: new Error('Wallet.InsufficientFunds: Insufficient funds') });
    const full = new WalletHealth();
    full.see(state({ dustAt: 1n, balance: 7_000n }));
    full.failed(err);
    expect(full.stuck()).toMatch(/insufficient funds although the wallet holds DUST/);
    const empty = new WalletHealth();
    empty.see(state({ dustAt: 1n, balance: 0n }));
    empty.failed(err);
    expect(empty.stuck()).toBeUndefined();
    expect(isInsufficientFunds('fulfil x failed: balanceTx rejected <- Wallet.InsufficientFunds: Insufficient funds')).toBe(true);
    expect(isInsufficientFunds(new Error('Custom error: 138'))).toBe(false);
  });

  it('reads a state whose parts throw before they start', () => {
    const h = new WalletHealth();
    const throwing = {
      get dust(): never {
        throw new Error('not started');
      },
    };
    h.see(throwing);
    h.see({ dust: { get progress(): never { throw new Error('x'); }, get pendingCoins(): never { throw new Error('y'); } } });
    expect(h.stuck()).toBeUndefined();
  });

  it('takes its minutes from the environment', () => {
    expect(healthOptions({})).toEqual({ pendingMinutes: 8, dustStallMinutes: 10 });
    expect(healthOptions({ NIGHTCAST_PENDING_MINUTES: '3', NIGHTCAST_DUST_STALL_MINUTES: 'x' })).toEqual({ pendingMinutes: 3, dustStallMinutes: 10 });
  });

  it("passes a logger's errors and warnings on, and still logs them", () => {
    const lines: string[] = [];
    const seen: string[] = [];
    const logger = { error: (m: unknown) => lines.push(`E ${String(m)}`), warn: (m: unknown) => lines.push(`W ${String(m)}`), info: (m: unknown) => lines.push(`I ${String(m)}`) };
    const l = noticingFailures(logger, (t) => seen.push(t));
    l.error('fulfil a failed');
    l.warn('slow');
    l.info('fine');
    expect(lines).toEqual(['E fulfil a failed', 'W slow', 'I fine']);
    expect(seen).toEqual(['fulfil a failed', 'slow']);
  });
});

describe("the MCP server's watchdog", () => {
  it('asks for a restart when the wallet is stuck', () => {
    const c = clockAt();
    const w = new Watchdog(20, () => c.now, { pendingMinutes: 8, dustStallMinutes: 60 });
    w.see(state({ dustAt: 1n }));
    w.failed(Object.assign(new Error('balanceTx rejected'), { cause: new Error('Wallet.InsufficientFunds') }));
    expect(w.check()).toMatch(/insufficient funds/);
  });
});
