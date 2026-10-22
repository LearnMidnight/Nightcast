import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger, TicketPreimage } from './managed/lotto/contract/index.js';

/**
 * Private state of whoever runs a Midnight Lotto circuit.
 *
 * - The oracle sets `oracleSecretKey` (for `acceptOracleKey` and `fulfilDraw`).
 * - The organiser sets `organiserSecret` (for `openDraw`).
 * - A player buying a ticket sets `pendingTicket`; to claim or be refunded they
 *   keep every ticket they bought in `tickets` (hex commitment -> preimage).
 *   Losing a preimage means losing the ability to claim or be refunded.
 * - Anyone else (requesting a draw with the published seed, computing numbers,
 *   settling, paying, voiding) needs nothing.
 *
 * The arithmetic witnesses (`splitByte`, `divMod16`, `sortSeven`, `divModWide`)
 * only offer answers the circuits check; a wrong answer makes the proof fail.
 */
export type LottoPrivateState = {
  readonly oracleSecretKey?: bigint;
  readonly organiserSecret?: Uint8Array;
  readonly pendingTicket?: TicketPreimage;
  readonly tickets?: Readonly<Record<string, TicketPreimage>>;
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

type Ctx = WitnessContext<Ledger, LottoPrivateState>;

export const witnesses = {
  oracleSecretKey({ privateState }: Ctx): [LottoPrivateState, bigint] {
    if (privateState.oracleSecretKey === undefined) throw new Error('Midnight Lotto: no oracle secret key in private state');
    return [privateState, privateState.oracleSecretKey];
  },

  organiserSecret({ privateState }: Ctx): [LottoPrivateState, Uint8Array] {
    if (privateState.organiserSecret === undefined) throw new Error('Midnight Lotto: no organiser secret in private state');
    return [privateState, privateState.organiserSecret];
  },

  newTicket({ privateState }: Ctx): [LottoPrivateState, TicketPreimage] {
    if (privateState.pendingTicket === undefined) throw new Error('Midnight Lotto: no ticket to buy in private state');
    return [privateState, privateState.pendingTicket];
  },

  ticketFor({ privateState }: Ctx, commitment: Uint8Array): [LottoPrivateState, TicketPreimage] {
    const t = privateState.tickets?.[hex(commitment)];
    if (t === undefined) throw new Error(`Midnight Lotto: no ticket ${hex(commitment)} in private state`);
    return [privateState, t];
  },

  splitByte({ privateState }: Ctx, x: bigint): [LottoPrivateState, [bigint, bigint]] {
    return [privateState, [x >> 4n, x & 15n]];
  },

  divMod16({ privateState }: Ctx, v: bigint, m: bigint): [LottoPrivateState, [bigint, bigint]] {
    return [privateState, [v / m, v % m]];
  },

  sortSeven({ privateState }: Ctx, v: bigint[]): [LottoPrivateState, bigint[]] {
    return [privateState, [...v].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
  },

  divModWide({ privateState }: Ctx, n: bigint, d: bigint): [LottoPrivateState, [bigint, bigint]] {
    return [privateState, [n / d, n % d]];
  },
};
