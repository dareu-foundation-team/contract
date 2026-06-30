import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outcome, bytes32, userAddress, payoutBreakdown, DareuSim } from './helpers/simulator.js';
import {
  withMarket,
  withBets,
  deploy,
  KEYS,
  IDS,
  CLOSE,
  DEADLINE,
  TIME,
  PLATFORM_BPS,
} from './helpers/fixtures.js';
import { MarketStatus } from '../src/managed/dareu/contract/index.js';

const BOND = 1_000_000n;
const PAYOUT = userAddress('p');

// Resolve a YES market via the optimistic (undisputed) path.
function resolvedYes(opts?: { aliceAmount?: bigint; bobAmount?: bigint }) {
  const ctx = withBets(opts);
  ctx.sim.proposeResolution(KEYS.oracle, ctx.marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  ctx.sim.finalizeProposal(KEYS.alice, ctx.marketId, TIME.afterDeadline);
  return ctx;
}

// ---- claim_winnings: the floor-division bracket math (2 proof values) ----

test('claim: sole winner takes the losing pool minus the platform fee', () => {
  const { sim, marketId, alicePos } = resolvedYes(); // Alice YES 600, Bob NO 400
  const b = payoutBreakdown({
    amount: 600n,
    winners: 600n,
    losers: 400n,
    platformBps: PLATFORM_BPS,
  });
  assert.equal(b.grossProfit, 400n);
  assert.equal(b.platformFee, 8n);

  sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, b.grossProfit, b.platformFee, TIME.afterDeadline);

  assert.equal(sim.ledger.positions.lookup(alicePos).claimed, true);
  assert.equal(sim.ledger.treasury, 8n);
  assert.equal(sim.ledger.markets.lookup(marketId).status, MarketStatus.RESOLVED);
});

test('claim: gross_profit one above floor is rejected', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 401n, 8n, TIME.afterDeadline),
    /Profit is too high/,
  );
});

test('claim: gross_profit one below floor is rejected', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 399n, 8n, TIME.afterDeadline),
    /Profit is too low/,
  );
});

test('claim: platform_fee one above floor is rejected', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 9n, TIME.afterDeadline),
    /Platform fee is too high/,
  );
});

test('claim: platform_fee one below floor is rejected', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 7n, TIME.afterDeadline),
    /Platform fee is too low/,
  );
});

test('claim: the fee is computed from the PER-MARKET platform_fee_rate snapshot, not a global', () => {
  // Deploy with the default 2% global, but create a market snapshotting 5% (500 bps).
  const sim = deploy();
  const marketId = bytes32('m-fee');
  sim.createMarket(KEYS.owner, marketId, bytes32('meta'), IDS.oracle, CLOSE, TIME.create, {
    platformBps: 500n,
  });
  assert.equal(sim.ledger.markets.lookup(marketId).platform_fee_rate, 500n);
  const alicePos = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 600n, bytes32('na'), TIME.bet);
  sim.placeBet(KEYS.bob, marketId, Outcome.NO, 400n, bytes32('nb'), TIME.bet);
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.finalizeProposal(KEYS.alice, marketId, TIME.afterDeadline);

  // grossProfit = floor(600*400/600) = 400; fee = floor(400*500/10000) = 20 (not 8).
  const b = payoutBreakdown({ amount: 600n, winners: 600n, losers: 400n, platformBps: 500n });
  assert.equal(b.platformFee, 20n);
  // Passing the OLD 2% fee (8) must now fail: the bracket reads the 5% snapshot.
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, TIME.afterDeadline),
    /Platform fee is too low/,
  );
  sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, b.grossProfit, b.platformFee, TIME.afterDeadline);
  assert.equal(sim.ledger.treasury, 20n);
});

test('claim: a winning position cannot be claimed twice', () => {
  const { sim, alicePos } = resolvedYes();
  sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, TIME.afterDeadline);
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, TIME.afterDeadline),
    /Position already claimed/,
  );
});

test('claim: rejected before the market is resolved', () => {
  const { sim, alicePos } = withBets();
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, TIME.afterDeadline),
    /Market is not resolved/,
  );
});

test('claim: a losing position cannot claim', () => {
  const { sim, bobPos } = resolvedYes(); // resolved YES → Bob (NO) lost
  assert.throws(
    () => sim.claimWinnings(KEYS.bob, bobPos, PAYOUT, 0n, 0n, TIME.afterDeadline),
    /Position is not a winner/,
  );
});

test('claim: only the owning bettor can claim', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.claimWinnings(KEYS.stranger, alicePos, PAYOUT, 400n, 8n, TIME.afterDeadline),
    /Only the bettor can claim this position/,
  );
});

// ---- zero-winner market: must cancel + refund (cannot resolve) ----

test('zero-winner: a market with no stake on the proposed side cannot finalize and is cancelled', () => {
  // Only NO bets exist; proposing YES then finalizing must fail (no winners),
  // so the owner cancels via the escape hatch and the bettor refunds.
  const { sim, marketId } = withMarket();
  const bobPos = sim.placeBet(KEYS.bob, marketId, Outcome.NO, 400n, bytes32('nb'), TIME.bet);
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  assert.throws(
    () => sim.finalizeProposal(KEYS.alice, marketId, TIME.afterDeadline),
    /Cannot resolve with no winners/,
  );
  // Escape hatch: owner cancels the stuck PROPOSED market after grace.
  sim.cancelMarket(KEYS.owner, marketId, TIME.afterGrace);
  assert.equal(sim.ledger.markets.lookup(marketId).status, MarketStatus.CANCELLED);
  sim.refundCancelledPosition(KEYS.bob, bobPos, PAYOUT, TIME.afterGrace);
  assert.equal(sim.ledger.positions.lookup(bobPos).claimed, true);
});

// ---- cancel_market + refund_cancelled_position ----

test('cancel: owner cancels an OPEN market; bettor refunds the exact stake', () => {
  const { sim, marketId } = withMarket();
  const pos = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 250n, bytes32('n'), TIME.bet);
  sim.cancelMarket(KEYS.owner, marketId, TIME.create);
  assert.equal(sim.ledger.markets.lookup(marketId).status, MarketStatus.CANCELLED);

  sim.refundCancelledPosition(KEYS.alice, pos, PAYOUT, TIME.afterClose);
  assert.equal(sim.ledger.positions.lookup(pos).claimed, true);
});

test('cancel: the market oracle may also cancel', () => {
  const { sim, marketId } = withMarket();
  sim.cancelMarket(KEYS.oracle, marketId, TIME.create);
  assert.equal(sim.ledger.markets.lookup(marketId).status, MarketStatus.CANCELLED);
});

test('cancel: a stranger cannot cancel', () => {
  const { sim, marketId } = withMarket();
  assert.throws(() => sim.cancelMarket(KEYS.stranger, marketId, TIME.create), /Only owner or oracle can cancel/);
});

test('cancel: a PROPOSED market cannot be cancelled immediately (only after grace)', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  // Owner tries to cancel right after the proposal — the grace gate blocks it.
  assert.throws(
    () => sim.cancelMarket(KEYS.owner, marketId, TIME.afterClose),
    /Grace period has not elapsed/,
  );
});

test('refund: cannot refund twice', () => {
  const { sim, marketId } = withMarket();
  const pos = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 250n, bytes32('n'), TIME.bet);
  sim.cancelMarket(KEYS.owner, marketId, TIME.create);
  sim.refundCancelledPosition(KEYS.alice, pos, PAYOUT, TIME.afterClose);
  assert.throws(
    () => sim.refundCancelledPosition(KEYS.alice, pos, PAYOUT, TIME.afterClose),
    /Position already claimed/,
  );
});

test('refund: rejected when the market is not cancelled', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.refundCancelledPosition(KEYS.alice, alicePos, PAYOUT, TIME.afterDeadline),
    /Market is not cancelled/,
  );
});

// ---- withdraw_credit (bond-only pull payments) ----

test('withdraw_credit: proposer withdraws their finalized bond', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.finalizeProposal(KEYS.alice, marketId, TIME.afterDeadline);
  assert.equal(sim.ledger.bond_credits.lookup(IDS.oracle), BOND);

  sim.withdrawCredit(KEYS.oracle, PAYOUT, TIME.afterDeadline);
  assert.equal(sim.ledger.bond_credits.lookup(IDS.oracle), 0n);
});

test('withdraw_credit: rejected when there is nothing to withdraw', () => {
  const sim = deploy();
  assert.throws(() => sim.withdrawCredit(KEYS.stranger, PAYOUT, TIME.now), /No credit to withdraw/);
});

// ---- withdraw_treasury ----

test('withdraw_treasury: owner withdraws accrued fees, bounded by balance', () => {
  const { sim, alicePos } = resolvedYes();
  sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, TIME.afterDeadline);
  assert.equal(sim.ledger.treasury, 8n);

  sim.withdrawTreasury(KEYS.owner, 5n, PAYOUT, TIME.afterDeadline);
  assert.equal(sim.ledger.treasury, 3n);
});

test('withdraw_treasury: amount must be positive', () => {
  const sim = deploy();
  assert.throws(() => sim.withdrawTreasury(KEYS.owner, 0n, PAYOUT, TIME.now), /Amount must be positive/);
});

test('withdraw_treasury: cannot exceed the treasury balance', () => {
  const { sim, alicePos } = resolvedYes();
  sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, TIME.afterDeadline);
  assert.throws(
    () => sim.withdrawTreasury(KEYS.owner, 9n, PAYOUT, TIME.afterDeadline),
    /Insufficient treasury/,
  );
});

test('withdraw_treasury: only owner', () => {
  const sim = deploy();
  assert.throws(() => sim.withdrawTreasury(KEYS.stranger, 1n, PAYOUT, TIME.now), /Only owner can call this circuit/);
  void DareuSim;
  void CLOSE;
});
