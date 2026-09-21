// Network-free test harness for the DareU **v3** Compact contract (shielded vault
// + burn-and-mint prediction market). Drives the real compiled circuits from
// src/managed/dareu-v3 through @midnight-ntwrk/compact-runtime — no node / proof
// server / indexer. ZK proving is skipped; the JS execution of each circuit
// (asserts, ledger writes, token EFFECTS, kernel.blockTime* checks) runs directly.
//
// RUN (standalone):
//   node --import tsx --test "tests/v2/**/*.test.ts"
// (from contract/). Requires the compiled artifact src/managed/dareu-v3 — run
//   compact compile src/dareu-v3.compact src/managed/dareu-v3
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
  FundingMode,
  SettlementAction,
  PositionStatus,
  SaleStatus,
} from '../../../src/managed/dareu-v3/contract/index.js';

export { Outcome, FundingMode, SettlementAction, PositionStatus, SaleStatus };
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

/** position_id for (market_id, pos_nonce) — matches the v3 contract. */
export function positionId(marketId: Uint8Array, posNonce: Uint8Array): Uint8Array {
  return pureCircuits.position_id(marketId, posNonce);
}

export function saleId(
  posId: Uint8Array,
  revision: bigint,
  saleNonce: Uint8Array,
): Uint8Array {
  return pureCircuits.sale_id(posId, revision, saleNonce);
}

export function smartDarerFeeBucket(): Uint8Array {
  return pureCircuits.smart_darer_fee_bucket();
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

export class DareuV3Sim {
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
    state: DareuV3Sim['state'],
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
  }): DareuV3Sim {
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
    const sim = new DareuV3Sim(res.currentContractState.data, underlying, domain, addr);
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

  /** Build the smallest stake+fee payment coin accepted by place_bet. */
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

  /** The revisioned claim ticket for a position. */
  ticketFor(posId: Uint8Array, revision: bigint, nonceTag: string | number = 'ticket'): {
    nonce: Uint8Array;
    color: Uint8Array;
    value: bigint;
  } {
    const domain = pureCircuits.position_ticket_domain(posId, revision);
    const colorHex = rawTokenType(domain, this.address);
    return { nonce: bytes32(`tk:${nonceTag}`), color: fromHex(colorHex), value: 1n };
  }

  saleControlTicket(orderId: Uint8Array, nonceTag: string | number = 'sale'): {
    nonce: Uint8Array;
    color: Uint8Array;
    value: bigint;
  } {
    return {
      nonce: bytes32(`ctl:${nonceTag}`),
      color: fromHex(rawTokenType(orderId, this.address)),
      value: 1n,
    };
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
      c.impureCircuits.place_bet(ctx, marketId, side, amount, stakeFee, FundingMode.SHIELDED, coin, payoutPk, posNonce),
    );
  }

  placeBetUnshielded(
    bettor: Uint8Array,
    marketId: Uint8Array,
    side: Outcome,
    amount: bigint,
    payoutPk: { bytes: Uint8Array },
    posNonce: Uint8Array,
    time: number,
    stakeFeeOverride?: bigint,
  ): Uint8Array {
    const stakeFee = stakeFeeOverride ?? this.stakeFee(marketId, amount);
    return this.run(bettor, time, (c, ctx) =>
      c.impureCircuits.place_bet(
        ctx,
        marketId,
        side,
        amount,
        stakeFee,
        FundingMode.UNSHIELDED,
        { nonce: new Uint8Array(32), color: new Uint8Array(32), value: 0n },
        payoutPk,
        posNonce,
      ),
    );
  }

  paySmartDarerSubscription(
    caller: Uint8Array,
    paymentId: Uint8Array,
    darerAddress: { bytes: Uint8Array },
    amount: bigint,
    fee: bigint,
    time: number,
  ): void {
    this.run(caller, time, (c, ctx) =>
      c.impureCircuits.pay_smart_darer_subscription(
        ctx, paymentId, darerAddress, amount, fee,
      ),
    );
  }

  listPosition(
    caller: Uint8Array,
    posId: Uint8Array,
    ticket: { nonce: Uint8Array; color: Uint8Array; value: bigint },
    askPrice: bigint,
    fundingMode: FundingMode,
    sellerPk: { bytes: Uint8Array },
    sellerSalt: Uint8Array,
    saleNonce: Uint8Array,
    expiresAt: bigint,
    time: number,
  ): Uint8Array {
    return this.run(caller, time, (c, ctx) =>
      c.impureCircuits.list_position(
        ctx,
        posId,
        ticket,
        askPrice,
        fundingMode,
        sellerPk,
        sellerSalt,
        saleNonce,
        expiresAt,
      ),
    );
  }

  fillSaleShielded(
    caller: Uint8Array,
    orderId: Uint8Array,
    paymentCoin: { nonce: Uint8Array; color: Uint8Array; value: bigint },
    sellerPk: { bytes: Uint8Array },
    sellerSalt: Uint8Array,
    buyerPk: { bytes: Uint8Array },
    time: number,
  ): void {
    this.run(caller, time, (c, ctx) =>
      c.impureCircuits.fill_sale(
        ctx,
        orderId,
        FundingMode.SHIELDED,
        paymentCoin,
        sellerPk,
        sellerSalt,
        buyerPk,
        bytes32(`seller-payment:${time}`),
      ),
    );
  }

  fillSaleUnshielded(
    caller: Uint8Array,
    orderId: Uint8Array,
    sellerPk: { bytes: Uint8Array },
    sellerSalt: Uint8Array,
    buyerPk: { bytes: Uint8Array },
    time: number,
  ): void {
    this.run(caller, time, (c, ctx) =>
      c.impureCircuits.fill_sale(
        ctx,
        orderId,
        FundingMode.UNSHIELDED,
        { nonce: new Uint8Array(32), color: new Uint8Array(32), value: 0n },
        sellerPk,
        sellerSalt,
        buyerPk,
        bytes32(`seller-payment:${time}`),
      ),
    );
  }

  cancelSale(
    caller: Uint8Array,
    orderId: Uint8Array,
    controlTicket: { nonce: Uint8Array; color: Uint8Array; value: bigint },
    recipientPk: { bytes: Uint8Array },
    time: number,
  ): void {
    this.run(caller, time, (c, ctx) =>
      c.impureCircuits.cancel_sale(
        ctx,
        orderId,
        controlTicket,
        recipientPk,
      ),
    );
  }

  claimSettled(
    caller: Uint8Array,
    betId: Uint8Array,
    payoutPk: { bytes: Uint8Array },
    ticket: { nonce: Uint8Array; color: Uint8Array; value: bigint },
    grossProfit: bigint,
    time: number,
  ): void {
    this.run(caller, time, (c, ctx) =>
      c.impureCircuits.claim_settled(ctx, betId, payoutPk, ticket, grossProfit),
    );
  }

  resolveMarket(caller: Uint8Array, marketId: Uint8Array, result: Outcome, time: number): void {
    this.run(caller, time, (c, ctx) => c.impureCircuits.settle_market_action(ctx, marketId, SettlementAction.RESOLVE, result));
  }

  cancelMarket(caller: Uint8Array, marketId: Uint8Array, time: number): void {
    this.run(caller, time, (c, ctx) => c.impureCircuits.settle_market_action(ctx, marketId, SettlementAction.CANCEL, Outcome.NONE));
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
