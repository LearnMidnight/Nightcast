import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from './managed/nightcast/contract/index.js';

/**
 * Private state held by whoever runs a Nightcast circuit locally.
 *
 * - The oracle sets `oracleSecretKey` (needed for `fulfil`).
 * - The operator sets `operatorSecret` (needed for `setOracleKey` / `setOperator`).
 * - Requesters and anyone calling `expire` need neither.
 *
 * None of this ever leaves the caller's machine: the circuits only prove facts
 * about it.
 */
export type NightcastPrivateState = {
  readonly oracleSecretKey?: bigint;
  readonly operatorSecret?: Uint8Array;
};

export const emptyPrivateState = (): NightcastPrivateState => ({});

export const witnesses = {
  oracleSecretKey({ privateState }: WitnessContext<Ledger, NightcastPrivateState>): [NightcastPrivateState, bigint] {
    if (privateState.oracleSecretKey === undefined) {
      throw new Error('Nightcast: no oracle secret key in private state');
    }
    return [privateState, privateState.oracleSecretKey];
  },

  operatorSecret({ privateState }: WitnessContext<Ledger, NightcastPrivateState>): [NightcastPrivateState, Uint8Array] {
    if (privateState.operatorSecret === undefined) {
      throw new Error('Nightcast: no operator secret in private state');
    }
    return [privateState, privateState.operatorSecret];
  },
};
