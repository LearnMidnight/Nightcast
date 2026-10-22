import {
  type ChargedState,
  type CircuitContext,
  type ContractState,
  createCircuitContext,
  createConstructorContext,
  encodeContractAddress,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { oraclePublicKey } from '@nightcast/contract';
import {
  Contract,
  type Ledger,
  type NextDraw,
  type Numbers,
  type TicketPreimage,
  ledger,
  pureCircuits,
} from './managed/lotto/contract/index.js';
import { type LottoPrivateState, witnesses } from './witnesses.js';

const COIN_PUBLIC_KEY = '0'.repeat(64);

export type LottoSimulatorOptions = {
  oracleSecretKey: bigint;
  organiserSecret: Uint8Array;
  /** Price of one line in STAR (default 1 tNIGHT). */
  linePrice?: bigint;
  minSales?: bigint;
  maxSales?: bigint;
  revealWindow?: bigint;
  drawWindow?: bigint;
  claimWindow?: bigint;
  /** Starting block time, seconds since the epoch. */
  now?: number;
  /** Activate the oracle key right after deployment (default true). */
  acceptKey?: boolean;
};

type Result<R> = { result: R; context: CircuitContext<LottoPrivateState> };

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * Runs the compiled Lunardraw contract in memory, with a controllable
 * clock. Each call picks whose private state the witnesses see; a failed call
 * leaves the state unchanged. Token transfers are not simulated: the ledger's
 * own accounting (sales, carry, prizes) is what the tests check.
 */
export class LottoSimulator {
  readonly contract = new Contract<LottoPrivateState>(witnesses);
  readonly address = sampleContractAddress();
  readonly addressBytes: Uint8Array;
  now: number;
  private state: ContractState | ChargedState;

  constructor(readonly opts: LottoSimulatorOptions) {
    this.now = opts.now ?? 1_800_000_000;
    this.addressBytes = encodeContractAddress(this.address);
    const result = this.contract.initialState(
      createConstructorContext<LottoPrivateState>({}, COIN_PUBLIC_KEY),
      oraclePublicKey(opts.oracleSecretKey),
      pureCircuits.organiserCommitmentOf(opts.organiserSecret),
      opts.linePrice ?? 1_000_000n,
      opts.minSales ?? 600n,
      opts.maxSales ?? 2_592_000n,
      opts.revealWindow ?? 3_600n,
      opts.drawWindow ?? 3_600n,
      opts.claimWindow ?? 86_400n,
    );
    this.state = result.currentContractState;
    if (opts.acceptKey ?? true) this.acceptOracleKey();
  }

  get oracle(): LottoPrivateState {
    return { oracleSecretKey: this.opts.oracleSecretKey };
  }

  get organiser(): LottoPrivateState {
    return { organiserSecret: this.opts.organiserSecret };
  }

  readonly anyone: LottoPrivateState = {};

  /** Private state of someone holding these tickets. */
  holder(...tickets: TicketPreimage[]): LottoPrivateState {
    return { tickets: Object.fromEntries(tickets.map((t) => [hex(this.commitmentOf(t)), t])) };
  }

  advance(seconds: number): void {
    this.now += seconds;
  }

  publicState(): ChargedState {
    const s = this.state as ContractState;
    return 'data' in s ? s.data : (this.state as ChargedState);
  }

  getLedger(): Ledger {
    return ledger(this.publicState());
  }

  commitmentOf(t: TicketPreimage): Uint8Array {
    return pureCircuits.ticketCommitment({ bytes: this.addressBytes }, t);
  }

  /** Lines sold for a draw. */
  linesSold(n: bigint): bigint {
    return this.getLedger().drawLines.lookup(n).read();
  }

  /** Registered winning lines per division (division 1 first). */
  winners(n: bigint): bigint[] {
    const l = this.getLedger();
    return [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n].map((d) => l.winnerCounts.lookup(pureCircuits.winnerKey(n, d)).read());
  }

  alphaOf(drawId: bigint, seed: Uint8Array): Uint8Array {
    return pureCircuits.drawAlpha({ bytes: this.addressBytes }, drawId, seed);
  }

  private run<R>(privateState: LottoPrivateState, call: (ctx: CircuitContext<LottoPrivateState>) => Result<R>): R {
    const ctx = createCircuitContext<LottoPrivateState>(
      this.address,
      COIN_PUBLIC_KEY,
      this.state,
      privateState,
      undefined,
      undefined,
      this.now,
    );
    const out = call(ctx);
    this.state = out.context.currentQueryContext.state;
    return out.result;
  }

  acceptOracleKey(as: LottoPrivateState = this.oracle): void {
    this.run(as, (ctx) => this.contract.impureCircuits.acceptOracleKey(ctx));
  }

  proposeOracleKey(key: { x: bigint; y: bigint }, as: LottoPrivateState = this.organiser): void {
    this.run(as, (ctx) => this.contract.impureCircuits.proposeOracleKey(ctx, key));
  }

  /** Open the next draw; returns its number. */
  openDraw(salesClose: bigint, seedCommitment: Uint8Array, as: LottoPrivateState = this.organiser): bigint {
    return this.run(as, (ctx) => this.contract.impureCircuits.openDraw(ctx, salesClose, seedCommitment));
  }

  buyTicket(t: TicketPreimage, as: LottoPrivateState = { pendingTicket: t }): Uint8Array {
    return this.run(as, (ctx) => this.contract.impureCircuits.buyTicket(ctx));
  }

  /** Reveal a draw's seed without opening another draw. */
  requestDraw(n: bigint, seed: Uint8Array, as: LottoPrivateState = this.organiser): void {
    const none = { is_some: false, value: { salesClose: 0n, seedCommitment: new Uint8Array(32) } };
    this.run(as, (ctx) => this.contract.impureCircuits.requestDraw(ctx, n, seed, none));
  }

  /** Reveal a draw's seed and open the next draw in the same transaction (what the keeper does). */
  requestAndOpenNext(
    n: bigint,
    seed: Uint8Array,
    next: NextDraw,
    as: LottoPrivateState = this.organiser,
  ): void {
    this.run(as, (ctx) => this.contract.impureCircuits.requestDraw(ctx, n, seed, { is_some: true, value: next }));
  }

  fulfilDraw(n: bigint, as: LottoPrivateState = this.oracle): Uint8Array {
    return this.run(as, (ctx) => this.contract.impureCircuits.fulfilDraw(ctx, n));
  }

  /** Compute a draw's numbers; `now` defaults to the simulator's clock. */
  computeNumbers(n: bigint, now: bigint = BigInt(this.now), as: LottoPrivateState = this.anyone): Numbers {
    return this.run(as, (ctx) => this.contract.impureCircuits.computeNumbers(ctx, n, now));
  }

  registerWin(t: TicketPreimage, index: bigint, recipient: Uint8Array, as: LottoPrivateState = this.holder(t)): bigint {
    return this.run(as, (ctx) =>
      this.contract.impureCircuits.registerWin(ctx, this.commitmentOf(t), index, { bytes: recipient }),
    );
  }

  settleDraw(n: bigint, as: LottoPrivateState = this.anyone): void {
    this.run(as, (ctx) => this.contract.impureCircuits.settleDraw(ctx, n));
  }

  payWin(lineId: Uint8Array, as: LottoPrivateState = this.anyone): void {
    this.run(as, (ctx) => this.contract.impureCircuits.payWin(ctx, lineId));
  }

  voidDraw(n: bigint, as: LottoPrivateState = this.anyone): void {
    this.run(as, (ctx) => this.contract.impureCircuits.voidDraw(ctx, n));
  }

  refundTicket(t: TicketPreimage, recipient: Uint8Array, as: LottoPrivateState = this.holder(t)): void {
    this.run(as, (ctx) => this.contract.impureCircuits.refundTicket(ctx, this.commitmentOf(t), { bytes: recipient }));
  }
}
