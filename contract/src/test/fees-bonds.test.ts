/**
 * Request fees (#13) and oracle bonds (#9), on the simulator: who pays, who
 * is paid, what an expired request is worth, that collateral a request holds
 * can't be taken, and that requests and answers made at the same time don't
 * invalidate each other. Every run is also put through the zkir check a proof
 * server does, so the payments in branches prove too.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type ChargedState, CostModel, proofDataIntoSerializedPreimage, QueryContext } from '@midnight-ntwrk/compact-runtime';
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
const COLLATERAL = 10_000_000n; // 10 NIGHT a slot
const MAX = 3_600n;

type ProofData = { input: unknown; output: unknown; publicTranscript: unknown; privateTranscriptOutputs: unknown };
type Run = { circuit: string; proofData: ProofData };

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
    onProof: (circuit, proofData) => runs.push({ circuit, proofData: proofData as ProofData }),
  });
  let n = 0;
  const ask = (refundTo?: Uint8Array, as = sim.requester) => sim.request(bytes('t'), bytes(`s${++n}`), BigInt(sim.now) + 600n, as, refundTo);
  const collateral = o.collateral ?? COLLATERAL;
  const freeBond = () => sim.getLedger().bondSlots * collateral;
  /** The contract's NIGHT equals the free bond plus what pending requests hold. */
  const accountsBalance = () => {
    const l = sim.getLedger();
    let held = 0n;
    for (const [, r] of l.requests) if (r.status === Status.pending) held += r.fee + r.collateral;
    expect(sim.balance()).toBe(freeBond() + held);
  };
  return { sim, sk, runs, ask, accountsBalance, freeBond };
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

/**
 * Two transactions built against the same state, as when two parties act in
 * the same block: run `first`, then replay `second`'s public transcript (built
 * against the state before `first`) on top of it, which is what the chain does
 * when it applies a transaction proven earlier.
 */
const sameBlock = (sim: NightcastSimulator, first: () => void, second: () => void) => {
  const internal = sim as unknown as { state: unknown; run: (ps: unknown, call: (ctx: unknown) => never) => unknown };
  const before = internal.state;
  first();
  const after = sim.publicState();
  internal.state = before;
  let proof: ProofData | undefined;
  let effects: unknown;
  const run = internal.run.bind(sim);
  internal.run = (ps, call) =>
    run(ps, ((ctx: unknown) => {
      const out = call(ctx) as { proofData: ProofData; context: { currentQueryContext: { effects: unknown } } };
      proof = out.proofData;
      effects = out.context.currentQueryContext.effects;
      return out as never;
    }) as (ctx: unknown) => never);
  try {
    second();
  } finally {
    internal.run = run;
  }
  const qc = new QueryContext(after as ChargedState, sim.address);
  qc.block = { ...qc.block, secondsSinceEpoch: BigInt(sim.now) };
  const big = 10n ** 18n;
  return () =>
    qc.runTranscript(
      { gas: { readTime: big, computeTime: big, bytesWritten: big, bytesDeleted: big }, effects, program: proof!.publicTranscript } as never,
      CostModel.initialCostModel(),
    );
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

  it('with no fee and no collateral, nothing moves (as v0), and no bond is taken', async () => {
    const { sim, runs, ask } = setup({ fee: 0n, collateral: 0n });
    const a = ask();
    const b = ask();
    sim.fulfil(a);
    sim.advance(601);
    sim.expire(b);
    expect(sim.transfers).toEqual([]);
    expect(() => sim.depositBond(1n)).toThrow(/takes no bond/);
    expect(await failingChecks(runs)).toEqual([]);
  });
});

describe('oracle bonds (#9)', () => {
  it('a request needs a free slot, sets it aside, and gives it back when answered', async () => {
    const { sim, runs, ask, accountsBalance, freeBond } = setup();
    expect(() => ask()).toThrow(/bond is too small/);
    sim.depositBond(2n);
    expect(sim.transfers.at(-1)).toEqual({ circuit: 'depositBond', to: 'contract', amount: 2n * COLLATERAL });
    accountsBalance();
    const a = ask();
    const b = ask();
    expect(freeBond()).toBe(0n);
    expect(() => ask()).toThrow(/bond is too small/);
    accountsBalance();
    sim.fulfil(a);
    expect(sim.getLedger().bondSlots).toBe(1n);
    expect(sim.paidTo(sim.oraclePayout)).toBe(FEE);
    accountsBalance();
    sim.fulfil(b);
    expect(sim.getLedger().bondSlots).toBe(2n);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it('a skipped request pays its refund address the fee and the collateral', async () => {
    const { sim, runs, ask, accountsBalance } = setup();
    sim.depositBond(1n);
    const id = ask(addr(0x33));
    sim.advance(601);
    expect(() => sim.fulfil(id)).toThrow(/expired/);
    sim.expire(id);
    expect(sim.paidTo(addr(0x33))).toBe(FEE + COLLATERAL);
    expect(sim.getLedger().bondSlots).toBe(0n);
    expect(sim.balance()).toBe(0n);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it('with collateral but no fee, a skipped request pays the collateral', async () => {
    const { sim, runs, ask, accountsBalance } = setup({ fee: 0n });
    sim.depositBond(1n);
    const id = ask(addr(0x34));
    sim.advance(601);
    sim.expire(id);
    expect(sim.paidTo(addr(0x34))).toBe(COLLATERAL);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it('only the current oracle withdraws, only free slots, to its payout', async () => {
    const { sim, runs, ask, accountsBalance } = setup();
    sim.depositBond(3n, { requesterSecret: addr(9) });
    const held = ask();
    expect(() => sim.withdrawBond(1n, sim.anyone)).toThrow();
    expect(() => sim.withdrawBond(1n, { oracleSecretKey: generateOracleSecretKey() })).toThrow(/not the current oracle/);
    expect(() => sim.withdrawBond(3n)).toThrow(/not that many free slots/);
    expect(() => sim.withdrawBond(0n)).toThrow(/nothing to withdraw/);
    sim.withdrawBond(2n);
    expect(sim.paidTo(sim.oraclePayout)).toBe(2n * COLLATERAL);
    expect(sim.getLedger().bondSlots).toBe(0n);
    accountsBalance();
    // The slot the pending request holds still pays out if it's skipped.
    sim.advance(601);
    sim.expire(held);
    expect(sim.paidTo(sim.refundTo)).toBe(FEE + COLLATERAL);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it("a replacement oracle doesn't take over the old bond: its free slots go back, and old requests settle with the old oracle", async () => {
    const { sim, runs, ask, accountsBalance } = setup();
    sim.depositBond(3n);
    const old1 = ask();
    const old2 = ask(addr(0x44));
    const newSk = generateOracleSecretKey();
    sim.proposeOracleKey(oraclePublicKey(newSk));
    sim.approveOracleKey();
    sim.acceptOracleKey({ oracleSecretKey: newSk }, addr(0x55));
    // The free slot went back to the old oracle's payout; the new oracle starts with none.
    expect(sim.paidTo(sim.oraclePayout)).toBe(COLLATERAL);
    expect(sim.getLedger().bondSlots).toBe(0n);
    expect(hex(sim.getLedger().oraclePayout.bytes)).toBe(hex(addr(0x55)));
    expect(() => ask()).toThrow(/bond is too small/);
    accountsBalance();
    // The old oracle answers one of its own: fee and collateral both go to its payout.
    sim.fulfil(old1);
    expect(sim.paidTo(sim.oraclePayout)).toBe(COLLATERAL + FEE + COLLATERAL);
    expect(sim.getLedger().bondSlots).toBe(0n);
    // The other expires: its refund address gets fee and collateral.
    sim.advance(601);
    sim.expire(old2);
    expect(sim.paidTo(addr(0x44))).toBe(FEE + COLLATERAL);
    expect(sim.balance()).toBe(0n);
    // The new oracle's requests pay the new payout.
    sim.depositBond(1n);
    const fresh = ask();
    sim.fulfil(fresh, { oracleSecretKey: newSk });
    expect(sim.paidTo(addr(0x55))).toBe(FEE);
    expect(sim.getLedger().bondSlots).toBe(1n);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it('a key accepted again (A, then B, then A) starts a new term: old requests settle with the old payout', async () => {
    const { sim, sk, runs, ask, accountsBalance } = setup();
    sim.depositBond(1n);
    const first = ask();
    const b = generateOracleSecretKey();
    sim.proposeOracleKey(oraclePublicKey(b));
    sim.approveOracleKey();
    sim.acceptOracleKey({ oracleSecretKey: b }, addr(0x66));
    sim.proposeOracleKey(oraclePublicKey(sk), { operatorSecret: sim.opts.operatorSecret });
    sim.approveOracleKey({ oracleSecretKey: b });
    sim.acceptOracleKey(sim.oracle, addr(0x77));
    sim.fulfil(first);
    // Both the fee and the collateral of the first term's request go to the first term's payout.
    expect(sim.paidTo(sim.oraclePayout)).toBe(FEE + COLLATERAL);
    expect(sim.paidTo(addr(0x77))).toBe(0n);
    expect(sim.getLedger().bondSlots).toBe(0n);
    accountsBalance();
    expect(await failingChecks(runs)).toEqual([]);
  });

  it('an approval is for the key proposed, not for a proposal made after it', () => {
    const { sim } = setup();
    const meant = generateOracleSecretKey();
    const swapped = generateOracleSecretKey();
    sim.proposeOracleKey(oraclePublicKey(meant));
    expect(() => sim.approveOracleKey(sim.oracle, oraclePublicKey(swapped))).toThrow(/not the one proposed/);
    // The operator gets in first with a different proposal: the oracle's approval of `meant` fails.
    sim.proposeOracleKey(oraclePublicKey(swapped));
    expect(() => sim.approveOracleKey(sim.oracle, oraclePublicKey(meant))).toThrow(/not the one proposed/);
    expect(() => sim.acceptOracleKey({ oracleSecretKey: swapped })).toThrow(/still waiting/);
  });

  it('the key-change wait counts from the latest time the operator’s clock could stand for', () => {
    const { sim } = setup();
    const next = generateOracleSecretKey();
    // A clock 599 s behind the block is accepted, but doesn't shorten the wait.
    sim.proposeOracleKey(oraclePublicKey(next), { operatorSecret: sim.opts.operatorSecret }, BigInt(sim.now) - 599n);
    sim.advance(Number(MAX) - 1);
    expect(() => sim.acceptOracleKey({ oracleSecretKey: next })).toThrow(/still waiting/);
    sim.advance(2);
    sim.acceptOracleKey({ oracleSecretKey: next });
  });

  it('a deposit needs an active key and at least one slot', () => {
    const sk = generateOracleSecretKey();
    const sim = new NightcastSimulator({ oracleSecretKey: sk, operatorSecret: generateOperatorSecret(), acceptKey: false, collateralPerRequest: 5n });
    expect(() => sim.depositBond(1n)).toThrow(/no current oracle key/);
    sim.acceptOracleKey();
    expect(() => sim.depositBond(0n)).toThrow(/nothing to deposit/);
    sim.depositBond(4n);
    expect(sim.getLedger().bondSlots).toBe(4n);
    expect(sim.balance()).toBe(20n);
  });

  it('keeps its accounts through a long random mix of everything', async () => {
    const { sim, runs, ask, accountsBalance } = setup();
    const pending: Uint8Array[] = [];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    for (let step = 0; step < 120; step++) {
      const pick = rand(6);
      try {
        if (pick === 0) sim.depositBond(BigInt(1 + rand(3)));
        else if (pick === 1 || pick === 2) pending.push(ask(addr(1 + rand(4))));
        else if (pick === 3 && pending.length) sim.fulfil(pending.splice(rand(pending.length), 1)[0]);
        else if (pick === 4 && sim.getLedger().bondSlots > 0n) sim.withdrawBond(1n);
        else if (pick === 5) {
          sim.advance(200);
          for (const id of [...pending]) {
            if (BigInt(sim.now) >= sim.getLedger().requests.lookup(id).deadline) {
              sim.expire(id);
              pending.splice(pending.indexOf(id), 1);
            }
          }
        }
      } catch (err) {
        expect(String(err)).toMatch(/bond is too small/);
      }
      accountsBalance();
    }
    expect(await failingChecks(runs.slice(0, 60))).toEqual([]);
  }, 60_000);
});

describe('requests and answers in the same block (the bond is a Counter)', () => {
  it('two requests made at once both land', () => {
    const { sim, ask } = setup();
    sim.depositBond(5n);
    expect(sameBlock(sim, () => ask(), () => ask(undefined, { requesterSecret: addr(2) }))).not.toThrow();
  });

  it('two answers made at once both land', () => {
    const { sim, ask } = setup();
    sim.depositBond(5n);
    const a = ask();
    const b = ask();
    expect(sameBlock(sim, () => sim.fulfil(a), () => sim.fulfil(b))).not.toThrow();
  });

  it('a request and an answer made at once both land, and so do a deposit and a request', () => {
    const { sim, ask } = setup();
    sim.depositBond(5n);
    const a = ask();
    expect(sameBlock(sim, () => sim.fulfil(a), () => ask())).not.toThrow();
    expect(sameBlock(sim, () => sim.depositBond(1n), () => ask())).not.toThrow();
  });

  it('but the last free slot can only be taken once', () => {
    const { sim, ask } = setup();
    sim.depositBond(1n);
    expect(sameBlock(sim, () => ask(), () => ask(undefined, { requesterSecret: addr(3) }))).toThrow();
  });
});
