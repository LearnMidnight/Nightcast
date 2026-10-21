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
 * Runs the compiled Midnight Lotto contract in memory, with a controllable
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

  openDraw(n: bigint, salesClose: bigint, seedCommitment: Uint8Array, as: LottoPrivateState = this.organiser): void {
    this.run(as, (ctx) => this.contract.impureCircuits.openDraw(ctx, n, salesClose, seedCommitment));
  }

  buyTicket(t: TicketPreimage, as: LottoPrivateState = { pendingTicket: t }): Uint8Array {
    return this.run(as, (ctx) => this.contract.impureCircuits.buyTicket(ctx));
  }

  requestDraw(n: bigint, seed: Uint8Array, as: LottoPrivateState = this.anyone): void {
    this.run(as, (ctx) => this.contract.impureCircuits.requestDraw(ctx, n, seed));
  }

  fulfilDraw(n: bigint, as: LottoPrivateState = this.oracle): Uint8Array {
    return this.run(as, (ctx) => this.contract.impureCircuits.fulfilDraw(ctx, n));
  }

  computeNumbers(n: bigint, as: LottoPrivateState = this.anyone): Numbers {
    return this.run(as, (ctx) => this.contract.impureCircuits.computeNumbers(ctx, n));
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
