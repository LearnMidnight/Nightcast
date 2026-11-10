import { describe, expect, it } from 'vitest';
import { explainRefusals, isRefusal } from '../explain-refusal.js';

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
    expect(logs).toEqual(["the node refused the transaction; the wallet's own check of it says: WellFormedError: balance check failed: segment 0 overspends Dust by 12"]);
  });

  it("says so when the wallet's own check passes", async () => {
    const logs: string[] = [];
    const { wallet } = walletWith(() => Promise.reject(refusal()), () => Promise.resolve());
    explainRefusals(wallet, { warn: (m) => logs.push(m) });
    await expect(wallet.wallet.submitTransaction('tx')).rejects.toThrow();
    expect(logs).toHaveLength(1);
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
