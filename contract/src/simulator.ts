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
  /** What each request pays the oracle, in NIGHT atoms (default 0). */
  requestFee?: bigint;
  /** How much of the oracle's bond each request sets aside, in NIGHT atoms (default 0). */
  collateralPerRequest?: bigint;
  /** The oracle's payout address (default 32 bytes of 0x0a). */
  oraclePayout?: Uint8Array;
  /** The requesters' default refund address (default 32 bytes of 0x0b). */
  refundTo?: Uint8Array;
  /** Called with every successful call's proof data (to check it against the circuit's zkir in tests). */
  onProof?: (circuit: string, proofData: unknown) => void;
};

/** NIGHT moving in or out of the contract in one call: `to` is the recipient's 32 bytes (hex), or "contract" for a payment in. */
export type Transfer = { circuit: string; to: string; amount: bigint };

type Result<R> = { result: R; context: CircuitContext<NightcastPrivateState> };

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * The NIGHT a call moved, from its effects: what it received
 * (`unshieldedInputs`, to "contract") and what it sent to whom
 * (`claimedUnshieldedSpends`, keyed by token and recipient).
 */
const transfersOf = (circuit: string, context: unknown): Transfer[] => {
  const effects = (context as { currentQueryContext?: { effects?: Record<string, unknown> } }).currentQueryContext?.effects;
  if (!effects) return [];
  const out: Transfer[] = [];
  const entries = (m: unknown): [unknown, bigint][] => (m instanceof Map ? [...m.entries()] : m ? Object.entries(m as Record<string, bigint>) : []);
  for (const [, amount] of entries(effects.unshieldedInputs)) out.push({ circuit, to: 'contract', amount: BigInt(amount) });
  for (const [key, amount] of entries(effects.claimedUnshieldedSpends)) {
    // (token type, recipient): the recipient is the last 32-byte value in the key
    const found: string[] = [];
    const walk = (x: unknown): void => {
      if (x instanceof Uint8Array) {
        if (x.length === 32) found.push(toHex(x));
      } else if (typeof x === 'string') {
        if (/^[0-9a-f]{64}$/i.test(x)) found.push(x.toLowerCase());
      } else if (Array.isArray(x)) x.forEach(walk);
      else if (x !== null && typeof x === 'object') Object.values(x as Record<string, unknown>).forEach(walk);
    };
    walk(key);
    out.push({ circuit, to: found[found.length - 1] ?? 'unknown', amount: BigInt(amount) });
  }
  return out;
};

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
      opts.requestFee ?? 0n,
      opts.collateralPerRequest ?? 0n,
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

  /** Every NIGHT payment in and out of the contract so far, from each call's effects. */
  readonly transfers: Transfer[] = [];

  /** Total paid out to an address (32 bytes) so far. */
  paidTo(address: Uint8Array): bigint {
    const h = Buffer.from(address).toString('hex');
    return this.transfers.filter((t) => t.to === h).reduce((a, t) => a + t.amount, 0n);
  }

  /** NIGHT the contract holds: everything paid in, less everything paid out. */
  balance(): bigint {
    return this.transfers.reduce((a, t) => (t.to === 'contract' ? a + t.amount : a - t.amount), 0n);
  }

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
    this.transfers.push(...transfersOf(String(this.lastCircuit), out.context));
    this.opts.onProof?.(this.lastCircuit, (out as { proofData?: unknown }).proofData);
    return out.result;
  }

  private lastCircuit = '';
  private named<R>(name: string, privateState: NightcastPrivateState, call: (ctx: CircuitContext<NightcastPrivateState>) => Result<R>): R {
    this.lastCircuit = name;
    return this.run(privateState, call);
  }

  get oraclePayout(): Uint8Array {
    return this.opts.oraclePayout ?? new Uint8Array(32).fill(0x0a);
  }

  get refundTo(): Uint8Array {
    return this.opts.refundTo ?? new Uint8Array(32).fill(0x0b);
  }

  request(tag: Uint8Array, seed: Uint8Array, deadline: bigint, as: NightcastPrivateState = this.requester, refundTo: Uint8Array = this.refundTo): Uint8Array {
    return this.named('request', as, (ctx) => this.contract.impureCircuits.request(ctx, tag, seed, deadline, { bytes: refundTo }));
  }

  fulfil(id: Uint8Array, as: NightcastPrivateState = this.oracle): Uint8Array {
    return this.named('fulfil', as, (ctx) => this.contract.impureCircuits.fulfil(ctx, id));
  }

  expire(id: Uint8Array, as: NightcastPrivateState = this.anyone): void {
    this.named('expire', as, (ctx) => this.contract.impureCircuits.expire(ctx, id));
  }

  /** The oracle activates the proposed key, naming its payout address (default: the simulator's oraclePayout). */
  acceptOracleKey(as: NightcastPrivateState = this.oracle, payout: Uint8Array = this.oraclePayout): void {
    this.named('acceptOracleKey', as, (ctx) => this.contract.impureCircuits.acceptOracleKey(ctx, { bytes: payout }));
  }

  /** Add `slots` slots of collateral to the oracle's bond (slots × collateralPerRequest NIGHT atoms). */
  depositBond(slots: bigint, as: NightcastPrivateState = this.anyone): void {
    this.named('depositBond', as, (ctx) => this.contract.impureCircuits.depositBond(ctx, slots));
  }

  /** The current oracle takes `slots` free slots back to its payout. */
  withdrawBond(slots: bigint, as: NightcastPrivateState = this.oracle): void {
    this.named('withdrawBond', as, (ctx) => this.contract.impureCircuits.withdrawBond(ctx, slots));
  }

  /** Propose a new oracle key; `now` defaults to the simulator's clock. */
  proposeOracleKey(key: JubjubPoint, as: NightcastPrivateState = this.operator, now: bigint = BigInt(this.now)): void {
    this.named('proposeOracleKey', as, (ctx) => this.contract.impureCircuits.proposeOracleKey(ctx, key, now));
  }

  /** The current oracle approves the proposed key (default: whatever is proposed now). */
  approveOracleKey(as: NightcastPrivateState = this.oracle, key?: JubjubPoint): void {
    const k = key ?? (this.getLedger().proposedOracleKey.is_some ? this.getLedger().proposedOracleKey.value : { x: 0n, y: 1n });
    this.named('approveOracleKey', as, (ctx) => this.contract.impureCircuits.approveOracleKey(ctx, k));
  }

  proposeOperator(commitment: Uint8Array, as: NightcastPrivateState = this.operator): void {
    this.named('proposeOperator', as, (ctx) => this.contract.impureCircuits.proposeOperator(ctx, commitment));
  }

  acceptOperator(as: NightcastPrivateState): void {
    this.named('acceptOperator', as, (ctx) => this.contract.impureCircuits.acceptOperator(ctx));
  }
}
