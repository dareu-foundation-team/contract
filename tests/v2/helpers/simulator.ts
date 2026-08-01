// Network-free test harness for the DareU **v2** Compact contract (shielded vault
// + burn-and-mint prediction market). Drives the real compiled circuits from
// src/managed/dareu-v2 through @midnight-ntwrk/compact-runtime — no node / proof
// server / indexer. ZK proving is skipped; the JS execution of each circuit
// (asserts, ledger writes, token EFFECTS, kernel.blockTime* checks) runs directly.
//
// RUN (standalone):
//   node --import tsx --test "tests/v2/**/*.test.ts"
// (from contract/). Requires the compiled artifact src/managed/dareu-v2 — run
//   compact compile src/dareu-v2.compact src/managed/dareu-v2
// first if it is missing or the contract changed.
//
// KEY DIFFERENCE FROM v1: v2 moves value through shielded coins and unshielded
// sends, not a single unshielded escrow. The runtime exposes per-call token
// EFFECTS (shieldedMints / unshieldedInputs / unshieldedOutputs / claimed shielded
// receives+spends); this harness captures them after every call so tests can assert
// exact mint/pay amounts and drive the §8 solvency invariant. See TokenEffects.
//
// WHAT THE SIMULATION FAITHFULLY COVERS: circuit logic, asserts, ledger writes,
// block-time gating, and the DECLARED token effects (how much the circuit says it
// mints / receives / pays, and the coin colors it checks). WHAT IT DOES NOT COVER
// (and must move to the on-chain demo phase): whether a real zswap coin of the
// claimed color/value actually EXISTS and is spendable, wallet balancing, DUST
// fees, and coin-ciphertext delivery. The runtime accepts a fabricated
// ShieldedCoinInfo as input (it records the receive/spend as an effect but does
// not verify prior UTXO existence), so "wrong color rejected" IS testable here but
// "insufficient real balance rejected" is NOT. See tests/v2/README.md.

import {
  type CircuitContext,
  type CircuitResults,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  rawTokenType,
  fromHex,
  toHex,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  ledger,
  pureCircuits,
  type Ledger,
  type Witnesses,
  Outcome,
} from '../../../src/managed/dareu-v2/contract/index.js';

export { Outcome };
export type { Ledger };

type PS = Record<string, never>;
const PRIVATE_STATE: PS = {};
const COIN_PK = '0'.repeat(64);

function contractFor(secretKey: Uint8Array): Contract<PS> {
  const witnesses: Witnesses<PS> = {
    local_secret_key: ({ privateState }) => [privateState, secretKey],
  };
  return new Contract<PS>(witnesses);
}

// ---- Deterministic fixtures ------------------------------------------------------

/** A deterministic 32-byte value from a small tag. */
export function bytes32(tag: number | string): Uint8Array {
  const out = new Uint8Array(32);
  const s = String(tag);
  for (let i = 0; i < s.length && i < 32; i++) out[i] = s.charCodeAt(i);
  out[31] = typeof tag === 'number' ? tag & 0xff : s.length;
  return out;
}

/** A UserAddress payout target (`{ bytes }`). */
export function userAddress(tag: number | string): { bytes: Uint8Array } {
  return { bytes: bytes32(`addr:${tag}`) };
}

/** A ZswapCoinPublicKey (`{ bytes }`) — the payout / recipient wallet key. */
export function zswapPk(tag: number | string): { bytes: Uint8Array } {
  return { bytes: bytes32(`pk:${tag}`) };
}

/** participant_id for a secret key — the same hash the contract uses. */
export function participantId(secretKey: Uint8Array): Uint8Array {
  return pureCircuits.participant_id(secretKey);
}

/** position_id for (market_id, pos_nonce) — matches the v2 contract (2-arg form). */
export function positionId(marketId: Uint8Array, posNonce: Uint8Array): Uint8Array {
  return pureCircuits.position_id(marketId, posNonce);
}

export const EMPTY_ID = new Uint8Array(32); // empty_participant() / empty_pk() sentinel

// ---- Token-effect capture --------------------------------------------------------

/** Normalized per-call token effects extracted from the runtime QueryContext. */
export interface TokenEffects {
  /** color(hex) -> amount minted this call (sNIGHT payouts/refunds AND value-1 tickets). */
  shieldedMints: Map<string, bigint>;
  /** color(hex) -> unshielded amount received by the contract this call (deposit). */
  unshieldedInputs: Map<string, bigint>;
  /** color(hex) -> unshielded amount paid out by the contract this call (withdraw/treasury). */
  unshieldedOutputs: Map<string, bigint>;
  /** count of shielded coins received into the contract this call (bet/bond/ticket/withdraw). */
  shieldedReceiveCount: number;
  /** count of shielded coins spent/burned by the contract this call. */
  shieldedSpendCount: number;
}

function normColorKey(k: unknown): string {
  if (typeof k === 'string') return k;
  // unshielded maps key by { tag, raw }
  const anyk = k as { raw?: string };
  return anyk.raw ?? JSON.stringify(k);
}

function mapValues(m: Map<unknown, bigint> | undefined): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (!m) return out;
  for (const [k, v] of m.entries()) out.set(normColorKey(k), v as bigint);
  return out;
}

function extractEffects(qc: { effects?: Record<string, unknown> }): TokenEffects {
  const e = (qc.effects ?? {}) as Record<string, Map<unknown, bigint> | { size?: number }>;
  return {
    shieldedMints: mapValues(e.shieldedMints as Map<unknown, bigint>),
    unshieldedInputs: mapValues(e.unshieldedInputs as Map<unknown, bigint>),
    unshieldedOutputs: mapValues(e.unshieldedOutputs as Map<unknown, bigint>),
    shieldedReceiveCount: (e.claimedShieldedReceives as { size?: number })?.size ?? 0,
    shieldedSpendCount: (e.claimedShieldedSpends as { size?: number })?.size ?? 0,
  };
}

// ---- Simulator -------------------------------------------------------------------

export class DareuV2Sim {
  readonly address: string = sampleContractAddress();
  readonly underlyingToken: Uint8Array;
  readonly tokenDomain: Uint8Array;
  /** The sNIGHT color the contract derives (tokenType(domain, self)), as raw bytes. */
  readonly snightColor: Uint8Array;
  readonly snightColorHex: string;
  /** Hex color of the underlying (NIGHT) token, as it appears in unshielded effects. */
  readonly underlyingColorHex: string;

  private state: ReturnType<Contract<PS>['initialState']>['currentContractState']['data'];
  /** The token effects captured from the most recent successful call. */
  lastEffects: TokenEffects = {
    shieldedMints: new Map(),
    unshieldedInputs: new Map(),
    unshieldedOutputs: new Map(),
    shieldedReceiveCount: 0,
    shieldedSpendCount: 0,
  };

  private constructor(
    state: DareuV2Sim['state'],
    underlying: Uint8Array,
    domain: Uint8Array,
    addr: string,
  ) {
    this.state = state;
    this.underlyingToken = underlying;
    this.tokenDomain = domain;
    this.snightColorHex = rawTokenType(domain, addr);
    this.snightColor = fromHex(this.snightColorHex);
    // Underlying color as it appears in unshielded effect maps is the raw token type.
    this.underlyingColorHex = toHex(underlying);
    // NOTE: `addr` must equal `this.address`; enforced by constructing after assignment.
  }

  static deploy(args: {
    ownerKey: Uint8Array;
    underlying?: Uint8Array;
    domain?: Uint8Array;
    operatorId?: Uint8Array;
  }): DareuV2Sim {
    const underlying = args.underlying ?? bytes32('night');
    const domain = args.domain ?? bytes32('dareu:snight:v1');
    const addr = sampleContractAddress();
    const ctor = createConstructorContext<PS>(PRIVATE_STATE, COIN_PK);
    const res = contractFor(args.ownerKey).initialState(
      ctor,
      args.ownerKey,
      underlying,
      domain,
      args.operatorId ?? participantId(args.ownerKey),
    );
    const sim = new DareuV2Sim(res.currentContractState.data, underlying, domain, addr);
    // Overwrite the sampled address so it matches the one used for tokenType.
    (sim as { address: string }).address = addr;
    return sim;
  }

  get ledger(): Ledger {
    return ledger(this.state);
  }

  /** Build a fresh sNIGHT coin of a given value (for bets, bonds, withdraws). */
  snightCoin(value: bigint, nonceTag: string | number): {
    nonce: Uint8Array;
    color: Uint8Array;
    value: bigint;
  } {
    return { nonce: bytes32(`coin:${nonceTag}`), color: this.snightColor, value };
  }

  /** Exact fee escrow charged on top of a stake for this market. */
  stakeFee(marketId: Uint8Array, amount: bigint): bigint {
    const market = this.ledger.markets.lookup(marketId);
    return floorDiv(amount * market.platform_fee_rate, 10000n);
  }

  /** Build the exact stake+fee payment coin accepted by place_bet. */
  betCoin(marketId: Uint8Array, amount: bigint, nonceTag: string | number): {
    nonce: Uint8Array;
    color: Uint8Array;
    value: bigint;
  } {
    return this.snightCoin(amount + this.stakeFee(marketId, amount), nonceTag);
  }

  /** Build a coin of an arbitrary (wrong) color for negative tests. */
  coinOfColor(color: Uint8Array, value: bigint, nonceTag: string | number): {
    nonce: Uint8Array;
    color: Uint8Array;
    value: bigint;
  } {
    return { nonce: bytes32(`coin:${nonceTag}`), color, value };
  }

  /** The claim ticket for a position: color == tokenType(pos_id, self), value 1. */
  ticketFor(posId: Uint8Array, nonceTag: string | number = 'ticket'): {
    nonce: Uint8Array;
    color: Uint8Array;
    value: bigint;
  } {
    const colorHex = rawTokenType(posId, this.address);
    return { nonce: bytes32(`tk:${nonceTag}`), color: fromHex(colorHex), value: 1n };
  }

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
    this.lastEffects = extractEffects(res.context.currentQueryContext as never);
    return res.result;
  }

  // ---- Vault ----

  deposit(
    caller: Uint8Array,
    amount: bigint,
    recipientPk: { bytes: Uint8Array },
    mintNonce: Uint8Array,
    time: number,
  ): void {
    this.run(caller, time, (c, ctx) =>
      c.impureCircuits.deposit(ctx, amount, recipientPk, mintNonce),
    );
  }

  withdraw(
    caller: Uint8Array,
    coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
    payoutAddress: { bytes: Uint8Array },
    time: number,
  ): void {
    this.run(caller, time, (c, ctx) => c.impureCircuits.withdraw(ctx, coin, payoutAddress));
  }

  // ---- Market ----

  createMarket(
    caller: Uint8Array,
    marketId: Uint8Array,
    oracleId: Uint8Array,
    closeTime: bigint,
    time: number,
    opts?: {
      metadataHash?: Uint8Array;
      platformBps?: bigint;
      bettingCutoff?: bigint;
    },
  ): void {
    this.run(caller, time, (c, ctx) =>
      c.impureCircuits.create_market(
        ctx,
        marketId,
        opts?.metadataHash ?? bytes32(`meta:${toHex(marketId).slice(0, 6)}`),
        oracleId,
        closeTime,
        opts?.platformBps ?? 200n,
        opts?.bettingCutoff ?? 300n,
      ),
    );
  }

  placeBet(
    bettor: Uint8Array,
    marketId: Uint8Array,
    side: Outcome,
    amount: bigint,
    coin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
    payoutPk: { bytes: Uint8Array },
    posNonce: Uint8Array,
    time: number,
    stakeFeeOverride?: bigint,
  ): Uint8Array {
    const stakeFee = stakeFeeOverride ?? this.stakeFee(marketId, amount);
    return this.run(bettor, time, (c, ctx) =>
      c.impureCircuits.place_bet(ctx, marketId, side, amount, stakeFee, coin, payoutPk, posNonce),
    );
  }

  claimSettled(
    caller: Uint8Array,
    betId: Uint8Array,
    payoutPk: { bytes: Uint8Array },
    ticket: { nonce: Uint8Array; color: Uint8Array; value: bigint },
    grossProfit: bigint,
    platformFee: bigint,
    time: number,
  ): void {
    this.run(caller, time, (c, ctx) =>
      c.impureCircuits.claim_settled(ctx, betId, payoutPk, ticket, grossProfit, platformFee),
    );
  }

  resolveMarket(caller: Uint8Array, marketId: Uint8Array, result: Outcome, time: number): void {
    this.run(caller, time, (c, ctx) => c.impureCircuits.resolve_market(ctx, marketId, result));
  }

  cancelMarket(caller: Uint8Array, marketId: Uint8Array, time: number): void {
    this.run(caller, time, (c, ctx) => c.impureCircuits.cancel_market(ctx, marketId));
  }

  // ---- Admin ----

  setOperator(
    owner: Uint8Array,
    participant: Uint8Array,
    enabled: boolean,
    time: number,
  ): void {
    this.run(owner, time, (c, ctx) => c.impureCircuits.set_operator(ctx, participant, enabled));
  }

  withdrawTreasury(
    owner: Uint8Array,
    marketId: Uint8Array,
    payoutAddress: { bytes: Uint8Array },
    time: number,
  ): void {
    this.run(owner, time, (c, ctx) =>
      c.impureCircuits.withdraw_treasury(ctx, marketId, payoutAddress),
    );
  }
}

// ---- Assertion helper: a circuit call must revert -----------------------------

/** Run `fn`; assert it throws, optionally matching a substring of the assert msg. */
export function expectRevert(fn: () => void, msgIncludes?: string): string {
  let threw = false;
  let message = '';
  try {
    fn();
  } catch (e) {
    threw = true;
    message = (e as Error).message;
  }
  if (!threw) throw new Error(`expected revert${msgIncludes ? ` (${msgIncludes})` : ''} but call succeeded`);
  if (msgIncludes && !message.includes(msgIncludes)) {
    throw new Error(`expected revert containing "${msgIncludes}" but got: ${message.split('\n')[0]}`);
  }
  return message;
}

// ---- Floor-division helpers (the exact values claim_settled re-derives) --------

export function floorDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator; // BigInt division truncates == floor for non-negatives
}

/** Compute the stake fee paid up-front plus the no-further-fee winner payout. */
export function payoutBreakdown(args: {
  amount: bigint;
  winners: bigint;
  losers: bigint;
  platformBps: bigint;
}): { grossProfit: bigint; platformFee: bigint; payout: bigint } {
  const grossProfit = floorDiv(args.amount * args.losers, args.winners);
  const platformFee = floorDiv(args.amount * args.platformBps, 10000n);
  const payout = args.amount + grossProfit;
  return { grossProfit, platformFee, payout };
}
