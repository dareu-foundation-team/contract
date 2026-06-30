import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outcome, bytes32, EMPTY_ID, participantId, positionId } from './helpers/simulator.js';
import {
  deploy,
  withMarket,
  KEYS,
  IDS,
  CLOSE,
  TIME,
  T,
  BETTING_CUTOFF,
  BETTING_CLOSE,
} from './helpers/fixtures.js';
import { MarketStatus } from '../src/managed/dareu/contract/index.js';

// ---- create_market ----

test('create_market: owner opens a market', () => {
  const { sim, marketId } = withMarket();
  assert.equal(sim.ledger.market_count, 1n);
  const m = sim.ledger.markets.lookup(marketId);
  assert.equal(m.status, MarketStatus.OPEN);
  assert.equal(m.outcome, Outcome.NONE);
  assert.equal(m.yes_pool, 0n);
  assert.equal(m.no_pool, 0n);
  assert.deepEqual(m.creator, IDS.owner);
  assert.deepEqual(m.oracle, IDS.oracle);
  // Per-market snapshots.
  assert.equal(m.challenge_window, 7200n);
  assert.equal(m.platform_fee_rate, 200n);
  assert.equal(m.betting_cutoff, BETTING_CUTOFF);
});

test('create_market: non-owner rejected', () => {
  const sim = deploy();
  assert.throws(
    () => sim.createMarket(KEYS.stranger, bytes32('m'), bytes32('meta'), IDS.oracle, CLOSE, TIME.create),
    /Only owner can call this circuit/,
  );
});

test('create_market: duplicate id rejected', () => {
  const { sim, marketId } = withMarket();
  assert.throws(
    () => sim.createMarket(KEYS.owner, marketId, bytes32('meta'), IDS.oracle, CLOSE, TIME.create),
    /Market already exists/,
  );
});

test('create_market: empty oracle rejected', () => {
  const sim = deploy();
  assert.throws(
    () => sim.createMarket(KEYS.owner, bytes32('m'), bytes32('meta'), EMPTY_ID, CLOSE, TIME.create),
    /Oracle cannot be empty/,
  );
});

test('create_market: close time must be in the future', () => {
  const sim = deploy();
  const past = BigInt(T.now - 1);
  assert.throws(
    () => sim.createMarket(KEYS.owner, bytes32('m'), bytes32('meta'), IDS.oracle, past, TIME.create),
    /Close time must be in the future/,
  );
});

// ---- create_market: betting_cutoff guardrails ----

test('create_market: betting_cutoff below 60s rejected', () => {
  const sim = deploy();
  assert.throws(
    () =>
      sim.createMarket(KEYS.owner, bytes32('m'), bytes32('meta'), IDS.oracle, CLOSE, TIME.create, {
        bettingCutoff: 59n,
      }),
    /Betting cutoff too small/,
  );
});

test('create_market: betting_cutoff above 1800s rejected', () => {
  const sim = deploy();
  assert.throws(
    () =>
      sim.createMarket(KEYS.owner, bytes32('m'), bytes32('meta'), IDS.oracle, CLOSE, TIME.create, {
        bettingCutoff: 1801n,
      }),
    /Betting cutoff too large/,
  );
});

test('create_market: rejects a market that would be born already closed to bets (cutoff >= close - now)', () => {
  const sim = deploy();
  // close only 100s out, but cutoff 300s -> close - cutoff < now -> unbettable at birth.
  const closeSoon = BigInt(T.now + 100);
  assert.throws(
    () =>
      sim.createMarket(KEYS.owner, bytes32('m'), bytes32('meta'), IDS.oracle, closeSoon, TIME.create, {
        bettingCutoff: 300n,
      }),
    /betting already closed at creation/,
  );
});

test('create_market: platform fee rate over cap rejected', () => {
  const sim = deploy();
  assert.throws(
    () =>
      sim.createMarket(KEYS.owner, bytes32('m'), bytes32('meta'), IDS.oracle, CLOSE, TIME.create, {
        platformBps: 501n,
      }),
    /Platform fee rate too high/,
  );
});

test('create_market: challenge window below minimum rejected', () => {
  const sim = deploy();
  assert.throws(
    () =>
      sim.createMarket(KEYS.owner, bytes32('m'), bytes32('meta'), IDS.oracle, CLOSE, TIME.create, {
        challengeWindow: 59n,
      }),
    /Challenge window too small/,
  );
});

// ---- place_bet ----

test('place_bet: two opposing bets accumulate pools', () => {
  const { sim, marketId } = withMarket();
  sim.placeBet(KEYS.alice, marketId, Outcome.YES, 600n, bytes32('na'), TIME.bet);
  sim.placeBet(KEYS.bob, marketId, Outcome.NO, 400n, bytes32('nb'), TIME.bet);

  const m = sim.ledger.markets.lookup(marketId);
  assert.equal(m.yes_pool, 600n);
  assert.equal(m.no_pool, 400n);
  assert.equal(m.total_pool, 1000n);
});

test('place_bet: records position keyed by private position_id + commitment', () => {
  const { sim, marketId } = withMarket();
  const nonce = bytes32('na');
  const pos = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 600n, nonce, TIME.bet);
  assert.deepEqual(pos, positionId(marketId, participantId(KEYS.alice), nonce));

  const p = sim.ledger.positions.lookup(pos);
  assert.deepEqual(p.bettor, IDS.alice);
  assert.equal(p.amount, 600n);
  assert.equal(p.claimed, false);
  // An audit commitment is stored at the same key.
  assert.equal(sim.ledger.commitments.member(pos), true);
});

test('place_bet: rejected on a non-existent market', () => {
  const sim = deploy();
  assert.throws(
    () => sim.placeBet(KEYS.alice, bytes32('nope'), Outcome.YES, 1n, bytes32('na'), TIME.bet),
    /Market does not exist/,
  );
});

// ---- place_bet: betting cutoff boundary (close - betting_cutoff) ----

test('place_bet: succeeds at close - betting_cutoff - 1s', () => {
  const { sim, marketId } = withMarket();
  // BETTING_CLOSE = close - betting_cutoff. blockTimeLessThan is strict, so the last
  // bettable instant is BETTING_CLOSE - 1.
  const pos = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 1n, bytes32('edge'), BETTING_CLOSE - 1);
  assert.ok(sim.ledger.positions.member(pos));
});

test('place_bet: rejected exactly at close - betting_cutoff', () => {
  const { sim, marketId } = withMarket();
  assert.throws(
    () => sim.placeBet(KEYS.alice, marketId, Outcome.YES, 1n, bytes32('na'), BETTING_CLOSE),
    /betting closed/,
  );
});

test('place_bet: rejected after close - betting_cutoff (and after close time)', () => {
  const { sim, marketId } = withMarket();
  assert.throws(
    () => sim.placeBet(KEYS.alice, marketId, Outcome.YES, 1n, bytes32('na'), T.close + 1),
    /betting closed/,
  );
});

test('place_bet: zero amount rejected', () => {
  const { sim, marketId } = withMarket();
  assert.throws(
    () => sim.placeBet(KEYS.alice, marketId, Outcome.YES, 0n, bytes32('na'), TIME.bet),
    /Bet amount must be positive/,
  );
});

test('place_bet: side NONE rejected', () => {
  const { sim, marketId } = withMarket();
  assert.throws(
    () => sim.placeBet(KEYS.alice, marketId, Outcome.NONE, 100n, bytes32('na'), TIME.bet),
    /Outcome must be YES or NO/,
  );
});

test('place_bet: duplicate (market,bettor,nonce) rejected', () => {
  const { sim, marketId } = withMarket();
  const nonce = bytes32('dup');
  sim.placeBet(KEYS.alice, marketId, Outcome.YES, 100n, nonce, TIME.bet);
  assert.throws(
    () => sim.placeBet(KEYS.alice, marketId, Outcome.YES, 100n, nonce, TIME.bet),
    /Position already exists/,
  );
});

test('place_bet: same bettor can hold two positions via distinct nonces', () => {
  const { sim, marketId } = withMarket();
  const p1 = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 100n, bytes32('n1'), TIME.bet);
  const p2 = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 200n, bytes32('n2'), TIME.bet);
  assert.notDeepEqual(p1, p2);
  assert.equal(sim.ledger.markets.lookup(marketId).yes_pool, 300n);
});
