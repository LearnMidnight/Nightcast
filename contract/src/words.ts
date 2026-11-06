/**
 * Off-chain twins of NightcastWords.compact, the module a contract imports to
 * expand one Nightcast output into many words in-circuit. These call the same
 * compiled code, so they give exactly what the circuit gives (for this
 * package's compact-runtime version).
 *
 * `randomWord` (SHA-256) is the Nightcast contract's own. The Poseidon ones
 * are for a contract's internal use only: read the rules at the top of
 * NightcastWords.compact (or docs/GUIDE.md) before using them.
 */
import { maxField } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits } from './managed/words/contract/index.js';

export const words = pureCircuits;

/** The size of the field a Poseidon word lives in (BLS12-381's scalar field): every field word is below it. */
export const FIELD_SIZE: bigint = maxField() + 1n;
