import { webcrypto } from 'node:crypto';
import type { Line, TicketPreimage } from './managed/lotto/contract/index.js';

export const MAX_LINES = 5;
export const MAIN_PICK = 7;
export const MAIN_POOL = 35;
export const MOONBALL_POOL = 20;

/** A Midnight 7 line as plain numbers. */
export type PlainLine = { numbers: number[]; moonball: number };

/** Division shares in basis points (division 1 first), as in the contract. */
export const SHARES_BP = [3000, 700, 560, 560, 630, 700, 700, 1400, 1750] as const;

const EMPTY_LINE: Line = { numbers: [0n, 0n, 0n, 0n, 0n, 0n, 0n], moonball: 0n };

/** Check a line the way the contract does; throws with a reason. */
export const checkLine = (l: PlainLine): void => {
  const n = l.numbers;
  if (n.length !== MAIN_PICK) throw new Error(`a line has ${MAIN_PICK} numbers`);
  for (let i = 0; i < n.length; i++) {
    if (!Number.isInteger(n[i]) || n[i] < 1 || n[i] > MAIN_POOL) throw new Error(`numbers are 1..${MAIN_POOL}`);
    if (i > 0 && n[i] <= n[i - 1]) throw new Error('numbers must be distinct');
  }
  if (!Number.isInteger(l.moonball) || l.moonball < 1 || l.moonball > MOONBALL_POOL) {
    throw new Error(`the Moonball is 1..${MOONBALL_POOL}`);
  }
};

const sortLine = (l: PlainLine): PlainLine => ({ numbers: [...l.numbers].sort((a, b) => a - b), moonball: l.moonball });

/**
 * Build a ticket for draw `drawId` from 1 to 5 lines (numbers in any order).
 * `salt` defaults to 32 random bytes; keep the result: it's the only way to
 * claim or get a refund.
 */
export const makeTicket = (drawId: number | bigint, lines: PlainLine[], salt?: Uint8Array): TicketPreimage => {
  if (lines.length < 1 || lines.length > MAX_LINES) throw new Error(`a ticket has 1 to ${MAX_LINES} lines`);
  const sorted = lines.map(sortLine);
  sorted.forEach(checkLine);
  const out: Line[] = sorted.map((l) => ({ numbers: l.numbers.map(BigInt), moonball: BigInt(l.moonball) }));
  while (out.length < MAX_LINES) out.push(EMPTY_LINE);
  return {
    drawId: BigInt(drawId),
    count: BigInt(lines.length),
    lines: out,
    salt: salt ?? webcrypto.getRandomValues(new Uint8Array(32)),
  };
};

/** A random line (a "quick pick"). */
export const quickPick = (): PlainLine => {
  const nums = new Set<number>();
  const r = new Uint32Array(1);
  while (nums.size < MAIN_PICK) {
    webcrypto.getRandomValues(r);
    nums.add((r[0] % MAIN_POOL) + 1);
  }
  webcrypto.getRandomValues(r);
  return { numbers: [...nums].sort((a, b) => a - b), moonball: (r[0] % MOONBALL_POOL) + 1 };
};

/** Division (1..9) of a line against drawn numbers, or 0 for no prize; same rule as the contract. */
export const divisionFor = (line: PlainLine, numbers: number[], moonball: number): number => {
  const m = line.numbers.filter((x) => numbers.includes(x)).length;
  const mb = line.moonball === moonball;
  if (m === 7) return mb ? 1 : 2;
  if (m === 6) return mb ? 3 : 4;
  if (m === 5) return mb ? 5 : 7;
  if (m === 4) return mb ? 6 : 0;
  if (m === 3) return mb ? 8 : 0;
  if (m === 2) return mb ? 9 : 0;
  return 0;
};

/**
 * Each division's prize per winning line for a pool and winner counts; same
 * arithmetic as `settleDraw` (floors, then floors again).
 */
export const prizesFor = (pool: bigint, winners: readonly bigint[]): bigint[] =>
  SHARES_BP.map((bp, i) => (winners[i] === 0n ? 0n : (pool * BigInt(bp)) / 10_000n / winners[i]));
