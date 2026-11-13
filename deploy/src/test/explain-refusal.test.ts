import { describe, expect, it } from 'vitest';
import { balanceReport, explainRefusals, isRefusal } from '../explain-refusal.js';
import { failureText, feeSettings, timerSettings } from '../wallet.js';

const refusal = () => Object.assign(new Error('Transaction submission error'), { cause: new Error('1010: Invalid Transaction: Custom error: 138') });

const walletWith = (submit: () => Promise<unknown>, validate?: () => Promise<unknown>) => {
  const checked: unknown[] = [];
  const wallet = {
    wallet: {
      submitTransaction: (_tx: unknown) => submit(),
      ...(validate
        ? {
            validateTransaction: (tx: unknown, options: unknown) => {
              checked.push([tx, options]);
              return validate();
            },
          }
        : {}),
    },
  };
  return { wallet, checked };
};

describe('explaining a refused transaction', () => {
  it('tells a refusal from a lost connection', () => {
    expect(isRefusal(refusal())).toBe(true);
    expect(isRefusal(new Error('disconnected: 1000 Normal Closure'))).toBe(false);
  });

  it("logs what the wallet's own check says, and still fails with the node's error", async () => {
    const logs: string[] = [];
    const err = refusal();
    const { wallet, checked } = walletWith(
      () => Promise.reject(err),
      () => Promise.reject(Object.assign(new Error('WellFormedError'), { cause: new Error('balance check failed: segment 0 overspends Dust by 12') })),
    );
    explainRefusals(wallet, { warn: (m) => logs.push(m) });
    await expect(wallet.wallet.submitTransaction('tx')).rejects.toBe(err);
    expect(checked).toEqual([['tx', { flags: { enforceBalancing: true, verifySignatures: true, enforceLimits: true } }]]);
    expect(logs[0]).toBe("the node refused the transaction; the wallet's own check of it says: WellFormedError: balance check failed: segment 0 overspends Dust by 12");
    expect(logs).toHaveLength(2);
  });

  it("says so when the wallet's own check passes", async () => {
    const logs: string[] = [];
    const { wallet } = walletWith(() => Promise.reject(refusal()), () => Promise.resolve());
    explainRefusals(wallet, { warn: (m) => logs.push(m) });
    await expect(wallet.wallet.submitTransaction('tx')).rejects.toThrow();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("the wallet's own check of it passes");
  });

  it('leaves successes and other failures alone, and can be undone', async () => {
    const logs: string[] = [];
    const ok = walletWith(() => Promise.resolve('id'), () => Promise.reject(new Error('never asked')));
    explainRefusals(ok.wallet, { warn: (m) => logs.push(m) });
    await expect(ok.wallet.wallet.submitTransaction('tx')).resolves.toBe('id');
    const lost = walletWith(() => Promise.reject(new Error('disconnected: 1000 Normal Closure')), () => Promise.resolve());
    const original = lost.wallet.wallet.submitTransaction;
    const undo = explainRefusals(lost.wallet, { warn: (m) => logs.push(m) });
    await expect(lost.wallet.wallet.submitTransaction('tx')).rejects.toThrow('disconnected');
    expect(logs).toEqual([]);
    expect(ok.checked).toEqual([]);
    undo();
    expect(lost.wallet.wallet.submitTransaction).toBe(original);
  });
});

describe('the figures of a refused transaction', () => {
  const tx = {
    intents: new Map([[1, { dustActions: { spends: [{}, {}] } }]]),
    imbalances: (segment: number) =>
      segment === 0
        ? new Map<{ tag: string; raw?: string }, bigint>([[{ tag: 'dust' }, 900n], [{ tag: 'unshielded', raw: '0'.repeat(64) }, 0n]])
        : new Map<{ tag: string; raw?: string }, bigint>([[{ tag: 'unshielded', raw: '0'.repeat(64) }, -100000n]]),
    fees: () => 1000n,
    feesWithMargin: (_p: unknown, margin: number) => 1000n + BigInt(margin),
  };

  it('lists every balance, the spends and the fee at the priced block', () => {
    const priced = { height: 77, timestamp: new Date(1_000_000), ledgerParameters: { feePrices: { overallPrice: 10 } } };
    expect(balanceReport(tx, priced, 1_060_000)).toBe(
      'balances before the fee: DUST 900 in segment 0, NIGHT 0 in segment 0, NIGHT -100000 in segment 1; 2 DUST spend(s); ' +
        'fee at the block it was priced at (height 77, 60 s old, overall price 10): 1000, or 1005 with a 5-block margin',
    );
    expect(balanceReport(tx, undefined, 0)).toBe('balances before the fee: DUST 900 in segment 0, NIGHT 0 in segment 0, NIGHT -100000 in segment 1; 2 DUST spend(s)');
  });

  it('remembers the block the fee was priced at and reports with it', async () => {
    const logs: string[] = [];
    const wallet = {
      wallet: {
        submitTransaction: (_tx: unknown) => Promise.reject(Object.assign(new Error('x'), { cause: new Error('1010: Invalid Transaction: Custom error: 138') })),
        accept: (handle: unknown) => (handle as { inner: unknown }).inner,
        calculateTransactionFee: () => Promise.resolve(1234n),
        dust: { balanceTransactions: (..._args: unknown[]) => Promise.resolve({ transaction: 'fee', blockData: { height: 5, ledgerParameters: { feePrices: { overallPrice: 2 } } } }) },
      },
    };
    const undo = explainRefusals(wallet, { warn: (m) => logs.push(m) }, () => 0);
    await expect(wallet.wallet.dust.balanceTransactions('key', [], new Date(0))).resolves.toMatchObject({ transaction: 'fee' });
    await expect(wallet.wallet.submitTransaction({ inner: tx })).rejects.toThrow();
    expect(logs[1]).toContain('the refused transaction: balances before the fee: DUST 900 in segment 0');
    expect(logs[1]).toContain('fee at the block it was priced at (height 5, overall price 2): 1000, or 1005 with a 5-block margin');
    expect(logs[1]).toContain("fee at the chain's latest block now, with the wallet's margin: 1234");
    undo();
  });
});

describe('fee settings from the environment', () => {
  it('defaults to a 5-block margin and no overhead', () => {
    expect(feeSettings({})).toEqual({ additionalFeeOverhead: 0n, feeBlocksMargin: 5 });
    expect(feeSettings({ NIGHTCAST_FEE_MARGIN_BLOCKS: 'lots', NIGHTCAST_FEE_OVERHEAD_SPECKS: '-5' })).toEqual({ additionalFeeOverhead: 0n, feeBlocksMargin: 5 });
    expect(feeSettings({ NIGHTCAST_FEE_MARGIN_BLOCKS: '501' }).feeBlocksMargin).toBe(5);
  });
  it('takes a margin in blocks and an overhead in specks', () => {
    expect(feeSettings({ NIGHTCAST_FEE_MARGIN_BLOCKS: '40', NIGHTCAST_FEE_OVERHEAD_SPECKS: '1000000000000000' })).toEqual({ additionalFeeOverhead: 1000000000000000n, feeBlocksMargin: 40 });
    expect(feeSettings({ NIGHTCAST_FEE_MARGIN_BLOCKS: '0' }).feeBlocksMargin).toBe(0);
  });
});

describe("the wallet's own timers", () => {
  it('asks the indexer every 10 and every 2 minutes, not every 30 s (8 requests a minute per open wallet)', () => {
    expect(timerSettings({})).toEqual({ versionWatchMs: 600_000, livenessMs: 120_000, keepAliveMs: 50_000 });
  });
  it('can be set, and ignores what makes no sense', () => {
    expect(timerSettings({ NIGHTCAST_VERSION_WATCH_SECS: '0', NIGHTCAST_LIVENESS_SECS: '30' })).toEqual({ versionWatchMs: 0, livenessMs: 30_000, keepAliveMs: 50_000 });
    expect(timerSettings({ NIGHTCAST_VERSION_WATCH_SECS: 'never', NIGHTCAST_LIVENESS_SECS: '1' })).toEqual({ versionWatchMs: 600_000, livenessMs: 120_000, keepAliveMs: 50_000 });
    expect(timerSettings({ NIGHTCAST_VERSION_WATCH_SECS: '', NIGHTCAST_LIVENESS_SECS: '-5' })).toEqual({ versionWatchMs: 600_000, livenessMs: 120_000, keepAliveMs: 50_000 });
  });
  it('pings each open indexer connection every 50 s, not every 15 (Blockfrost counts each ping as a request)', () => {
    expect(timerSettings({}).keepAliveMs).toBe(50_000);
    expect(timerSettings({ NIGHTCAST_WS_KEEPALIVE_SECS: '300' }).keepAliveMs).toBe(300_000);
    expect(timerSettings({ NIGHTCAST_WS_KEEPALIVE_SECS: '0' }).keepAliveMs).toBe(0);
    expect(timerSettings({ NIGHTCAST_WS_KEEPALIVE_SECS: ' 0 ' }).keepAliveMs).toBe(0);
    expect(timerSettings({ NIGHTCAST_WS_KEEPALIVE_SECS: '2' }).keepAliveMs).toBe(50_000);
    expect(timerSettings({ NIGHTCAST_WS_KEEPALIVE_SECS: 'off' }).keepAliveMs).toBe(50_000);
  });
});

describe('an error with its causes', () => {
  it('adds the reasons under a Midnight.js step failure', () => {
    const err = Object.assign(new Error("balanceTx rejected the transaction (circuit 'request'). The provider's own failure is on `cause`."), {
      cause: Object.assign(new Error('Wallet.InsufficientFunds'), { cause: new Error('Insufficient Funds: could not balance dust') }),
    });
    expect(failureText(err)).toBe("balanceTx rejected the transaction (circuit 'request'). The provider's own failure is on `cause`. (cause: Wallet.InsufficientFunds: Insufficient Funds: could not balance dust)");
  });
  it('leaves a plain error as it is', () => {
    expect(failureText(new Error('usage: ./nightcast'))).toBe('usage: ./nightcast');
    expect(failureText('text')).toBe('text');
  });
});
