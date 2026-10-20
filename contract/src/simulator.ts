import {
  type ChargedState,
  type CircuitContext,
  type ContractState,
  type JubjubPoint,
  createCircuitContext,
  createConstructorContext,
  encodeContractAddress,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, type Ledger, ledger, pureCircuits } from './managed/nightcast/contract/index.js';
import { type NightcastPrivateState, witnesses } from './witnesses.js';
import { oraclePublicKey } from './keys.js';

const COIN_PUBLIC_KEY = '0'.repeat(64);

export type SimulatorOptions = {
  oracleSecretKey: bigint;
  operatorSecret: Uint8Array;
  /** Default requester secret used by `request` when no private state is given. */
  requesterSecret?: Uint8Array;
  minWindow?: bigint;
  maxWindow?: bigint;
  /** Starting block time, seconds since the epoch. */
  now?: number;
  /** Activate the oracle key right after deployment (default true). */
  acceptKey?: boolean;
};

type Result<R> = { result: R; context: CircuitContext<NightcastPrivateState> };

/**
 * Runs the compiled Nightcast contract in memory. Several actors (requesters,
 * oracle, operator, anyone) share one ledger; each call picks whose private
 * state the witnesses see. A failed call leaves the state unchanged.
 */
export class NightcastSimulator {
  readonly contract = new Contract<NightcastPrivateState>(witnesses);
  readonly address = sampleContractAddress();
  readonly addressBytes: Uint8Array;
  now: number;
  private state: ContractState | ChargedState;

  constructor(readonly opts: SimulatorOptions) {
    this.now = opts.now ?? 1_800_000_000;
    this.addressBytes = encodeContractAddress(this.address);
    const result = this.contract.initialState(
      createConstructorContext<NightcastPrivateState>({}, COIN_PUBLIC_KEY),
      oraclePublicKey(opts.oracleSecretKey),
      pureCircuits.operatorCommitmentOf(opts.operatorSecret),
      opts.minWindow ?? 60n,
      opts.maxWindow ?? 3_600n,
    );
    this.state = result.currentContractState;
    if (opts.acceptKey ?? true) this.acceptOracleKey();
  }

  get oracle(): NightcastPrivateState {
    return { oracleSecretKey: this.opts.oracleSecretKey };
  }

  get operator(): NightcastPrivateState {
    return { operatorSecret: this.opts.operatorSecret };
  }

  get requester(): NightcastPrivateState {
    return { requesterSecret: this.opts.requesterSecret ?? new Uint8Array(32).fill(7) };
  }

  readonly anyone: NightcastPrivateState = {};

  advance(seconds: number): void {
    this.now += seconds;
  }

  /** The contract's public state, as the chain would hold it. */
  publicState(): ChargedState {
    const s = this.state as ContractState;
    return 'data' in s ? s.data : (this.state as ChargedState);
  }

  getLedger(): Ledger {
    return ledger(this.publicState());
  }

  /** The id `request(tag, seed)` will produce for a given requester secret. */
  idFor(tag: Uint8Array, seed: Uint8Array, requesterSecret = this.requester.requesterSecret!): Uint8Array {
    return pureCircuits.requestId(
      { bytes: this.addressBytes },
      pureCircuits.requesterCommitmentOf(requesterSecret),
      tag,
      seed,
    );
  }

  private run<R>(privateState: NightcastPrivateState, call: (ctx: CircuitContext<NightcastPrivateState>) => Result<R>): R {
    const ctx = createCircuitContext<NightcastPrivateState>(
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

  request(tag: Uint8Array, seed: Uint8Array, deadline: bigint, as: NightcastPrivateState = this.requester): Uint8Array {
    return this.run(as, (ctx) => this.contract.impureCircuits.request(ctx, tag, seed, deadline));
  }

  fulfil(id: Uint8Array, as: NightcastPrivateState = this.oracle): Uint8Array {
    return this.run(as, (ctx) => this.contract.impureCircuits.fulfil(ctx, id));
  }

  expire(id: Uint8Array, as: NightcastPrivateState = this.anyone): void {
    this.run(as, (ctx) => this.contract.impureCircuits.expire(ctx, id));
  }

  acceptOracleKey(as: NightcastPrivateState = this.oracle): void {
    this.run(as, (ctx) => this.contract.impureCircuits.acceptOracleKey(ctx));
  }

  proposeOracleKey(key: JubjubPoint, as: NightcastPrivateState = this.operator): void {
    this.run(as, (ctx) => this.contract.impureCircuits.proposeOracleKey(ctx, key));
  }

  proposeOperator(commitment: Uint8Array, as: NightcastPrivateState = this.operator): void {
    this.run(as, (ctx) => this.contract.impureCircuits.proposeOperator(ctx, commitment));
  }

  acceptOperator(as: NightcastPrivateState): void {
    this.run(as, (ctx) => this.contract.impureCircuits.acceptOperator(ctx));
  }
}
