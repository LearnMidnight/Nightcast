import { describe, expect, it } from 'vitest';
import { healthOptions, isDustBehindChain, isKeyMissing, WalletHealth } from '../wallet-health.js';

/** A wallet state as wallet SDK 2 emits it, with only what the watcher reads. */
const state = (dustAt: bigint) => ({ dust: { progress: { appliedIndex: dustAt }, pendingCoins: [], balance: () => 7_000n } });

const clockAt = () => {
  const c = { now: 0, tick: (minutes: number) => (c.now += minutes * 60_000) };
  return c;
};

// The failure seen on Preprod on 14 Nov 2026 (shortened; the wallet redacts the values).
const BEHIND =
  "fulfil c42d… failed (attempt 1, retry in 5000 ms): balanceTx rejected the transaction (circuit 'fulfil'). <- (FiberFailure) Wallet.Sync: No Dust spend can be dated yet: the wallet's Dust trees hold commitment [redacted], generation [redacted], but block 3423181 reports commitment [redacted], generation [redacted] <- DustTreesNotAtBlock:";

describe('a wallet behind the chain while a request waits', () => {
  it('restarts at once when a fee fails because its DUST trees are behind the chain', () => {
    expect(isDustBehindChain(BEHIND)).toBe(true);
    expect(isDustBehindChain(new Error('Wallet.InsufficientFunds: Insufficient funds'))).toBe(false);
    const h = new WalletHealth();
    h.see(state(1n));
    expect(h.stuck()).toBeUndefined();
    h.failed(BEHIND);
    expect(h.stuck()).toBe("a fee failed because the wallet's DUST view is behind the chain");
  });

  it('is ready to pay while its DUST view moves, and not once it has stood still for answerStallMinutes', () => {
    const c = clockAt();
    const h = new WalletHealth({ dustStallMinutes: 10, answerStallMinutes: 3 }, () => c.now);
    expect(h.readyToPay()).toBeUndefined(); // not synced yet: nothing to judge
    h.see(state(1n));
    c.tick(2);
    expect(h.readyToPay()).toBeUndefined();
    h.see(state(2n));
    c.tick(2.5);
    expect(h.readyToPay()).toBeUndefined();
    expect(h.stuck()).toBeUndefined();
    c.tick(0.5);
    expect(h.readyToPay()).toBe("a request is waiting and the wallet's DUST view hasn't moved for 3 minutes");
    // ...and the service restarts on its next check, long before the 10-minute rule would.
    expect(h.stuck()).toBe("a request is waiting and the wallet's DUST view hasn't moved for 3 minutes");
  });

  it('takes the answer threshold from the environment', () => {
    expect(healthOptions({}).answerStallMinutes).toBe(3);
    expect(healthOptions({ NIGHTCAST_ANSWER_STALL_MINUTES: '5' }).answerStallMinutes).toBe(5);
    expect(healthOptions({ NIGHTCAST_ANSWER_STALL_MINUTES: 'x' }).answerStallMinutes).toBe(3);
  });
});

describe('minutes from the environment', () => {
  it('reads a positive number and falls back otherwise', async () => {
    const { minutesFromEnv } = await import('../wallet-health.js');
    expect(minutesFromEnv('4', 9)).toBe(4);
    expect(minutesFromEnv(undefined, 9)).toBe(9);
    expect(minutesFromEnv('', 9)).toBe(9);
    expect(minutesFromEnv('0', 9)).toBe(9);
    expect(minutesFromEnv('x', 9)).toBe(9);
  });
});

describe("an oracle whose key was wiped from its private state", () => {
  // The failure seen on Preprod on 16 Nov 2026, after the upkeep's bond deposit replaced the private state.
  const WIPED =
    "fulfil 17bea08f… failed (attempt 1, retry in 5000 ms): Error executing circuit 'fulfil': Nightcast: no oracle secret key in private state <- Error executing circuit 'fulfil' <- Nightcast: no oracle secret key in private state";
  it('restarts at once', () => {
    expect(isKeyMissing(WIPED)).toBe(true);
    expect(isKeyMissing(new Error('Wallet.InsufficientFunds'))).toBe(false);
    const h = new WalletHealth();
    h.failed(WIPED);
    expect(h.stuck()).toBe("an answer failed because the oracle's key is missing from its private state");
  });
});

describe('answering several at once: free fee coins and NIGHTCAST_PARALLEL', () => {
  it('counts free DUST coins that hold DUST, and never says less than one', async () => {
    const { freeDustCoins } = await import('../wallet-health.js');
    expect(freeDustCoins({ dust: { availableCoins: [{ generatedNow: 5n }, { generatedNow: 9n }] } })).toBe(2);
    expect(freeDustCoins({ dust: { availableCoins: [{ generatedNow: 5n }, { generatedNow: 0n }] } })).toBe(1);
    expect(freeDustCoins({ dust: { availableCoins: [] } })).toBe(1);
    expect(freeDustCoins({})).toBe(1);
    expect(freeDustCoins(undefined)).toBe(1);
  });
  it('reads NIGHTCAST_PARALLEL, 1 by default, between 1 and 8', async () => {
    const { parallelFromEnv } = await import('../wallet-health.js');
    expect(parallelFromEnv({})).toBe(1);
    expect(parallelFromEnv({ NIGHTCAST_PARALLEL: '2' })).toBe(2);
    expect(parallelFromEnv({ NIGHTCAST_PARALLEL: '20' })).toBe(8);
    expect(parallelFromEnv({ NIGHTCAST_PARALLEL: 'two' })).toBe(1);
    expect(parallelFromEnv({ NIGHTCAST_PARALLEL: '0' })).toBe(1);
  });
});

describe('describing the fee coins', () => {
  it('counts DUST coins holding DUST, free and booked ones, and unshielded UTXOs', async () => {
    const { describeFeeCoins } = await import('../wallet-health.js');
    const state = {
      dust: { availableCoins: [{ generatedNow: 4n }, { generatedNow: 0n }], pendingCoins: [{}] },
      unshielded: { availableCoins: [{ utxo: { type: 'n' } }, { utxo: { type: 'n' } }] },
    };
    expect(describeFeeCoins(state)).toBe('1 DUST coin(s) holding DUST of 2 free, 1 booked; 2 unshielded UTXO(s)');
    expect(describeFeeCoins({})).toBe('0 DUST coin(s) holding DUST of 0 free, 0 booked');
    expect(describeFeeCoins(undefined)).toBe('');
  });
});

describe('how quickly the oracle answers (NIGHTCAST_NEW_REQUEST_DELAY_SECS, NIGHTCAST_BUSY_POLL_SECS)', () => {
  it('keeps 20 s and 5 s by default, and takes values in range', async () => {
    const { oracleSpeedFromEnv } = await import('../wallet-health.js');
    expect(oracleSpeedFromEnv({})).toEqual({ newRequestDelaySecs: 20, busyPollSecs: 5 });
    expect(oracleSpeedFromEnv({ NIGHTCAST_NEW_REQUEST_DELAY_SECS: '5', NIGHTCAST_BUSY_POLL_SECS: '2' })).toEqual({ newRequestDelaySecs: 5, busyPollSecs: 2 });
    expect(oracleSpeedFromEnv({ NIGHTCAST_NEW_REQUEST_DELAY_SECS: '0' })).toEqual({ newRequestDelaySecs: 0, busyPollSecs: 5 });
    expect(oracleSpeedFromEnv({ NIGHTCAST_NEW_REQUEST_DELAY_SECS: '999', NIGHTCAST_BUSY_POLL_SECS: '0' })).toEqual({ newRequestDelaySecs: 60, busyPollSecs: 5 });
    expect(oracleSpeedFromEnv({ NIGHTCAST_NEW_REQUEST_DELAY_SECS: 'soon' })).toEqual({ newRequestDelaySecs: 20, busyPollSecs: 5 });
  });
});
