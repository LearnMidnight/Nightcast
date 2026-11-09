/**
 * Reading this contract's ledger from a contract state of any Midnight ledger
 * era.
 *
 * The contract was compiled for ledger 8 (compact-runtime 0.16), and its
 * generated `ledger()` reads that runtime's state values. After the ledger 9
 * hard fork the chain hands out ledger 9 states, which Midnight.js 5 decodes
 * with the current runtime. The one form both runtimes share is the *encoded*
 * state value (`EncodedStateValue` is pinned identical across onchain-runtime
 * v3, ledger-v8 and ledger-v9), so a state of either era is read by encoding
 * its data and decoding it here, in this contract's own runtime.
 */
import { type EncodedStateValue, StateValue } from '@midnight-ntwrk/compact-runtime';
import { ledger, type Ledger } from './managed/nightcast/contract/index.js';

/** A contract state as any ledger or runtime hands it out: its data's state value can encode itself. */
export type EncodableContractState = { readonly data: { readonly state: { encode(): EncodedStateValue } } };

/** The ledger from an encoded state value (era-neutral). */
export const ledgerFromEncoded = (encoded: EncodedStateValue): Ledger => ledger(StateValue.decode(encoded));

/** The ledger from a contract state of any era (a ledger-v8, ledger-v9 or onchain-runtime `ContractState`). */
export const ledgerOf = (state: EncodableContractState): Ledger => ledgerFromEncoded(state.data.state.encode());
