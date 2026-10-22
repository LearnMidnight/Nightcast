/**
 * Make the wallet SDK's sync errors readable.
 *
 * When the wallet loses its connection to the indexer or can't read an event,
 * the SDK prints the error and retries by itself. It prints errors whose
 * `message` is an object, so all you see is `Wallet.Sync: [object Object]`
 * and a stack trace into the library. This replaces those prints with one
 * line that says what failed and that the wallet is retrying, and repeats an
 * identical error only as a count. Import it once, early.
 */
import { inspect } from 'node:util';

type Tagged = { _tag: string; message?: unknown; cause?: unknown };

/** True for the wallet SDK's tagged errors (`Wallet.Sync`, `Wallet.Other`, ...). */
export const isWalletError = (x: unknown): x is Tagged =>
  typeof x === 'object' && x !== null && typeof (x as Tagged)._tag === 'string' && (x as Tagged)._tag.startsWith('Wallet.');

const show = (x: unknown): string =>
  typeof x === 'string' ? x : inspect(x, { depth: 5, breakLength: Infinity, showHidden: false, maxStringLength: 500 });

/**
 * The reason behind a wallet error, following `message` and `cause` down to
 * whatever actually failed (a WebSocket event, a GraphQL error, a parse
 * error). Kept to one line of at most `max` characters.
 */
export const describeWalletError = (err: Tagged, max = 1500): string => {
  const reasons: string[] = [];
  const seen = new Set<unknown>();
  const visit = (x: unknown, depth: number): void => {
    if (x === undefined || x === null || depth > 6 || seen.has(x)) return;
    if (typeof x !== 'object') {
      reasons.push(String(x));
      return;
    }
    seen.add(x);
    const o = x as { message?: unknown; cause?: unknown; error?: unknown; errors?: unknown; code?: unknown; reason?: unknown };
    const hasText = typeof o.message === 'string' && o.message !== '' && o.message !== '[object Object]';
    if (hasText) reasons.push(o.message as string);
    // A WebSocket CloseEvent carries a code and a reason.
    if (o.code !== undefined && o.reason !== undefined) {
      reasons.push(`connection closed (code ${String(o.code)}${o.reason ? `, ${String(o.reason)}` : ''})`);
    }
    // Follow whatever holds the underlying error: an object message, the
    // cause, an ErrorEvent's error, or a GraphQL error list.
    const children = [
      typeof o.message === 'object' ? o.message : undefined,
      o.cause,
      o.error,
      ...(Array.isArray(o.errors) ? o.errors : []),
    ].filter((c) => c !== undefined && c !== null);
    const before = reasons.length;
    for (const c of children) visit(c, depth + 1);
    // Nothing readable inside: show the object itself (skipping the SDK's own wrapper).
    if (!hasText && reasons.length === before && !isWalletError(x)) reasons.push(show(x));
  };
  visit(err, 0);
  const text = [...new Set(reasons)].join(': ').replace(/\s+/g, ' ').trim() || 'no details';
  return text.length > max ? `${text.slice(0, max)}...` : text;
};

/**
 * Wrap a console.error-like function: wallet errors become one readable line,
 * and an identical one within 30 minutes is printed again only every tenth
 * time, with a count. Everything else passes through unchanged.
 */
export const wrapConsoleError = (original: (...args: unknown[]) => void): ((...args: unknown[]) => void) => {
  let last = '';
  let repeats = 0;
  let lastAt = 0;
  return (...args: unknown[]) => {
    const err = args.find(isWalletError);
    if (!err) {
      original(...args);
      return;
    }
    const line = `${err._tag === 'Wallet.Sync' ? 'Wallet sync problem' : `Wallet problem (${err._tag})`}: ${describeWalletError(err)}`;
    const now = Date.now();
    if (line === last && now - lastAt < 30 * 60_000) {
      repeats += 1;
      if ((repeats + 1) % 10 === 0) original(`${line} (seen ${repeats + 1} times; the wallet keeps retrying)`);
      return;
    }
    last = line;
    lastAt = now;
    repeats = 0;
    original(`${line}. The wallet retries by itself.`);
  };
};

let installed = false;

/** Replace the SDK's wallet error prints with readable ones (idempotent). */
export const explainWalletErrors = (): void => {
  if (installed) return;
  installed = true;
  console.error = wrapConsoleError(console.error.bind(console));
};

explainWalletErrors();
