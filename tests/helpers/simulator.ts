// Local, network-free test harness for the DareU Compact contract.
//
// It drives the compiled circuits through @midnight-ntwrk/compact-runtime's
// circuit context, so every test runs the REAL circuit logic (asserts, ledger
// writes, token effects, block-time checks) in-process — no node / proof server
// / indexer required. ZK proving is skipped; we exercise the JS execution of the
// circuits, which is exactly where the contract's invariants live.
//
// Identity model: the contract's "msg.sender" is participant_id(local_secret_key()),
// derived from a private witness. The witness closure captures ONE secret key, so we
// build a fresh Contract instance per caller (all sharing the single ledger state).

import {
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  ledger,
  pureCircuits,
  type Ledger,
  type Witnesses,
  Outcome,
} from '../../src/managed/dareu/contract/index.js';

export { Outcome };
export type { Ledger };

// The contract keeps no per-session private state (the key lives in the closure).
type PS = Record<string, never>;
const PRIVATE_STATE: PS = {};
// Coin public key is irrelevant here — auth is by secret-key witness, not coin pk,
// and the contract uses unshielded tokens. A fixed 32-byte (64 hex) value is fine.
const COIN_PK = '0'.repeat(64);

function contractFor(secretKey: Uint8Array): Contract<PS> {
  const witnesses: Witnesses<PS> = {
    local_secret_key: ({ privateState }) => [privateState, secretKey],
  };
  return new Contract<PS>(witnesses);
}

// ---- Deterministic test fixtures -------------------------------------------------

/** A deterministic 32-byte value from a small tag (for keys, ids, nonces). */
export function bytes32(tag: number | string): Uint8Array {
  const out = new Uint8Array(32);
  const s = String(tag);
  for (let i = 0; i < s.length && i < 32; i++) out[i] = s.charCodeAt(i);
  // Spread the tag a bit so different tags differ in more than the first bytes.
  out[31] = typeof tag === 'number' ? (tag & 0xff) : s.length;
  return out;
}

/** A UserAddress payout target (`{ bytes }`) from a small tag. */
export function userAddress(tag: number | string): { bytes: Uint8Array } {
  return { bytes: bytes32(`addr:${tag}`) };
}

/** participant_id for a secret key — same hash the contract uses (no TS re-impl). */
export function participantId(secretKey: Uint8Array): Uint8Array {
  return pureCircuits.participant_id(secretKey);
}

/** position_id for (market_id, bettor_id, nonce) — matches the contract. */
export function positionId(marketId: Uint8Array, bettorId: Uint8Array, nonce: Uint8Array): Uint8Array {
  return pureCircuits.position_id(marketId, bettorId, nonce);
}

export const EMPTY_ID = new Uint8Array(32); // empty_participant() sentinel

// ---- Simulator -------------------------------------------------------------------

export class DareuSim {
  readonly address = sampleContractAddress();
  // The evolving ledger state (ChargedState).
  private state: ReturnType<Contract<PS>['initialState']>['currentContractState']['data'];

  private constructor(state: DareuSim['state']) {
    this.state = state;
  }

  static deploy(args: {
    ownerKey: Uint8Array;
    tokenType: Uint8Array;
    platformBps: bigint;
  }): DareuSim {
    const ctor = createConstructorContext<PS>(PRIVATE_STATE, COIN_PK);
    const res = contractFor(args.ownerKey).initialState(
      ctor,
      args.ownerKey,
      args.tokenType,
      args.platformBps,
    );
    return new DareuSim(res.currentContractState.data);
  }

  /** Current public ledger snapshot. */
  get ledger(): Ledger {
    return ledger(this.state);
  }

  /** Run a circuit as `caller` at unix `time` (seconds), threading state forward. */
  private run<R>(
    caller: Uint8Array,
    time: number,
    fn: (c: Contract<PS>, ctx: CircuitContext<PS>) => CircuitResults<PS, R>,
  ): R {
    const ctx = createCircuitContext<PS>(
      this.address,
      COIN_PK,
      this.state,
      PRIVATE_STATE,
      undefined,
      undefined,
      time,
    );
    const res = fn(contractFor(caller), ctx);
    this.state = res.context.currentQueryContext.state;
    return res.result;
  }

  // ---- circuit wrappers (one per exported circuit used in tests) ----

  setArbiter(owner: Uint8Array, arbiterId: Uint8Array, enabled: boolean, time: number): void {
    this.run(owner, time, (c, ctx) => c.impureCircuits.set_arbiter(ctx, arbiterId, enabled));
  }

  createMarket(
    owner: Uint8Array,
    marketId: Uint8Array,
    metadataHash: Uint8Array,
    oracleId: Uint8Array,
    closeTime: bigint,
    time: number,
    opts?: { challengeWindow?: bigint; platformBps?: bigint; bettingCutoff?: bigint },
  ): void {
    const challengeWindow = opts?.challengeWindow ?? 7200n;
    const platformBps = opts?.platformBps ?? 200n;
    const bettingCutoff = opts?.bettingCutoff ?? 300n;
    this.run(owner, time, (c, ctx) =>
      c.impureCircuits.create_market(
        ctx,
        marketId,
        metadataHash,
        oracleId,
        closeTime,
        challengeWindow,
        platformBps,
        bettingCutoff,
      ),
    );
  }

  placeBet(
    bettor: Uint8Array,
    marketId: Uint8Array,
    side: Outcome,
    amount: bigint,
    nonce: Uint8Array,
    time: number,
  ): Uint8Array {
    return this.run(bettor, time, (c, ctx) =>
      c.impureCircuits.place_bet(ctx, marketId, side, amount, nonce),
    );
  }

  proposeResolution(
    proposer: Uint8Array,
    marketId: Uint8Array,
    result: Outcome,
    deadline: bigint,
    time: number,
  ): void {
    this.run(proposer, time, (c, ctx) =>
      c.impureCircuits.propose_resolution(ctx, marketId, result, deadline),
    );
  }

  disputeResolution(disputer: Uint8Array, marketId: Uint8Array, time: number): void {
    this.run(disputer, time, (c, ctx) => c.impureCircuits.dispute_resolution(ctx, marketId));
  }

  finalizeProposal(caller: Uint8Array, marketId: Uint8Array, time: number): void {
    this.run(caller, time, (c, ctx) => c.impureCircuits.finalize_proposal(ctx, marketId));
  }

  voteDispute(arbiter: Uint8Array, marketId: Uint8Array, result: Outcome, time: number): void {
    this.run(arbiter, time, (c, ctx) => c.impureCircuits.vote_dispute(ctx, marketId, result));
  }

  withdrawCredit(
    caller: Uint8Array,
    payout: { bytes: Uint8Array },
    time: number,
  ): void {
    this.run(caller, time, (c, ctx) =>
      c.impureCircuits.withdraw_credit(ctx, payout),
    );
  }

  // cancel_market now covers both immediate (OPEN) cancellation and the time-gated
  // escape hatch for a stuck PROPOSED/DISPUTED market (owner-only, after grace).
  cancelMarket(caller: Uint8Array, marketId: Uint8Array, time: number): void {
    this.run(caller, time, (c, ctx) => c.impureCircuits.cancel_market(ctx, marketId));
  }

  claimWinnings(
    bettor: Uint8Array,
    betId: Uint8Array,
    payout: { bytes: Uint8Array },
    grossProfit: bigint,
    platformFee: bigint,
    time: number,
  ): void {
    this.run(bettor, time, (c, ctx) =>
      c.impureCircuits.claim_winnings(ctx, betId, payout, grossProfit, platformFee),
    );
  }

  refundCancelledPosition(
    bettor: Uint8Array,
    betId: Uint8Array,
    payout: { bytes: Uint8Array },
    time: number,
  ): void {
    this.run(bettor, time, (c, ctx) =>
      c.impureCircuits.refund_cancelled_position(ctx, betId, payout),
    );
  }

  withdrawTreasury(
    owner: Uint8Array,
    amount: bigint,
    payout: { bytes: Uint8Array },
    time: number,
  ): void {
    this.run(owner, time, (c, ctx) => c.impureCircuits.withdraw_treasury(ctx, amount, payout));
  }
}

// ---- helpers for floor-division values that claim_winnings re-derives ------------

export function floorDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator; // BigInt division truncates toward zero (== floor for non-negatives)
}

/** Compute the exact (grossProfit, platformFee) a winner must pass. */
export function payoutBreakdown(args: {
  amount: bigint;
  winners: bigint;
  losers: bigint;
  platformBps: bigint;
}): { grossProfit: bigint; platformFee: bigint } {
  const grossProfit = floorDiv(args.amount * args.losers, args.winners);
  const platformFee = floorDiv(grossProfit * args.platformBps, 10000n);
  return { grossProfit, platformFee };
}
