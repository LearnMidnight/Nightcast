/**
 * When the node refuses a transaction, ask the wallet SDK's own checker why.
 *
 * A refusal arrives as a bare number (`1010: Invalid Transaction: Custom
 * error: 138`). The wallet SDK (2.x) can run the ledger's well-formedness
 * check itself, against the chain's latest parameters, and that check says
 * what the number can't: which token is short, in which segment, by how much.
 * So after a refusal the same transaction is checked once and the answer
 * logged. If the wallet's check passes, that is worth knowing too: the node
 * then sees something the indexer's latest block doesn't (other prices, a
 * later state).
 *
 * Added 10 Nov 2026 for LunaSpin's requests, refused with 138
 * (BalanceCheckOverspend) on every try after the first.
 */
import { errorMessages } from './wallet.js';

type Logger = { warn(msg: string): void };

const ALL_CHECKS = { enforceBalancing: true, verifySignatures: true, enforceLimits: true };

/** The block a fee was priced at (what the dust wallet returns with a balancing transaction). */
type PricedBlock = {
  height?: number;
  timestamp?: Date;
  ledgerParameters?: { feePrices?: { overallPrice?: number } };
};

/** The parts of a ledger transaction the balance report reads. */
type LedgerTx = {
  intents?: Map<number, { dustActions?: { spends?: unknown[] } }>;
  imbalances(segment: number): Map<{ tag: string; raw?: string }, bigint>;
  fees?(params: unknown): bigint;
  feesWithMargin?(params: unknown, margin: number): bigint;
};

export interface RefusalWallet {
  wallet: {
    submitTransaction(tx: unknown): Promise<unknown>;
    validateTransaction?(tx: unknown, options: { flags: typeof ALL_CHECKS }): Promise<unknown>;
    /** Unwraps the wallet SDK's handle to the ledger's own transaction. */
    accept?(tx: unknown): unknown;
    calculateTransactionFee?(tx: unknown): Promise<bigint>;
    dust?: { balanceTransactions?(...args: unknown[]): Promise<unknown> };
  };
}

/** The node looked at the transaction and said no (as opposed to a lost connection). */
export const isRefusal = (err: unknown): boolean => /Invalid Transaction|custom error/i.test(errorMessages(err).join(' '));

const tokenName = (t: { tag: string; raw?: string }): string =>
  t.tag === 'dust' ? 'DUST' : t.tag === 'unshielded' ? (/^0+$/.test(t.raw ?? '') ? 'NIGHT' : `unshielded ${String(t.raw).slice(0, 8)}`) : `${t.tag} ${String(t.raw ?? '').slice(0, 8)}`;

/**
 * What a transaction pays and what it costs, in one line: every token's balance
 * in every segment (before the fee; DUST in segment 0 is what it pays), how
 * many DUST spends pay it, and the fee at the block the wallet priced it at.
 * Amounts only: the same figures the chain would show.
 */
export const balanceReport = (tx: LedgerTx, priced: PricedBlock | undefined, nowMs: number): string => {
  const segments = [0, ...Array.from(tx.intents?.keys() ?? []).filter((s) => s !== 0)];
  const balances: string[] = [];
  for (const segment of segments) {
    for (const [token, value] of tx.imbalances(segment)) balances.push(`${tokenName(token)} ${value} in segment ${segment}`);
  }
  const spends = Array.from(tx.intents?.values() ?? []).reduce((n, intent) => n + (intent.dustActions?.spends?.length ?? 0), 0);
  const parts = [`balances before the fee: ${balances.join(', ') || 'none'}`, `${spends} DUST spend(s)`];
  const params = priced?.ledgerParameters;
  if (params && tx.fees && tx.feesWithMargin) {
    const age = priced.timestamp ? `, ${Math.round((nowMs - priced.timestamp.getTime()) / 1000)} s old` : '';
    parts.push(
      `fee at the block it was priced at (height ${priced.height ?? '?'}${age}, overall price ${params.feePrices?.overallPrice ?? '?'}): ` +
        `${tx.fees(params)}, or ${tx.feesWithMargin(params, 5)} with a 5-block margin`,
    );
  }
  return parts.join('; ');
};

/** One line saying what the wallet's own check makes of a refused transaction. */
export const whyRefused = async (facade: RefusalWallet['wallet'], tx: unknown): Promise<string> => {
  if (!facade.validateTransaction) return "the node refused the transaction (this wallet SDK can't check it itself)";
  try {
    await facade.validateTransaction(tx, { flags: ALL_CHECKS });
    return "the node refused the transaction, but the wallet's own check of it passes against the chain's latest block (the node sees other prices or a later state)";
  } catch (why) {
    return `the node refused the transaction; the wallet's own check of it says: ${errorMessages(why).join(': ').slice(0, 800)}`;
  }
};

/** Patch the wallet so a refused submission is explained in the log. Returns an undo. */
export const explainRefusals = (wallet: RefusalWallet, logger: Logger, now: () => number = Date.now): (() => void) => {
  const facade = wallet.wallet;
  const original = facade.submitTransaction;
  const bound = original.bind(facade);
  // Remember the block the last fee was priced at (the dust wallet returns it with the fee's transaction).
  let priced: PricedBlock | undefined;
  const dust = facade.dust;
  const balance = dust?.balanceTransactions;
  if (dust && balance) {
    const boundBalance = balance.bind(dust);
    dust.balanceTransactions = async (...args: unknown[]) => {
      const result = await boundBalance(...args);
      priced = (result as { blockData?: PricedBlock } | undefined)?.blockData ?? priced;
      return result;
    };
  }
  const numbers = async (tx: unknown): Promise<string> => {
    const parts: string[] = [];
    try {
      parts.push(balanceReport((facade.accept ? facade.accept(tx) : tx) as LedgerTx, priced, now()));
    } catch (e) {
      parts.push(`(no balance report: ${errorMessages(e)[0]})`);
    }
    try {
      if (facade.calculateTransactionFee) parts.push(`fee at the chain's latest block now, with the wallet's margin: ${await facade.calculateTransactionFee(tx)}`);
    } catch (e) {
      parts.push(`(no fee at the latest block: ${errorMessages(e)[0]})`);
    }
    return parts.join('; ');
  };
  facade.submitTransaction = async (tx) => {
    try {
      return await bound(tx);
    } catch (err) {
      if (isRefusal(err)) {
        logger.warn(await whyRefused(facade, tx).catch(() => 'the node refused the transaction'));
        logger.warn(`the refused transaction: ${await numbers(tx).catch(() => 'no figures')}`);
      }
      throw err;
    }
  };
  return () => {
    facade.submitTransaction = original;
    if (dust && balance) dust.balanceTransactions = balance;
  };
};
