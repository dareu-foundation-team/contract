// Coverage areas 2 & 3: TICKET-GATED CLAIM (three gates) and FLOOR-BRACKET MATH.
//
// Run: node --import tsx --test "tests/v2/**/*.test.ts"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DareuV2Sim,
  Outcome,
  bytes32,
  participantId,
  zswapPk,
  payoutBreakdown,
  expectRevert,
} from './helpers/simulator.js';

const NOW = 1_900_000_000;
const CLOSE = BigInt(NOW + 86_400);
const AFTER_CLOSE = NOW + 90_000;
const CHALLENGE = 7200n;

const ownerKey = bytes32('owner');
const oracleKey = bytes32('oracle');
const proposerKey = bytes32('proposer');
const aliceKey = bytes32('alice');
const bobKey = bytes32('bob');

/**
 * Set up a market with two bets (YES from alice, NO from bob), close it, and
 * resolve it to `outcome` via propose+finalize. Returns the market id, the two
 * position ids, and the pool sizes. platformBps defaults to 200 (2%).
 */
function resolvedTwoSided(opts?: {
  yesAmount?: bigint;
  noAmount?: bigint;
  outcome?: Outcome;
  platformBps?: bigint;
}) {
  const yesAmount = opts?.yesAmount ?? 100n;
  const noAmount = opts?.noAmount ?? 100n;
  const outcome = opts?.outcome ?? Outcome.YES;
  const platformBps = opts?.platformBps ?? 200n;

  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m1');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW, {
    challengeWindow: CHALLENGE,
    platformBps,
  });
  const aliceNonce = bytes32('pn-alice');
  const bobNonce = bytes32('pn-bob');
  const alicePos = sim.placeBet(aliceKey, m, Outcome.YES, yesAmount, sim.betCoin(m, yesAmount, 'a'), zswapPk('alice'), aliceNonce, NOW);
  const bobPos = sim.placeBet(bobKey, m, Outcome.NO, noAmount, sim.betCoin(m, noAmount, 'b'), zswapPk('bob'), bobNonce, NOW);

  // Resolve via optimistic oracle: propose `outcome`, finalize after deadline.
  const deadline = BigInt(AFTER_CLOSE) + CHALLENGE;
  sim.proposeResolution(proposerKey, m, outcome, deadline, sim.snightCoin(1_000_000n, 'bond'), zswapPk('proposer'), AFTER_CLOSE);
  sim.finalizeProposal(ownerKey, m, Number(deadline) + 1);

  return { sim, m, alicePos, bobPos, yesAmount, noAmount, platformBps };
}

// ---- Gate 1: ticket color / value -------------------------------------------------

test('claim gate1: wrong-color ticket rejected', () => {
  const { sim, m, alicePos, yesAmount, noAmount, platformBps } = resolvedTwoSided();
  const b = payoutBreakdown({ amount: yesAmount, winners: yesAmount, losers: noAmount, platformBps });
  // A ticket of an unrelated color (e.g. the sNIGHT color, not the pos ticket color).
  const wrongTicket = sim.coinOfColor(sim.snightColor, 1n, 'wrong');
  expectRevert(
    () => sim.claimSettled(aliceKey, alicePos, zswapPk('alice'), wrongTicket, b.grossProfit, b.platformFee, NOW),
    'Ticket color mismatch',
  );
});

test('claim gate1: ticket value != 1 rejected', () => {
  const { sim, m, alicePos, yesAmount, noAmount, platformBps } = resolvedTwoSided();
  const b = payoutBreakdown({ amount: yesAmount, winners: yesAmount, losers: noAmount, platformBps });
  const fatTicket = sim.ticketFor(alicePos);
  fatTicket.value = 2n;
  expectRevert(
    () => sim.claimSettled(aliceKey, alicePos, zswapPk('alice'), fatTicket, b.grossProfit, b.platformFee, NOW),
    'Ticket value must be 1',
  );
});

// ---- Gate 2: payout_pk pre-image --------------------------------------------------

test('claim gate2: wrong payout_pk pre-image rejected', () => {
  const { sim, m, alicePos, yesAmount, noAmount, platformBps } = resolvedTwoSided();
  const b = payoutBreakdown({ amount: yesAmount, winners: yesAmount, losers: noAmount, platformBps });
  // Correct ticket, but a pk that does not match the stored commitment.
  expectRevert(
    () => sim.claimSettled(aliceKey, alicePos, zswapPk('mallory'), sim.ticketFor(alicePos), b.grossProfit, b.platformFee, NOW),
    'Payout key does not match beneficiary commitment',
  );
});

// ---- Happy path + double-claim ----------------------------------------------------

test('claim happy path: correct ticket+pk pays stake+gross; all stake fees already accrued at bet time', () => {
  const { sim, m, alicePos, yesAmount, noAmount, platformBps } = resolvedTwoSided();
  const b = payoutBreakdown({ amount: yesAmount, winners: yesAmount, losers: noAmount, platformBps });
  sim.claimSettled(aliceKey, alicePos, zswapPk('alice'), sim.ticketFor(alicePos), b.grossProfit, b.platformFee, NOW);

  // The payout mint equals the computed payout (plus we burned the value-1 ticket,
  // which is a receive+spend, not a mint). The only mint this call is the payout.
  const mints = [...sim.lastEffects.shieldedMints.values()];
  assert.ok(mints.includes(b.payout), `payout mint ${b.payout} present in ${mints}`);
  // Position marked claimed; both bettors' up-front fees remain in escrow and
  // become earned platform revenue when the market resolves.
  assert.equal(sim.ledger.positions.lookup(alicePos).claimed, true);
  assert.equal(
    sim.ledger.market_fees.lookup(m),
    sim.stakeFee(m, yesAmount) + sim.stakeFee(m, noAmount),
  );
});

test('claim double-claim: second claim on the same position rejected (claimed flag)', () => {
  const { sim, m, alicePos, yesAmount, noAmount, platformBps } = resolvedTwoSided();
  const b = payoutBreakdown({ amount: yesAmount, winners: yesAmount, losers: noAmount, platformBps });
  sim.claimSettled(aliceKey, alicePos, zswapPk('alice'), sim.ticketFor(alicePos), b.grossProfit, b.platformFee, NOW);
  // A fresh ticket of the same pos color (a "second ticket") still cannot re-claim.
  expectRevert(
    () => sim.claimSettled(aliceKey, alicePos, zswapPk('alice'), sim.ticketFor(alicePos, 'again'), b.grossProfit, b.platformFee, NOW),
    'Position already claimed',
  );
});

test('claim losing side: the loser (bob/NO on a YES-resolved market) cannot claim', () => {
  const { sim, m, bobPos, noAmount } = resolvedTwoSided({ outcome: Outcome.YES });
  // Bob backed NO; even with a valid ticket+pk his side lost.
  expectRevert(
    () => sim.claimSettled(bobKey, bobPos, zswapPk('bob'), sim.ticketFor(bobPos), 0n, sim.stakeFee(m, noAmount), NOW),
    'Position is not a winner',
  );
});

test('claim unresolved market: claim before settlement rejected', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m-open');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW);
  const pos = sim.placeBet(aliceKey, m, Outcome.YES, 100n, sim.betCoin(m, 100n, 'a'), zswapPk('alice'), bytes32('pn'), NOW);
  // Market is still OPEN — neither RESOLVED nor CANCELLED.
  expectRevert(
    () => sim.claimSettled(aliceKey, pos, zswapPk('alice'), sim.ticketFor(pos), 0n, 0n, NOW),
    'Market is not settled',
  );
});

// ---- CANCELLED branch -------------------------------------------------------------

test('claim CANCELLED branch: refunds exact stake plus the up-front fee', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m-cancel');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW);
  const pos = sim.placeBet(aliceKey, m, Outcome.YES, 250n, sim.betCoin(m, 250n, 'a'), zswapPk('alice'), bytes32('pn'), NOW);
  const stakeFee = sim.stakeFee(m, 250n);
  sim.cancelMarket(ownerKey, m, NOW); // OPEN -> CANCELLED (owner)

  // Nonzero gross_profit rejected on a cancelled market.
  expectRevert(
    () => sim.claimSettled(aliceKey, pos, zswapPk('alice'), sim.ticketFor(pos), 1n, stakeFee, NOW),
    'No profit on a cancelled market',
  );
  // An incorrect refund fee is rejected by the same floor bracket used at bet time.
  expectRevert(
    () => sim.claimSettled(aliceKey, pos, zswapPk('alice'), sim.ticketFor(pos, 'x'), 0n, stakeFee + 1n, NOW),
    'Stake fee is too high',
  );
  // Cancellation returns the exact original total payment and clears fee escrow.
  sim.claimSettled(aliceKey, pos, zswapPk('alice'), sim.ticketFor(pos, 'ok'), 0n, stakeFee, NOW);
  assert.ok([...sim.lastEffects.shieldedMints.values()].includes(250n + stakeFee), 'refund mint == stake + fee');
  assert.equal(sim.ledger.market_fees.lookup(m), 0n);
  assert.equal(sim.ledger.positions.lookup(pos).claimed, true);
});

// ---- Floor-bracket math (area 3) --------------------------------------------------

test('floor-bracket: off-by-one high gross_profit rejected; exact accepted', () => {
  // Uneven pools force a non-trivial floor. YES=100 (alice), NO=100 (bob), fee 2%.
  const { sim, alicePos, yesAmount, noAmount, platformBps } = resolvedTwoSided({ yesAmount: 100n, noAmount: 55n });
  const b = payoutBreakdown({ amount: yesAmount, winners: yesAmount, losers: noAmount, platformBps });
  // gross = floor(100*55/100) = 55.
  assert.equal(b.grossProfit, 55n);
  expectRevert(
    () => sim.claimSettled(aliceKey, alicePos, zswapPk('alice'), sim.ticketFor(alicePos, 'hi'), b.grossProfit + 1n, b.platformFee, NOW),
    'Profit is too high',
  );
  // Exact accepted.
  sim.claimSettled(aliceKey, alicePos, zswapPk('alice'), sim.ticketFor(alicePos, 'ok'), b.grossProfit, b.platformFee, NOW);
  assert.equal(sim.ledger.positions.lookup(alicePos).claimed, true);
});

test('floor-bracket: off-by-one low gross_profit rejected', () => {
  const { sim, alicePos, yesAmount, noAmount, platformBps } = resolvedTwoSided({ yesAmount: 100n, noAmount: 55n });
  const b = payoutBreakdown({ amount: yesAmount, winners: yesAmount, losers: noAmount, platformBps });
  expectRevert(
    () => sim.claimSettled(aliceKey, alicePos, zswapPk('alice'), sim.ticketFor(alicePos), b.grossProfit - 1n, b.platformFee, NOW),
    'Profit is too low',
  );
});

test('floor-bracket: stake_fee off-by-one high and low both rejected', () => {
  // The fee is based on stake, not profit: floor(100*200/10000)=2.
  const { sim, alicePos, yesAmount, noAmount, platformBps } = resolvedTwoSided({ yesAmount: 100n, noAmount: 155n });
  const b = payoutBreakdown({ amount: yesAmount, winners: yesAmount, losers: noAmount, platformBps });
  assert.equal(b.grossProfit, 155n);
  assert.equal(b.platformFee, 2n);
  expectRevert(
    () => sim.claimSettled(aliceKey, alicePos, zswapPk('alice'), sim.ticketFor(alicePos, 'fhi'), b.grossProfit, b.platformFee + 1n, NOW),
    'Stake fee is too high',
  );
  expectRevert(
    () => sim.claimSettled(aliceKey, alicePos, zswapPk('alice'), sim.ticketFor(alicePos, 'flo'), b.grossProfit, b.platformFee - 1n, NOW),
    'Stake fee is too low',
  );
});

test('floor-bracket: one-sided market (no losers) yields zero profit', () => {
  // Everyone bets YES; market resolves YES. losers(no)=0 so gross_profit=0, fee=0.
  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m-oneside');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW, { challengeWindow: CHALLENGE });
  const pos = sim.placeBet(aliceKey, m, Outcome.YES, 100n, sim.betCoin(m, 100n, 'a'), zswapPk('alice'), bytes32('pn'), NOW);
  const deadline = BigInt(AFTER_CLOSE) + CHALLENGE;
  sim.proposeResolution(proposerKey, m, Outcome.YES, deadline, sim.snightCoin(1_000_000n, 'bond'), zswapPk('proposer'), AFTER_CLOSE);
  sim.finalizeProposal(ownerKey, m, Number(deadline) + 1);
  // gross_profit is 0 but the up-front stake fee remains earned after resolution.
  const stakeFee = sim.stakeFee(m, 100n);
  sim.claimSettled(aliceKey, pos, zswapPk('alice'), sim.ticketFor(pos), 0n, stakeFee, NOW);
  // Payout == stake; the separate fee was already paid at place_bet.
  assert.ok([...sim.lastEffects.shieldedMints.values()].includes(100n));
  const feeBucket = sim.ledger.market_fees.member(m) ? sim.ledger.market_fees.lookup(m) : 0n;
  assert.equal(feeBucket, stakeFee, 'stake fee remains earned for a resolved market');
});
