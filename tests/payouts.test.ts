import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outcome, bytes32, userAddress, participantId, payoutBreakdown, DareuSim } from './helpers/simulator.js';
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
  LEADER_BPS,
} from './helpers/fixtures.js';
import { MarketStatus } from '../src/managed/dareu/contract/index.js';

const BOND = 1_000_000n;
const PAYOUT = userAddress('p');

// Resolve a YES market via the optimistic (undisputed) path.
function resolvedYes(opts?: { aliceLeader?: Uint8Array; aliceAmount?: bigint; bobAmount?: bigint }) {
  const ctx = withBets(opts);
  ctx.sim.proposeResolution(KEYS.oracle, ctx.marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  ctx.sim.finalizeProposal(KEYS.alice, ctx.marketId, TIME.afterDeadline);
  return ctx;
}

// ---- claim_winnings: the floor-division bracket math ----

test('claim: sole winner takes the losing pool minus the platform fee', () => {
  const { sim, marketId, alicePos } = resolvedYes(); // Alice YES 600, Bob NO 400
  const b = payoutBreakdown({
    amount: 600n,
    winners: 600n,
    losers: 400n,
    platformBps: PLATFORM_BPS,
    leaderBps: LEADER_BPS,
    hasLeader: false,
  });
  assert.equal(b.grossProfit, 400n);
  assert.equal(b.platformFee, 8n);
  assert.equal(b.leaderFee, 0n);

  sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, b.grossProfit, b.platformFee, b.leaderFee, TIME.afterDeadline);

  assert.equal(sim.ledger.positions.lookup(alicePos).claimed, true);
  assert.equal(sim.ledger.treasury, 8n);
  assert.equal(sim.ledger.markets.lookup(marketId).status, MarketStatus.RESOLVED);
  void marketId;
});

test('claim: gross_profit one above floor is rejected', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 401n, 8n, 0n, TIME.afterDeadline),
    /Profit is too high/,
  );
});

test('claim: gross_profit one below floor is rejected', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 399n, 8n, 0n, TIME.afterDeadline),
    /Profit is too low/,
  );
});

test('claim: platform_fee one above floor is rejected', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 9n, 0n, TIME.afterDeadline),
    /Platform fee is too high/,
  );
});

test('claim: platform_fee one below floor is rejected', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 7n, 0n, TIME.afterDeadline),
    /Platform fee is too low/,
  );
});

test('claim: leader_fee must be zero when the position named no leader', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, 1n, TIME.afterDeadline),
    /Leader fee must be zero without a leader/,
  );
});

test('claim: with a copy-trading leader, the commission accrues to the leader', () => {
  const { sim, alicePos } = resolvedYes({ aliceLeader: IDS.leader });
  const b = payoutBreakdown({
    amount: 600n,
    winners: 600n,
    losers: 400n,
    platformBps: PLATFORM_BPS,
    leaderBps: LEADER_BPS,
    hasLeader: true,
  });
  assert.equal(b.leaderFee, 40n); // floor(400 * 1000 / 10000)

  sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, b.grossProfit, b.platformFee, b.leaderFee, TIME.afterDeadline);

  assert.equal(sim.ledger.leader_rewards.lookup(IDS.leader), 40n);
  assert.equal(sim.ledger.treasury, 8n);
});

test('claim: a winning position cannot be claimed twice', () => {
  const { sim, alicePos } = resolvedYes();
  sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, 0n, TIME.afterDeadline);
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, 0n, TIME.afterDeadline),
    /Position already claimed/,
  );
});

test('claim: rejected before the market is resolved', () => {
  const { sim, marketId, alicePos } = withBets();
  void marketId;
  assert.throws(
    () => sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, 0n, TIME.afterDeadline),
    /Market is not resolved/,
  );
});

test('claim: a losing position cannot claim', () => {
  const { sim, bobPos } = resolvedYes(); // resolved YES → Bob (NO) lost
  assert.throws(
    () => sim.claimWinnings(KEYS.bob, bobPos, PAYOUT, 0n, 0n, 0n, TIME.afterDeadline),
    /Position is not a winner/,
  );
});

test('claim: only the owning bettor can claim', () => {
  const { sim, alicePos } = resolvedYes();
  assert.throws(
    () => sim.claimWinnings(KEYS.stranger, alicePos, PAYOUT, 400n, 8n, 0n, TIME.afterDeadline),
    /Only the bettor can claim this position/,
  );
});

// ---- cancel_market + refund_cancelled_position ----

test('cancel: owner cancels an OPEN market; bettor refunds the exact stake', () => {
  const { sim, marketId } = withMarket();
  const pos = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 250n, new Uint8Array(32), bytes32('n'), TIME.bet);
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
  const pos = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 250n, new Uint8Array(32), bytes32('n'), TIME.bet);
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

// ---- withdraw_credit (pull payments) ----

test('withdraw_credit: proposer withdraws their finalized bond', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.finalizeProposal(KEYS.alice, marketId, TIME.afterDeadline);
  assert.equal(sim.ledger.bond_credits.lookup(IDS.oracle), BOND);

  sim.withdrawCredit(KEYS.oracle, false, PAYOUT, TIME.afterDeadline);
  assert.equal(sim.ledger.bond_credits.lookup(IDS.oracle), 0n);
});

test('withdraw_credit: leader withdraws accrued commission', () => {
  const { sim, alicePos } = resolvedYes({ aliceLeader: IDS.leader });
  sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, 40n, TIME.afterDeadline);
  assert.equal(sim.ledger.leader_rewards.lookup(IDS.leader), 40n);

  sim.withdrawCredit(KEYS.leader, true, PAYOUT, TIME.afterDeadline);
  assert.equal(sim.ledger.leader_rewards.lookup(IDS.leader), 0n);
});

test('withdraw_credit: rejected when there is nothing to withdraw', () => {
  const sim = deploy();
  assert.throws(() => sim.withdrawCredit(KEYS.stranger, false, PAYOUT, TIME.now), /No credit to withdraw/);
});

// ---- withdraw_treasury ----

test('withdraw_treasury: owner withdraws accrued fees, bounded by balance', () => {
  const { sim, alicePos } = resolvedYes();
  sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, 0n, TIME.afterDeadline);
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
  sim.claimWinnings(KEYS.alice, alicePos, PAYOUT, 400n, 8n, 0n, TIME.afterDeadline);
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
  void participantId;
});
