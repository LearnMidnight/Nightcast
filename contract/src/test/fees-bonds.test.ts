/**
 * Request fees (#13) and oracle bonds (#9), on the simulator: who pays, who
 * is paid, what an expired request is worth, and that the bond can't leave
 * from under requests already made. Every run is also put through the zkir
 * check a proof server does, so the payments in branches prove too.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { proofDataIntoSerializedPreimage } from '@midnight-ntwrk/compact-runtime';
import * as zkir from '@midnight-ntwrk/zkir-v2';
import { generateOperatorSecret, generateOracleSecretKey, oraclePublicKey } from '../keys.js';
import { NightcastSimulator } from '../simulator.js';
import { Status } from '../managed/nightcast/contract/index.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (s: string) => {
  const b = new Uint8Array(32);
  b.set(new TextEncoder().encode(s));
  return b;
};
const addr = (n: number) => new Uint8Array(32).fill(n);

const FEE = 2_000_000n; // 2 NIGHT
const COLLATERAL = 10_000_000n; // 10 NIGHT
const MAX = 3_600n;

type Run = { circuit: string; proofData: { input: unknown; output: unknown; publicTranscript: unknown; privateTranscriptOutputs: unknown } };

const setup = (o: { fee?: bigint; collateral?: bigint } = {}) => {
  const runs: Run[] = [];
  const sk = generateOracleSecretKey();
  const sim = new NightcastSimulator({
    oracleSecretKey: sk,
    operatorSecret: generateOperatorSecret(),
    minWindow: 60n,
    maxWindow: MAX,
    requestFee: o.fee ?? FEE,
    collateralPerRequest: o.collateral ?? COLLATERAL,
    onProof: (circuit, proofData) => runs.push({ circuit, proofData: proofData as Run['proofData'] }),
  });
  let n = 0;
  const ask = (refundTo?: Uint8Array) => sim.request(bytes('t'), bytes(`s${++n}`), BigInt(sim.now) + 600n, undefined, refundTo);
  /** The contract's NIGHT equals the free bond plus what pending requests hold. */
  const accountsBalance = () => {
    const l = sim.getLedger();
    let held = 0n;
    for (const [, r] of l.requests) if (r.status === Status.pending) held += r.fee + r.collateral;
    expect(sim.balance()).toBe(l.bond + held);
  };
  return { sim, sk, runs, ask, accountsBalance };
};

const ZKIR = fileURLToPath(new URL('../managed/nightcast/zkir/', import.meta.url));
const irs = new Map<string, Uint8Array>();
const provider = {
  async lookupKey(circuit: string) {
    if (!irs.has(circuit)) irs.set(circuit, zkir.jsonIrToBinary(readFileSync(`${ZKIR}${circuit}.zkir`, 'utf8')));
    return { ir: irs.get(circuit)!, proverKey: new Uint8Array(), verifierKey: new Uint8Array() };
  },
  async getParams(): Promise<Uint8Array> {
    throw new Error('checking needs no parameters');
  },
};
const failingChecks = async (runs: Run[]) => {
  const failed: string[] = [];
  for (const { circuit, proofData: p } of runs) {
    try {
      await zkir.check(
        proofDataIntoSerializedPreimage(p.input as never, p.output as never, p.publicTranscript as never, p.privateTranscriptOutputs as never, circuit),
        provider,
      );
    } catch (err) {
      failed.push(`${circuit}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failed;
};

describe('request fees (#13)', () => {
  it('a request pays the fee; answering it pays the oracle', async () => {
    const { sim, runs, ask, accountsBalance } = setup({ collateral: 0n });
    const id = ask();
    expect(sim.transfers.at(-1)).toEqual({ circuit: 'request', to: 'contract', amount: FEE });
    expect(sim.getLedger().requests.lookup(id).fee).toBe(FEE);
    accountsBalance();
    sim.fulfil(id);
    expect(sim.paidTo(sim.oraclePayout)).toBe(FEE);
    expect(sim.balance()).toBe(0n);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it('an expired request gives the fee back to its refund address', async () => {
    const { sim, runs, ask, accountsBalance } = setup({ collateral: 0n });
    const id = ask(addr(0x21));
    sim.advance(601);
    sim.expire(id);
    expect(sim.paidTo(addr(0x21))).toBe(FEE);
    expect(sim.paidTo(sim.oraclePayout)).toBe(0n);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it('with no fee and no collateral, nothing moves (as v0)', async () => {
    const { sim, runs, ask } = setup({ fee: 0n, collateral: 0n });
    const a = ask();
    const b = ask();
    sim.fulfil(a);
    sim.advance(601);
    sim.expire(b);
    expect(sim.transfers).toEqual([]);
    expect(await failingChecks(runs)).toEqual([]);
  });
});

describe('oracle bonds (#9)', () => {
  it('a request needs enough bond, sets collateral aside, and gets it back when answered', async () => {
    const { sim, runs, ask, accountsBalance } = setup();
    expect(() => ask()).toThrow(/bond is too small/);
    sim.depositBond(25_000_000n);
    accountsBalance();
    const a = ask();
    const b = ask();
    expect(sim.getLedger().bond).toBe(5_000_000n);
    expect(() => ask()).toThrow(/bond is too small/);
    accountsBalance();
    sim.fulfil(a);
    expect(sim.getLedger().bond).toBe(15_000_000n);
    expect(sim.paidTo(sim.oraclePayout)).toBe(FEE);
    accountsBalance();
    sim.fulfil(b);
    expect(sim.getLedger().bond).toBe(25_000_000n);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it('a skipped request pays its refund address the fee and the collateral', async () => {
    const { sim, runs, ask, accountsBalance } = setup();
    sim.depositBond(COLLATERAL);
    const id = ask(addr(0x33));
    sim.advance(601);
    expect(() => sim.fulfil(id)).toThrow(/expired/);
    sim.expire(id);
    expect(sim.paidTo(addr(0x33))).toBe(FEE + COLLATERAL);
    expect(sim.getLedger().bond).toBe(0n);
    expect(sim.balance()).toBe(0n);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it('a withdrawal waits the longest request window, and never takes collateral set aside', async () => {
    const { sim, runs, ask, accountsBalance } = setup();
    sim.depositBond(30_000_000n);
    expect(() => sim.withdrawBond()).toThrow(/no withdrawal/);
    expect(() => sim.requestBondWithdrawal(30_000_000n, { oracleSecretKey: generateOracleSecretKey() })).toThrow(/not the current oracle/);
    expect(() => sim.requestBondWithdrawal(30_000_000n, undefined, BigInt(sim.now) - 700n)).toThrow(/10 minutes off/);
    sim.requestBondWithdrawal(30_000_000n);
    // During the wait the whole bond still backs new requests.
    const a = ask();
    const b = ask();
    sim.fulfil(a);
    sim.advance(Number(MAX) - 10);
    expect(() => sim.withdrawBond()).toThrow(/still waiting/);
    sim.advance(10);
    // b is still pending (nobody has expired it): its collateral stays.
    sim.withdrawBond();
    expect(sim.paidTo(sim.oraclePayout)).toBe(FEE + 20_000_000n);
    expect(sim.getLedger().bond).toBe(0n);
    expect(sim.getLedger().bondWithdrawal.is_some).toBe(false);
    accountsBalance();
    // ... and still pays out, b having been skipped.
    sim.expire(b);
    expect(sim.paidTo(sim.refundTo)).toBe(FEE + COLLATERAL);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it('announcing again restarts the wait', () => {
    const { sim } = setup();
    sim.depositBond(COLLATERAL);
    sim.requestBondWithdrawal(1n);
    sim.advance(Number(MAX) - 100);
    sim.requestBondWithdrawal(COLLATERAL);
    sim.advance(200);
    expect(() => sim.withdrawBond()).toThrow(/still waiting/);
    sim.advance(Number(MAX));
    sim.withdrawBond();
    expect(sim.paidTo(sim.oraclePayout)).toBe(COLLATERAL);
  });

  it("a replacement oracle doesn't take over the old bond: it goes back, and old requests settle with the old oracle", async () => {
    const { sim, runs, ask, accountsBalance } = setup();
    sim.depositBond(25_000_000n);
    const old1 = ask();
    const old2 = ask(addr(0x44));
    const newSk = generateOracleSecretKey();
    sim.proposeOracleKey(oraclePublicKey(newSk));
    sim.approveOracleKey();
    sim.acceptOracleKey({ oracleSecretKey: newSk }, addr(0x55));
    // The free bond went back to the old oracle's payout; the new oracle starts with none.
    expect(sim.paidTo(sim.oraclePayout)).toBe(5_000_000n);
    expect(sim.getLedger().bond).toBe(0n);
    expect(hex(sim.getLedger().oraclePayout.bytes)).toBe(hex(addr(0x55)));
    expect(() => ask()).toThrow(/bond is too small/);
    accountsBalance();
    // The old oracle answers one of its own: fee and collateral both go to its payout.
    sim.fulfil(old1);
    expect(sim.paidTo(sim.oraclePayout)).toBe(5_000_000n + FEE + COLLATERAL);
    expect(sim.getLedger().bond).toBe(0n);
    // The other expires: its refund address gets fee and collateral.
    sim.advance(601);
    sim.expire(old2);
    expect(sim.paidTo(addr(0x44))).toBe(FEE + COLLATERAL);
    expect(sim.balance()).toBe(0n);
    // The new oracle's requests pay the new payout.
    sim.depositBond(COLLATERAL);
    const fresh = ask();
    sim.fulfil(fresh, { oracleSecretKey: newSk });
    expect(sim.paidTo(addr(0x55))).toBe(FEE);
    expect(sim.getLedger().bond).toBe(COLLATERAL);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it('a deposit needs an active key and a positive amount', () => {
    const sk = generateOracleSecretKey();
    const sim = new NightcastSimulator({ oracleSecretKey: sk, operatorSecret: generateOperatorSecret(), acceptKey: false, collateralPerRequest: 1n });
    expect(() => sim.depositBond(5n)).toThrow(/no current oracle key/);
    sim.acceptOracleKey();
    expect(() => sim.depositBond(0n)).toThrow(/nothing to deposit/);
    sim.depositBond(5n);
    expect(sim.getLedger().bond).toBe(5n);
  });
});
