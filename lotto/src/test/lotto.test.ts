import { describe, it, expect } from 'vitest';
import {
  generateOracleSecretKey,
  generateOperatorSecret,
  oraclePublicKey,
  pureCircuits as nightcast,
} from '@nightcast/contract';
import { combineDrawSeed, drawStarfall, seedCommitment } from '@nightcast/sdk';
import { DrawStatus, pureCircuits } from '../managed/lotto/contract/index.js';
import { LottoSimulator } from '../simulator.js';
import { divisionFor, makeTicket, prizesFor, quickPick, SHARES_BP, type PlainLine } from '../tickets.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const bytes = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label).slice(0, 32));
  return out;
};

const PRICE = 1_000_000n; // 1 tNIGHT
const MIN_SALES = 600n;
const MAX_SALES = 30n * 86_400n;
const REVEAL = 3_600n;
const DRAW = 3_600n;
const CLAIM = 86_400n;
const SALES = 3_600; // how long the tests' draws sell for
const PLAYER = bytes('player wallet');
const OTHER = bytes('someone else');

const setup = (opts: { acceptKey?: boolean; linePrice?: bigint } = {}) => {
  const oracleSecretKey = generateOracleSecretKey();
  const organiserSecret = generateOperatorSecret();
  const sim = new LottoSimulator({
    oracleSecretKey,
    organiserSecret,
    linePrice: opts.linePrice ?? PRICE,
    minSales: MIN_SALES,
    maxSales: MAX_SALES,
    revealWindow: REVEAL,
    drawWindow: DRAW,
    claimWindow: CLAIM,
    acceptKey: opts.acceptKey,
  });
  return { sim, oracleSecretKey };
};

/** Open the next draw (closing in an hour); returns its number, seed and the numbers it will draw. */
const openWithSeed = (sim: LottoSimulator, sk: bigint, label = `seed ${sim.getLedger().lastDraw + 1n}`) => {
  const seed = bytes(label);
  const close = BigInt(sim.now + SALES);
  const n = sim.openDraw(close, fromHex(seedCommitment(hex(seed))));
  const output = nightcast.evaluate(sk, sim.alphaOf(n, seed));
  const draw = drawStarfall(combineDrawSeed(hex(seed), output));
  return { n, seed, close, output, draw };
};

/** The next draw's details, to open when revealing a seed; plus its seed and the numbers it will draw. */
const nextWithSeed = (sim: LottoSimulator, sk: bigint, label = `seed ${sim.getLedger().lastDraw + 1n}`) => {
  const seed = bytes(label);
  const n = sim.getLedger().lastDraw + 1n;
  const next = { salesClose: BigInt(sim.now + SALES), seedCommitment: fromHex(seedCommitment(hex(seed))) };
  const draw = drawStarfall(combineDrawSeed(hex(seed), nightcast.evaluate(sk, sim.alphaOf(n, seed))));
  return { n, seed, next, draw };
};

const closeSales = (sim: LottoSimulator) => sim.advance(SALES + 1);

/** Run a draw from sales close to numbers. */
const drawIt = (sim: LottoSimulator, n: bigint, seed: Uint8Array) => {
  closeSales(sim);
  sim.requestDraw(n, seed);
  sim.fulfilDraw(n);
  return sim.computeNumbers(n);
};

/** Close the claim window and settle. */
const settle = (sim: LottoSimulator, n: bigint) => {
  sim.advance(Number(CLAIM) + 1);
  sim.settleDraw(n);
};

/** A line that hits exactly `match` main numbers, with or without the Moonball. */
const lineHitting = (numbers: number[], moonball: number, match: number, withMoonball: boolean): PlainLine => {
  const hits = numbers.slice(0, match);
  const misses = Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !numbers.includes(x)).slice(0, 7 - match);
  return { numbers: [...hits, ...misses], moonball: withMoonball ? moonball : (moonball % 20) + 1 };
};

describe('the draw', () => {
  it("uses the same VRF as Nightcast and the site's number rule", () => {
    const { sim, oracleSecretKey } = setup();
    for (let i = 0; i < 4; i++) {
      const { n, seed, output, draw } = openWithSeed(sim, oracleSecretKey, `vrf check ${i}`);
      closeSales(sim);
      sim.requestDraw(n, seed);
      expect(hex(sim.fulfilDraw(n))).toBe(hex(output));
      const nums = sim.computeNumbers(n);
      expect(nums.main.map(Number)).toEqual(draw.numbers);
      expect(Number(nums.moonball)).toBe(draw.moonball);
      const d = sim.getLedger().draws.lookup(n);
      expect(d.status).toBe(DrawStatus.drawn);
      expect(d.numbers.map(Number)).toEqual(draw.numbers);
      settle(sim, n);
    }
  });

  it('only accepts the committed seed, from the organiser, after sales close', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    expect(() => sim.requestDraw(n, seed)).toThrow(/sales are still open/);
    closeSales(sim);
    expect(() => sim.requestDraw(n, bytes('a different seed'))).toThrow(/does not match the commitment/);
    // Not even the oracle may fix the VRF input (SPEC §2: it could pick among hashToCurve outputs).
    expect(() => sim.requestDraw(n, seed, sim.anyone)).toThrow();
    expect(() => sim.requestDraw(n, seed, sim.oracle)).toThrow();
    sim.requestDraw(n, seed);
    expect(sim.getLedger().draws.lookup(n).status).toBe(DrawStatus.requested);
    expect(() => sim.requestDraw(n, seed)).toThrow(/not open/);
  });

  it('needs an accepted oracle key, and only that oracle can answer', () => {
    const { sim, oracleSecretKey } = setup({ acceptKey: false });
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    closeSales(sim);
    expect(() => sim.requestDraw(n, seed)).toThrow(/no active oracle key/);
    expect(() => sim.acceptOracleKey({ oracleSecretKey: generateOracleSecretKey() })).toThrow(/does not match/);
    sim.acceptOracleKey();
    sim.requestDraw(n, seed);
    expect(() => sim.fulfilDraw(n, { oracleSecretKey: generateOracleSecretKey() })).toThrow(/not the oracle/);
    sim.fulfilDraw(n);
  });

  it('lets the organiser rotate the oracle key; a requested draw keeps its key', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed } = openWithSeed(sim, oracleSecretKey);
    closeSales(sim);
    sim.requestDraw(n, seed);
    const next = generateOracleSecretKey();
    expect(() => sim.proposeOracleKey(oraclePublicKey(next), sim.anyone)).toThrow();
    sim.proposeOracleKey(oraclePublicKey(next));
    sim.acceptOracleKey({ oracleSecretKey: next });
    expect(() => sim.fulfilDraw(n, { oracleSecretKey: next })).toThrow(/not the oracle/);
    sim.fulfilDraw(n);
  });

  it('starts the claim window when the numbers are computed, within the clock tolerance', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed, draw } = openWithSeed(sim, oracleSecretKey);
    const t = makeTicket(n, [lineHitting(draw.numbers, draw.moonball, 3, true)]);
    sim.buyTicket(t);
    closeSales(sim);
    sim.requestDraw(n, seed);
    sim.fulfilDraw(n);
    // Computed late, just before the deadline for computing...
    sim.advance(Number(REVEAL + DRAW + CLAIM) - 10);
    expect(() => sim.computeNumbers(n, BigInt(sim.now + 1_000))).toThrow(/clock/);
    expect(() => sim.computeNumbers(n, BigInt(sim.now - 1_000))).toThrow(/clock/);
    sim.computeNumbers(n);
    // ...winners still get the whole claim window from then.
    sim.advance(Number(CLAIM) - 100);
    expect(sim.registerWin(t, 0n, PLAYER)).toBe(8n);
    expect(() => sim.settleDraw(n)).toThrow(/still open/);
    sim.advance(101);
    sim.settleDraw(n);
  });
});

describe('opening draws', () => {
  it('only the organiser opens draws, numbered in order', () => {
    const { sim, oracleSecretKey } = setup();
    const close = BigInt(sim.now + SALES);
    expect(() => sim.openDraw(close, bytes('c'), { organiserSecret: generateOperatorSecret() })).toThrow(/not the organiser/);
    const { n } = openWithSeed(sim, oracleSecretKey);
    expect(n).toBe(1n);
    expect(sim.getLedger().lastDraw).toBe(1n);
  });

  it('enforces the minimum and maximum sales period', () => {
    const { sim } = setup();
    expect(() => sim.openDraw(BigInt(sim.now - 1), bytes('a'))).toThrow();
    expect(() => sim.openDraw(BigInt(sim.now) + MIN_SALES - 1n, bytes('a'))).toThrow(/too short/);
    expect(() => sim.openDraw(BigInt(sim.now) + MAX_SALES + 1n, bytes('a'))).toThrow(/too long/);
    expect(sim.openDraw(BigInt(sim.now) + MIN_SALES + 1n, bytes('a'))).toBe(1n);
  });

  it('sells one draw at a time; revealing a seed opens the next draw', () => {
    const { sim, oracleSecretKey } = setup();
    const first = openWithSeed(sim, oracleSecretKey);
    expect(() => openWithSeed(sim, oracleSecretKey, 'second')).toThrow(/still selling/);
    closeSales(sim);
    // Sales close and the seed is revealed, but the next draw can't be one that sells too briefly...
    const second = nextWithSeed(sim, oracleSecretKey);
    const tooShort = { ...second.next, salesClose: BigInt(sim.now) + MIN_SALES - 1n };
    expect(() => sim.requestAndOpenNext(first.n, first.seed, tooShort)).toThrow(/too short/);
    // ...and the whole step is undone, so the first draw is still waiting for its seed.
    expect(sim.getLedger().draws.lookup(first.n).status).toBe(DrawStatus.open);
    expect(() => sim.requestAndOpenNext(first.n, first.seed, second.next, sim.oracle)).toThrow();
    sim.requestAndOpenNext(first.n, first.seed, second.next);
    expect(sim.getLedger().lastDraw).toBe(2n);
    expect(sim.getLedger().draws.lookup(first.n).status).toBe(DrawStatus.requested);
    expect(sim.getLedger().draws.lookup(second.n).status).toBe(DrawStatus.open);
    // Players buy into the next draw while the first is being drawn.
    sim.buyTicket(makeTicket(second.n, [quickPick()]));
    expect(() => openWithSeed(sim, oracleSecretKey, 'third')).toThrow(/still selling/);
    sim.fulfilDraw(first.n);
    expect(sim.computeNumbers(first.n).main.map(Number)).toEqual(first.draw.numbers);
    // Revealing without a next draw leaves room to open one directly.
    closeSales(sim);
    sim.requestDraw(second.n, second.seed);
    expect(openWithSeed(sim, oracleSecretKey, 'third').n).toBe(3n);
  });

  it('settles draws in order', () => {
    const { sim, oracleSecretKey } = setup();
    const first = openWithSeed(sim, oracleSecretKey);
    closeSales(sim);
    const second = nextWithSeed(sim, oracleSecretKey);
    sim.requestAndOpenNext(first.n, first.seed, second.next);
    sim.fulfilDraw(first.n);
    sim.computeNumbers(first.n);
    drawIt(sim, second.n, second.seed);
    sim.advance(Number(CLAIM) + 1);
    expect(() => sim.settleDraw(second.n)).toThrow(/previous draw isn't settled/);
    sim.settleDraw(first.n);
    sim.settleDraw(second.n);
  });

  it('never reuses a seed commitment', () => {
    const { sim, oracleSecretKey } = setup();
    const first = openWithSeed(sim, oracleSecretKey, 'reused');
    closeSales(sim);
    const again = nextWithSeed(sim, oracleSecretKey, 'reused');
    expect(() => sim.requestAndOpenNext(first.n, first.seed, again.next)).toThrow(/already used/);
    sim.requestDraw(first.n, first.seed);
    expect(() => openWithSeed(sim, oracleSecretKey, 'reused')).toThrow(/already used/);
  });
});

describe('tickets', () => {
  it('sell only while the draw is open', () => {
    const { sim, oracleSecretKey } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    sim.buyTicket(makeTicket(n, [quickPick(), quickPick(), quickPick()]));
    sim.buyTicket(makeTicket(n, [quickPick()]));
    expect(sim.linesSold(n)).toBe(4n);
    expect(sim.getLedger().tickets.size()).toBe(2n);
    closeSales(sim);
    expect(() => sim.buyTicket(makeTicket(n, [quickPick()]))).toThrow(/sales have closed/);
    expect(() => sim.buyTicket(makeTicket(n + 1n, [quickPick()]))).toThrow(/unknown draw/);
  });

  it('keep the numbers secret: only a commitment is stored', () => {
    const { sim, oracleSecretKey } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    const t = makeTicket(n, [{ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 8 }]);
    const c = sim.buyTicket(t);
    expect(hex(c)).toBe(hex(sim.commitmentOf(t)));
    expect(sim.getLedger().tickets.lookup(c)).toEqual({ drawId: n, count: 1n, refunded: false });
    expect(() => sim.buyTicket(t)).toThrow(/already bought/);
  });

  it('reject malformed tickets', () => {
    const { sim, oracleSecretKey } = setup();
    const { n } = openWithSeed(sim, oracleSecretKey);
    const good = makeTicket(n, [quickPick()]);
    const bad = (patch: (t: typeof good) => void) => {
      const t = structuredClone(good);
      patch(t);
      return t;
    };
    expect(() => sim.buyTicket(bad((t) => (t.count = 0n)))).toThrow(/invalid ticket/);
    expect(() => sim.buyTicket(bad((t) => (t.count = 6n)))).toThrow(/invalid ticket/);
    expect(() => sim.buyTicket(bad((t) => (t.lines[0].numbers = [7n, 6n, 5n, 4n, 3n, 2n, 1n])))).toThrow(/invalid ticket/);
    expect(() => sim.buyTicket(bad((t) => (t.lines[0].numbers = [1n, 2n, 3n, 4n, 5n, 6n, 36n])))).toThrow(/invalid ticket/);
    expect(() => sim.buyTicket(bad((t) => (t.lines[0].numbers = [0n, 2n, 3n, 4n, 5n, 6n, 7n])))).toThrow(/invalid ticket/);
    expect(() => sim.buyTicket(bad((t) => (t.lines[0].moonball = 21n)))).toThrow(/invalid ticket/);
    expect(() => sim.buyTicket(bad((t) => (t.lines[1].moonball = 3n)))).toThrow(/invalid ticket/);
    expect(() => makeTicket(n, [{ numbers: [1, 1, 2, 3, 4, 5, 6], moonball: 1 }])).toThrow(/distinct/);
  });
});

describe('prizes', () => {
  it('pays every division its share, split between its lines, and rolls the rest over', () => {
    const { sim, oracleSecretKey } = setup();
    const { n, seed, draw } = openWithSeed(sim, oracleSecretKey);
    const { numbers, moonball } = draw;

    // One ticket with a division 1 line and a losing line; two division 9
    // lines on separate tickets; one division 7 line; and filler.
    const jackpot = makeTicket(n, [lineHitting(numbers, moonball, 7, true), lineHitting(numbers, moonball, 0, false)]);
    const nineA = makeTicket(n, [lineHitting(numbers, moonball, 2, true)]);
    const nineB = makeTicket(n, [lineHitting(numbers, moonball, 2, true)]);
    const seven = makeTicket(n, [lineHitting(numbers, moonball, 5, false)]);
    const filler = makeTicket(n, [lineHitting(numbers, moonball, 1, false), lineHitting(numbers, moonball, 0, false)]);
    for (const t of [jackpot, nineA, nineB, seven, filler]) sim.buyTicket(t);
    const pool = 7n * PRICE;

    expect(divisionFor(lineHitting(numbers, moonball, 7, true), numbers, moonball)).toBe(1);
    drawIt(sim, n, seed);

    expect(sim.registerWin(jackpot, 0n, PLAYER)).toBe(1n);
    expect(() => sim.registerWin(jackpot, 1n, PLAYER)).toThrow(/did not win/);
    expect(() => sim.registerWin(jackpot, 2n, PLAYER)).toThrow(/no such line/);
    expect(() => sim.registerWin(jackpot, 0n, PLAYER)).toThrow(/already registered/);
    expect(sim.registerWin(nineA, 0n, PLAYER)).toBe(9n);
    expect(sim.registerWin(nineB, 0n, OTHER)).toBe(9n);
    expect(sim.registerWin(seven, 0n, PLAYER)).toBe(7n);
    // Without the ticket's preimage nobody can claim it.
    expect(() => sim.registerWin(seven, 0n, OTHER, sim.holder(nineA))).toThrow();

    expect(() => sim.settleDraw(n)).toThrow(/still open/);
    sim.advance(Number(CLAIM) + 1);
    expect(() => sim.registerWin(filler, 0n, PLAYER)).toThrow(/closed/);
    sim.settleDraw(n);

    const winners = [1n, 0n, 0n, 0n, 0n, 0n, 1n, 0n, 2n];
    expect(sim.winners(n)).toEqual(winners);
    const expected = prizesFor(pool, winners);
    const d = sim.getLedger().draws.lookup(n);
    expect(d.prizes).toEqual(expected);
    expect(d.prizes[0]).toBe((pool * 3000n) / 10_000n);
    expect(d.prizes[8]).toBe((pool * 1750n) / 10_000n / 2n);
    const paid = expected.reduce((acc, p, i) => acc + p * winners[i], 0n);
    expect(sim.getLedger().carry).toBe(pool - paid);
    expect(SHARES_BP.reduce((a, b) => a + b, 0)).toBe(10_000);

    const line = pureCircuits.lineId(sim.commitmentOf(jackpot), 0n);
    sim.payWin(line);
    expect(sim.getLedger().wins.lookup(line).paid).toBe(true);
    expect(() => sim.payWin(line)).toThrow(/already paid/);
    sim.payWin(pureCircuits.lineId(sim.commitmentOf(nineA), 0n));
  });

  it('carries unwon divisions into the next draw to settle', () => {
    const { sim, oracleSecretKey } = setup();
    const first = openWithSeed(sim, oracleSecretKey);
    sim.buyTicket(makeTicket(first.n, [lineHitting(first.draw.numbers, first.draw.moonball, 0, false)]));
    closeSales(sim);
    const second = nextWithSeed(sim, oracleSecretKey);
    sim.requestAndOpenNext(first.n, first.seed, second.next);
    sim.fulfilDraw(first.n);
    sim.computeNumbers(first.n);
    const jackpot = makeTicket(second.n, [lineHitting(second.draw.numbers, second.draw.moonball, 7, true)]);
    sim.buyTicket(jackpot);
    drawIt(sim, second.n, second.seed);
    sim.registerWin(jackpot, 0n, PLAYER);
    sim.advance(Number(CLAIM) + 1);
    sim.settleDraw(first.n);
    expect(sim.getLedger().carry).toBe(PRICE);
    sim.settleDraw(second.n);
    const d = sim.getLedger().draws.lookup(second.n);
    expect(d.carried).toBe(PRICE);
    // A pool of 2 tNIGHT (this draw's line plus the rollover); division 1 takes 30%.
    expect(d.prizes[0]).toBe((2n * PRICE * 3000n) / 10_000n);
    expect(sim.getLedger().carry).toBe(2n * PRICE - d.prizes[0]);
  });

  it("can't pay before settlement or settle twice; a zero prize is marked paid", () => {
    // 1 STAR a line, so division 9's share of a 1-STAR pool rounds to 0.
    const { sim, oracleSecretKey } = setup({ linePrice: 1n });
    const { n, seed, draw } = openWithSeed(sim, oracleSecretKey);
    const t = makeTicket(n, [lineHitting(draw.numbers, draw.moonball, 2, true)]);
    sim.buyTicket(t);
    drawIt(sim, n, seed);
    sim.registerWin(t, 0n, PLAYER);
    const line = pureCircuits.lineId(sim.commitmentOf(t), 0n);
    expect(() => sim.payWin(line)).toThrow(/not settled/);
    settle(sim, n);
    expect(() => sim.settleDraw(n)).toThrow(/not drawn/);
    expect(sim.getLedger().draws.lookup(n).prizes[8]).toBe(0n);
    sim.payWin(line);
    expect(sim.getLedger().wins.lookup(line).paid).toBe(true);
  });
});

describe('refunds, never redraws', () => {
  const boughtDraw = () => {
    const ctx = setup();
    const opened = openWithSeed(ctx.sim, ctx.oracleSecretKey);
    const a = makeTicket(opened.n, [quickPick(), quickPick()]);
    const b = makeTicket(opened.n, [quickPick()]);
    ctx.sim.buyTicket(a);
    ctx.sim.buyTicket(b);
    return { ...ctx, ...opened, a, b };
  };

  it('voids a draw whose seed is never revealed, and refunds each ticket once', () => {
    const { sim, n, a, b } = boughtDraw();
    closeSales(sim);
    expect(() => sim.voidDraw(n)).toThrow(/can't be voided/);
    expect(() => sim.refundTicket(a, PLAYER)).toThrow(/not void/);
    sim.advance(Number(REVEAL));
    sim.voidDraw(n);
    expect(sim.getLedger().draws.lookup(n).status).toBe(DrawStatus.voided);
    sim.refundTicket(a, PLAYER);
    expect(sim.getLedger().tickets.lookup(sim.commitmentOf(a)).refunded).toBe(true);
    expect(() => sim.refundTicket(a, PLAYER)).toThrow(/already refunded/);
    expect(() => sim.refundTicket(b, PLAYER, sim.holder(a))).toThrow();
    sim.refundTicket(b, OTHER);
  });

  it('voids a draw the oracle never answers, and it stays void', () => {
    const { sim, n, seed } = boughtDraw();
    closeSales(sim);
    sim.requestDraw(n, seed);
    sim.advance(Number(REVEAL + DRAW) - 10);
    expect(() => sim.voidDraw(n)).toThrow(/can't be voided/);
    sim.advance(10);
    expect(() => sim.fulfilDraw(n)).toThrow(/deadline has passed/);
    sim.voidDraw(n);
    expect(() => sim.fulfilDraw(n)).toThrow(/not requested/);
    expect(() => sim.requestDraw(n, seed)).toThrow(/not open/);
  });

  it("doesn't let anyone void an answered draw while it can still be finished", () => {
    const { sim, n, seed } = boughtDraw();
    closeSales(sim);
    sim.requestDraw(n, seed);
    sim.fulfilDraw(n);
    sim.advance(Number(REVEAL + DRAW) + 10);
    // Past the draw deadline, before the deadline for computing: a losing
    // player can't cancel the draw.
    expect(() => sim.voidDraw(n)).toThrow(/can't be voided/);
    sim.computeNumbers(n);
    sim.advance(Number(CLAIM) + 1);
    expect(() => sim.voidDraw(n)).toThrow(/can't be voided/);
  });

  it('never allows computing and voiding at the same time', () => {
    const { sim, n, seed } = boughtDraw();
    closeSales(sim);
    sim.requestDraw(n, seed);
    sim.fulfilDraw(n);
    sim.advance(Number(REVEAL + DRAW + CLAIM));
    expect(() => sim.computeNumbers(n)).toThrow(/too late/);
    sim.voidDraw(n);
  });

  it('keeps the rollover for the draw after a void one', () => {
    const { sim, oracleSecretKey } = setup();
    const first = openWithSeed(sim, oracleSecretKey);
    sim.buyTicket(makeTicket(first.n, [lineHitting(first.draw.numbers, first.draw.moonball, 0, false)]));
    closeSales(sim);
    const second = nextWithSeed(sim, oracleSecretKey);
    sim.requestAndOpenNext(first.n, first.seed, second.next);
    sim.fulfilDraw(first.n);
    sim.computeNumbers(first.n);
    settle(sim, first.n);
    expect(sim.getLedger().carry).toBe(PRICE);
    // The keeper never reveals the second draw's seed: it is void, and the rollover waits.
    sim.voidDraw(second.n);
    expect(sim.getLedger().carry).toBe(PRICE);
    const third = openWithSeed(sim, oracleSecretKey);
    drawIt(sim, third.n, third.seed);
    settle(sim, third.n);
    expect(sim.getLedger().draws.lookup(third.n).carried).toBe(PRICE);
    expect(sim.getLedger().carry).toBe(PRICE);
  });
});
