import { webcrypto } from 'node:crypto';
import { pureCircuits } from './managed/nightcast/contract/index.js';

/** Order of the prime-order Jubjub subgroup used by Midnight's embedded curve. */
export const JUBJUB_ORDER = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;

const bytesToBigIntLE = (bytes: Uint8Array): bigint => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
};

/**
 * A fresh oracle secret key: uniform in [1, JUBJUB_ORDER).
 * 64 random bytes reduced modulo the order, so the bias is below 2^-250.
 */
export const generateOracleSecretKey = (): bigint => {
  for (;;) {
    const sk = bytesToBigIntLE(webcrypto.getRandomValues(new Uint8Array(64))) % JUBJUB_ORDER;
    if (sk !== 0n) return sk;
  }
};

/** A fresh 32-byte operator secret. */
export const generateOperatorSecret = (): Uint8Array => webcrypto.getRandomValues(new Uint8Array(32));

/** The oracle public key for a secret key, as stored in the contract. */
export const oraclePublicKey = (sk: bigint): { x: bigint; y: bigint } => {
  if (sk <= 0n || sk >= JUBJUB_ORDER) throw new RangeError('oracle secret key must be in [1, JUBJUB_ORDER)');
  return pureCircuits.publicKey(sk);
};

/** Parse a secret key written as hex (with or without 0x). */
export const parseOracleSecretKey = (hex: string): bigint => {
  const clean = hex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,64}$/i.test(clean)) throw new Error('oracle secret key must be up to 64 hex digits');
  const sk = BigInt('0x' + clean);
  if (sk <= 0n || sk >= JUBJUB_ORDER) throw new RangeError('oracle secret key must be in [1, JUBJUB_ORDER)');
  return sk;
};

export const formatOracleSecretKey = (sk: bigint): string => sk.toString(16).padStart(64, '0');

export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export const fromHex = (hex: string, length = 32): Uint8Array => {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length !== length * 2 || !/^[0-9a-f]*$/i.test(clean)) {
    throw new Error(`expected ${length} bytes of hex`);
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
};
