import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outcome, bytes32, participantId } from './helpers/simulator.js';
import { withMarket, withBets, KEYS, IDS, CLOSE, DEADLINE, TIME, T } from './helpers/fixtures.js';
import { MarketStatus } from '../src/managed/dareu/contract/index.js';

const BOND = 1_000_000n;

// ---- propose_resolution ----

test('propose: undisputed proposal records a Resolution and moves market to PROPOSED', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);

  assert.equal(sim.ledger.markets.lookup(marketId).status, MarketStatus.PROPOSED);
  const r = sim.ledger.resolutions.lookup(marketId);
  assert.deepEqual(r.proposer, IDS.oracle);
  assert.equal(r.proposed_outcome, Outcome.YES);
  assert.equal(r.propose_deadline, DEADLINE);
  assert.equal(r.bond, BOND);
  assert.deepEqual(r.disputer, new Uint8Array(32));
});

test('propose: rejected before the market closes', () => {
  const { sim, marketId } = withBets();
  assert.throws(
    () => sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, T.now + 50),
    /Market has not closed/,
  );
});

test('propose: deadline earlier than close + challenge_window rejected', () => {
  const { sim, marketId } = withBets();
  const tooEarly = CLOSE + 100n; // < close + 7200
  assert.throws(
    () => sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, tooEarly, TIME.afterClose),
    /Deadline before minimum challenge window/,
  );
});

test('propose: cannot propose twice (not OPEN)', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  assert.throws(
    () => sim.proposeResolution(KEYS.alice, marketId, Outcome.NO, DEADLINE, TIME.afterClose),
    /Market is not open for proposal/,
  );
});

// ---- finalize_proposal (optimistic, undisputed) ----

test('finalize: undisputed proposal resolves and credits the proposer bond', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.finalizeProposal(KEYS.alice, marketId, TIME.afterDeadline); // permissionless

  const m = sim.ledger.markets.lookup(marketId);
  assert.equal(m.status, MarketStatus.RESOLVED);
  assert.equal(m.outcome, Outcome.YES);
  assert.equal(sim.ledger.bond_credits.lookup(IDS.oracle), BOND);
});

test('finalize: rejected before the challenge window elapses', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  assert.throws(
    () => sim.finalizeProposal(KEYS.alice, marketId, TIME.duringChallenge),
    /Challenge window still open/,
  );
});

test('finalize: refuses to resolve to a side with no winners', () => {
  // Market with only NO bets; proposing YES then finalizing must fail.
  const { sim, marketId } = withMarket();
  sim.placeBet(KEYS.bob, marketId, Outcome.NO, 400n, new Uint8Array(32), bytes32('nb'), TIME.bet);
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  assert.throws(
    () => sim.finalizeProposal(KEYS.alice, marketId, TIME.afterDeadline),
    /Cannot resolve with no winners/,
  );
});

// ---- dispute_resolution ----

test('dispute: counter-bond moves market to DISPUTED', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.disputeResolution(KEYS.carol, marketId, TIME.duringChallenge);

  assert.equal(sim.ledger.markets.lookup(marketId).status, MarketStatus.DISPUTED);
  assert.deepEqual(sim.ledger.resolutions.lookup(marketId).disputer, participantId(KEYS.carol));
});

test('dispute: proposer cannot dispute their own proposal', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  assert.throws(
    () => sim.disputeResolution(KEYS.oracle, marketId, TIME.duringChallenge),
    /Proposer cannot dispute their own resolution/,
  );
});

test('dispute: rejected once the challenge window has closed', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  assert.throws(
    () => sim.disputeResolution(KEYS.carol, marketId, TIME.afterDeadline),
    /Challenge window has closed/,
  );
});

test('dispute: rejected when market is not in PROPOSED state', () => {
  const { sim, marketId } = withBets();
  assert.throws(
    () => sim.disputeResolution(KEYS.carol, marketId, TIME.duringChallenge),
    /Market is not in proposed state/,
  );
});

// ---- vote_dispute (arbiter council) ----

test('vote: non-arbiter rejected', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.disputeResolution(KEYS.carol, marketId, TIME.duringChallenge);
  assert.throws(
    () => sim.voteDispute(KEYS.stranger, marketId, Outcome.YES, TIME.voting),
    /Not an authorized arbiter/,
  );
});

test('vote: disabled arbiter rejected', () => {
  const { sim, marketId } = withBets();
  sim.setArbiter(KEYS.owner, IDS.arbiter1, false, TIME.now);
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.disputeResolution(KEYS.carol, marketId, TIME.duringChallenge);
  assert.throws(
    () => sim.voteDispute(KEYS.arbiter1, marketId, Outcome.YES, TIME.voting),
    /Arbiter is disabled/,
  );
});

test('vote: proposer-side win credits BOTH bonds to the proposer', () => {
  const { sim, marketId } = withBets(); // Alice YES 600, Bob NO 400
  sim.setArbiter(KEYS.owner, IDS.arbiter1, true, TIME.now);
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.disputeResolution(KEYS.carol, marketId, TIME.duringChallenge);
  sim.voteDispute(KEYS.arbiter1, marketId, Outcome.YES, TIME.voting); // threshold == 1 → settles

  const m = sim.ledger.markets.lookup(marketId);
  assert.equal(m.status, MarketStatus.RESOLVED);
  assert.equal(m.outcome, Outcome.YES);
  // proposed YES == winning YES → proposer takes both bonds.
  assert.equal(sim.ledger.bond_credits.lookup(IDS.oracle), 2n * BOND);
  assert.equal(sim.ledger.bond_credits.member(participantId(KEYS.carol)), false);
});

test('vote: disputer-side win credits BOTH bonds to the disputer', () => {
  const { sim, marketId } = withBets();
  sim.setArbiter(KEYS.owner, IDS.arbiter1, true, TIME.now);
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.disputeResolution(KEYS.carol, marketId, TIME.duringChallenge);
  sim.voteDispute(KEYS.arbiter1, marketId, Outcome.NO, TIME.voting); // NO wins

  const m = sim.ledger.markets.lookup(marketId);
  assert.equal(m.outcome, Outcome.NO);
  assert.equal(sim.ledger.bond_credits.lookup(participantId(KEYS.carol)), 2n * BOND);
});

test('vote: a second arbiter cannot vote after the market has settled', () => {
  const { sim, marketId } = withBets();
  sim.setArbiter(KEYS.owner, IDS.arbiter1, true, TIME.now);
  sim.setArbiter(KEYS.owner, IDS.arbiter2, true, TIME.now);
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.disputeResolution(KEYS.carol, marketId, TIME.duringChallenge);
  sim.voteDispute(KEYS.arbiter1, marketId, Outcome.YES, TIME.voting); // settles at threshold 1
  assert.throws(
    () => sim.voteDispute(KEYS.arbiter2, marketId, Outcome.YES, TIME.voting),
    /Market is not disputed/,
  );
});

// ---- cancel_market escape hatch for stuck markets (audit: locked-funds fix) ----
// The emergency path is folded into cancel_market: owner-only, after a grace period,
// for PROPOSED/DISPUTED markets.

test('escape hatch: only the owner can cancel a mid-resolution market', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  assert.throws(
    () => sim.cancelMarket(KEYS.stranger, marketId, TIME.afterGrace),
    /Only owner can cancel a disputed market/,
  );
});

test('escape hatch: a RESOLVED market cannot be cancelled', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.finalizeProposal(KEYS.alice, marketId, TIME.afterDeadline);
  assert.throws(
    () => sim.cancelMarket(KEYS.owner, marketId, TIME.afterGrace),
    /Market cannot be cancelled in its current state/,
  );
});

test('escape hatch: rejected before the grace period elapses', () => {
  const { sim, marketId } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  assert.throws(
    () => sim.cancelMarket(KEYS.owner, marketId, TIME.afterDeadline),
    /Grace period has not elapsed/,
  );
});

test('escape hatch: frees a stuck DISPUTED market and refunds both bonds', () => {
  const { sim, marketId, alicePos } = withBets();
  sim.proposeResolution(KEYS.oracle, marketId, Outcome.YES, DEADLINE, TIME.afterClose);
  sim.disputeResolution(KEYS.carol, marketId, TIME.duringChallenge);

  sim.cancelMarket(KEYS.owner, marketId, TIME.afterGrace);

  assert.equal(sim.ledger.markets.lookup(marketId).status, MarketStatus.CANCELLED);
  // Both posted bonds are credited back (pull payments).
  assert.equal(sim.ledger.bond_credits.lookup(IDS.oracle), BOND);
  assert.equal(sim.ledger.bond_credits.lookup(participantId(KEYS.carol)), BOND);
  // And a bettor can now recover their stake.
  sim.refundCancelledPosition(KEYS.alice, alicePos, { bytes: bytes32('payout') }, TIME.afterGrace);
  assert.equal(sim.ledger.positions.lookup(alicePos).claimed, true);
});
