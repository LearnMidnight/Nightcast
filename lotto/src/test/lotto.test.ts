import { describe, it, expect } from 'vitest';
import { generateOracleSecretKey, generateOperatorSecret, pureCircuits as nightcast } from '@nightcast/contract';
import { combineDrawSeed, drawMidnight7, seedCommitment } from '@nightcast/sdk';
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
const REVEAL = 3_600n;
const DRAW = 3_600n;
const CLAIM = 86_400n;
const PLAYER = bytes('player wallet');
const OTHER = bytes('someone else');

const setup = (opts: { acceptKey?: boolean } = {}) => {
  const oracleSecretKey = generateOracleSecretKey();
  const organiserSecret = generateOperatorSecret();
  const sim = new LottoSimulator({
    oracleSecretKey,
    organiserSecret,
    linePrice: PRICE,
    revealWindow: REVEAL,
    drawWindow: DRAW,
    claimWindow: CLAIM,
    ...opts,
  });
  return { sim, oracleSecretKey };
};

/** Open draw `n` closing in an hour; returns its seed and the numbers it will draw. */
const openWithSeed = (sim: LottoSimulator, sk: bigint, n = 1n, label = `seed ${n}`) => {
  const seed = bytes(label);
  const close = BigInt(sim.now + 3_600);
  sim.openDraw(n, close, fromHex(seedCommitment(hex(seed))));
  const output = nightcast.evaluate(sk, sim.alphaOf(n, seed));
  const draw = drawMidnight7(combineDrawSeed(hex(seed), output));
  return { seed, close, output, draw };
};

/** A line that hits exactly `match` main numbers, with or without the Moonball. */
const lineHitting = (numbers: number[], moonball: number, match: number, withMoonball: boolean): PlainLine => {
  const hits = numbers.slice(0, match);
  const misses = Array.from({ length: 35 }, (_, i) => i + 1).filter((x) => !numbers.includes(x)).slice(0, 7 - match);
  return { numbers: [...hits, ...misses], moonball: withMoonball ? moonball : (moonball % 20) + 1 };
};

const closeSales = (sim: LottoSimulator) => sim.advance(3_601);

describe('the draw', () => {
  it('uses the same VRF as Nightcast and the site\'s number rule', () => {
    const { sim, oracleSecretKey } = setup();
    for (let n = 1n; n <= 4n; n++) {
      const { seed, output, draw } = openWithSeed(sim, oracleSecretKey, n, `vrf check ${n}`);
      closeSales(sim);
      sim.requestDraw(n, seed);
      expect(hex(sim.fulfilDraw(n))).toBe(hex(output));
      const nums = sim.computeNumbers(n);
      expect(nums.main.map(Number)).toEqual(draw.numbers);
      expect(Number(nums.moonball)).toBe(draw.moonball);
      const d = sim.getLedger().draws.lookup(n);
      expect(d.status).toBe(DrawStatus.drawn);
      expect(d.numbers.map(Number)).toEqual(draw.numbers);
    }
  });

  it('only accepts the committed seed, and only after sales close', () => {
    const { sim, oracleSecretKey } = setup();
    const { seed } = openWithSeed(sim, oracleSecretKey);
    expect(() => sim.requestDraw(1n, seed)).toThrow(/sales are still open/);
    closeSales(sim);
    expect(() => sim.requestDraw(1n, bytes('a different seed'))).toThrow(/does not match the commitment/);
    sim.requestDraw(1n, seed);
    expect(sim.getLedger().draws.lookup(1n).status).toBe(DrawStatus.requested);
    expect(() => sim.requestDraw(1n, seed)).toThrow(/not open/);
  });

  it('needs an accepted oracle key, and only that oracle can answer', () => {
    const { sim, oracleSecretKey } = setup({ acceptKey: false });
    const { seed } = openWithSeed(sim, oracleSecretKey);
    closeSales(sim);
    expect(() => sim.requestDraw(1n, seed)).toThrow(/no active oracle key/);
    expect(() => sim.acceptOracleKey({ oracleSecretKey: generateOracleSecretKey() })).toThrow(/does not match/);
    sim.acceptOracleKey();
    sim.requestDraw(1n, seed);
    expect(() => sim.fulfilDraw(1n, { oracleSecretKey: generateOracleSecretKey() })).toThrow(/not the oracle/);
    sim.fulfilDraw(1n);
  });

  it('only the organiser opens draws, once each, in the future', () => {
    const { sim, oracleSecretKey } = setup();
    const close = BigInt(sim.now + 3_600);
    expect(() => sim.openDraw(1n, close, bytes('c'), { organiserSecret: generateOperatorSecret() })).toThrow(/not the organiser/);
    expect(() => sim.openDraw(1n, BigInt(sim.now - 1), bytes('c'))).toThrow(/in the past/);
    openWithSeed(sim, oracleSecretKey);
    expect(() => sim.openDraw(1n, close, bytes('c'))).toThrow(/already exists/);
  });
});

describe('tickets', () => {
  it('sell only while the draw is open, and add to the pool', () => {
    const { sim, oracleSecretKey } = setup();
    openWithSeed(sim, oracleSecretKey);
    sim.buyTicket(makeTicket(1, [quickPick(), quickPick(), quickPick()]));
    sim.buyTicket(makeTicket(1, [quickPick()]));
    const d = sim.getLedger().draws.lookup(1n);
    expect(d.lines).toBe(4n);
    expect(d.sales).toBe(4n * PRICE);
    expect(sim.getLedger().tickets.size()).toBe(2n);
    closeSales(sim);
    expect(() => sim.buyTicket(makeTicket(1, [quickPick()]))).toThrow(/sales have closed/);
    expect(() => sim.buyTicket(makeTicket(2, [quickPick()]))).toThrow(/unknown draw/);
  });

  it('keep the numbers secret: only a commitment is stored', () => {
    const { sim, oracleSecretKey } = setup();
    openWithSeed(sim, oracleSecretKey);
    const t = makeTicket(1, [{ numbers: [1, 2, 3, 4, 5, 6, 7], moonball: 8 }]);
    const c = sim.buyTicket(t);
    expect(hex(c)).toBe(hex(sim.commitmentOf(t)));
    const stored = sim.getLedger().tickets.lookup(c);
    expect(stored).toEqual({ drawId: 1n, count: 1n, refunded: false });
    expect(() => sim.buyTicket(t)).toThrow(/already bought/);
  });

  it('reject malformed tickets', () => {
    const { sim, oracleSecretKey } = setup();
    openWithSeed(sim, oracleSecretKey);
    const good = makeTicket(1, [quickPick()]);
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
    expect(() => makeTicket(1, [{ numbers: [1, 1, 2, 3, 4, 5, 6], moonball: 1 }])).toThrow(/distinct/);
  });
});

describe('prizes', () => {
  it('pays every division its share, split between its lines, and rolls the rest over', () => {
    const { sim, oracleSecretKey } = setup();
    const { seed, draw } = openWithSeed(sim, oracleSecretKey);
    const { numbers, moonball } = draw;

    // One ticket with a division 1 line and a losing line; two division 9
    // lines on separate tickets; one division 7 line; and filler.
    const jackpot = makeTicket(1, [lineHitting(numbers, moonball, 7, true), lineHitting(numbers, moonball, 0, false)]);
    const nineA = makeTicket(1, [lineHitting(numbers, moonball, 2, true)]);
    const nineB = makeTicket(1, [lineHitting(numbers, moonball, 2, true)]);
    const seven = makeTicket(1, [lineHitting(numbers, moonball, 5, false)]);
    const filler = makeTicket(1, [lineHitting(numbers, moonball, 1, false), lineHitting(numbers, moonball, 0, false)]);
    for (const t of [jackpot, nineA, nineB, seven, filler]) sim.buyTicket(t);
    const pool = 7n * PRICE;

    expect(divisionFor(lineHitting(numbers, moonball, 7, true), numbers, moonball)).toBe(1);
    closeSales(sim);
    sim.requestDraw(1n, seed);
    sim.fulfilDraw(1n);
    sim.computeNumbers(1n);

    expect(sim.registerWin(jackpot, 0n, PLAYER)).toBe(1n);
    expect(() => sim.registerWin(jackpot, 1n, PLAYER)).toThrow(/did not win/);
    expect(() => sim.registerWin(jackpot, 2n, PLAYER)).toThrow(/no such line/);
    expect(() => sim.registerWin(jackpot, 0n, PLAYER)).toThrow(/already registered/);
    expect(sim.registerWin(nineA, 0n, PLAYER)).toBe(9n);
    expect(sim.registerWin(nineB, 0n, OTHER)).toBe(9n);
    expect(sim.registerWin(seven, 0n, PLAYER)).toBe(7n);
    // Without the ticket's preimage nobody can claim it.
    expect(() => sim.registerWin(seven, 0n, OTHER, sim.holder(nineA))).toThrow();

    expect(() => sim.settleDraw(1n)).toThrow(/still open/);
    sim.advance(Number(REVEAL + DRAW + CLAIM));
    expect(() => sim.registerWin(filler, 0n, PLAYER)).toThrow(/closed/);
    sim.settleDraw(1n);

    const d = sim.getLedger().draws.lookup(1n);
    const winners = [1n, 0n, 0n, 0n, 0n, 0n, 1n, 0n, 2n];
    expect(d.winners).toEqual(winners);
    const expected = prizesFor(pool, winners);
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

  it('carries unwon divisions into the next draw', () => {
    const { sim, oracleSecretKey } = setup();
    const first = openWithSeed(sim, oracleSecretKey, 1n);
    sim.buyTicket(makeTicket(1, [lineHitting(first.draw.numbers, first.draw.moonball, 0, false)]));
    closeSales(sim);
    sim.requestDraw(1n, first.seed);
    sim.fulfilDraw(1n);
    sim.computeNumbers(1n);
    sim.advance(Number(REVEAL + DRAW + CLAIM));
    sim.settleDraw(1n);
    expect(sim.getLedger().carry).toBe(PRICE);

    openWithSeed(sim, oracleSecretKey, 2n);
    expect(sim.getLedger().draws.lookup(2n).carried).toBe(PRICE);
    expect(sim.getLedger().carry).toBe(0n);
  });

  it("can't pay before settlement or settle twice", () => {
    const { sim, oracleSecretKey } = setup();
    const { seed, draw } = openWithSeed(sim, oracleSecretKey);
    const t = makeTicket(1, [lineHitting(draw.numbers, draw.moonball, 7, true)]);
    sim.buyTicket(t);
    closeSales(sim);
    sim.requestDraw(1n, seed);
    sim.fulfilDraw(1n);
    sim.computeNumbers(1n);
    sim.registerWin(t, 0n, PLAYER);
    const line = pureCircuits.lineId(sim.commitmentOf(t), 0n);
    expect(() => sim.payWin(line)).toThrow(/not settled/);
    sim.advance(Number(REVEAL + DRAW + CLAIM));
    sim.settleDraw(1n);
    expect(() => sim.settleDraw(1n)).toThrow(/not drawn/);
    sim.payWin(line);
  });
});

describe('refunds, never redraws', () => {
  const boughtDraw = () => {
    const ctx = setup();
    const opened = openWithSeed(ctx.sim, ctx.oracleSecretKey);
    const a = makeTicket(1, [quickPick(), quickPick()]);
    const b = makeTicket(1, [quickPick()]);
    ctx.sim.buyTicket(a);
    ctx.sim.buyTicket(b);
    return { ...ctx, ...opened, a, b };
  };

  it('voids a draw whose seed is never revealed, and refunds each ticket once', () => {
    const { sim, a, b } = boughtDraw();
    closeSales(sim);
    expect(() => sim.voidDraw(1n)).toThrow(/can't be voided/);
    expect(() => sim.refundTicket(a, PLAYER)).toThrow(/not void/);
    sim.advance(Number(REVEAL));
    sim.voidDraw(1n);
    expect(sim.getLedger().draws.lookup(1n).status).toBe(DrawStatus.voided);
    sim.refundTicket(a, PLAYER);
    expect(sim.getLedger().tickets.lookup(sim.commitmentOf(a)).refunded).toBe(true);
    expect(() => sim.refundTicket(a, PLAYER)).toThrow(/already refunded/);
    expect(() => sim.refundTicket(b, PLAYER, sim.holder(a))).toThrow();
    sim.refundTicket(b, OTHER);
  });

  it('voids a draw the oracle never answers, and it stays void', () => {
    const { sim, seed } = boughtDraw();
    closeSales(sim);
    sim.requestDraw(1n, seed);
    sim.advance(Number(REVEAL + DRAW) - 10);
    expect(() => sim.voidDraw(1n)).toThrow(/can't be voided/);
    sim.advance(10);
    expect(() => sim.fulfilDraw(1n)).toThrow(/deadline has passed/);
    sim.voidDraw(1n);
    expect(() => sim.fulfilDraw(1n)).toThrow(/not requested/);
    expect(() => sim.requestDraw(1n, seed)).toThrow(/not open/);
  });

  it("doesn't let anyone void an answered draw while it can still be finished", () => {
    const { sim, seed } = boughtDraw();
    closeSales(sim);
    sim.requestDraw(1n, seed);
    sim.fulfilDraw(1n);
    sim.advance(Number(REVEAL + DRAW) + 10);
    // Past the draw deadline but inside the claim window: a losing player
    // can't cancel the draw.
    expect(() => sim.voidDraw(1n)).toThrow(/can't be voided/);
    sim.computeNumbers(1n);
    sim.advance(Number(CLAIM));
    expect(() => sim.voidDraw(1n)).toThrow(/can't be voided/);
  });

  it('gives back the rollover a void draw carried', () => {
    const { sim, oracleSecretKey } = setup();
    const first = openWithSeed(sim, oracleSecretKey, 1n);
    sim.buyTicket(makeTicket(1, [lineHitting(first.draw.numbers, first.draw.moonball, 0, false)]));
    closeSales(sim);
    sim.requestDraw(1n, first.seed);
    sim.fulfilDraw(1n);
    sim.computeNumbers(1n);
    sim.advance(Number(REVEAL + DRAW + CLAIM));
    sim.settleDraw(1n);
    openWithSeed(sim, oracleSecretKey, 2n);
    expect(sim.getLedger().carry).toBe(0n);
    sim.advance(3_601 + Number(REVEAL));
    sim.voidDraw(2n);
    expect(sim.getLedger().carry).toBe(PRICE);
  });
});

