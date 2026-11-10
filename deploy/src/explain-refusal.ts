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

export interface RefusalWallet {
  wallet: {
    submitTransaction(tx: unknown): Promise<unknown>;
    validateTransaction?(tx: unknown, options: { flags: typeof ALL_CHECKS }): Promise<unknown>;
  };
}

/** The node looked at the transaction and said no (as opposed to a lost connection). */
export const isRefusal = (err: unknown): boolean => /Invalid Transaction|custom error/i.test(errorMessages(err).join(' '));

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
export const explainRefusals = (wallet: RefusalWallet, logger: Logger): (() => void) => {
  const facade = wallet.wallet;
  const original = facade.submitTransaction;
  const bound = original.bind(facade);
  facade.submitTransaction = async (tx) => {
    try {
      return await bound(tx);
    } catch (err) {
      if (isRefusal(err)) logger.warn(await whyRefused(facade, tx).catch(() => 'the node refused the transaction'));
      throw err;
    }
  };
  return () => {
    facade.submitTransaction = original;
  };
};
