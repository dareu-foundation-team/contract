import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outcome, bytes32, EMPTY_ID, participantId, positionId } from './helpers/simulator.js';
import { deploy, withMarket, KEYS, IDS, CLOSE, TIME, T } from './helpers/fixtures.js';
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

// ---- place_bet ----

test('place_bet: two opposing bets accumulate pools', () => {
  const { sim, marketId } = withMarket();
  sim.placeBet(KEYS.alice, marketId, Outcome.YES, 600n, new Uint8Array(32), bytes32('na'), TIME.bet);
  sim.placeBet(KEYS.bob, marketId, Outcome.NO, 400n, new Uint8Array(32), bytes32('nb'), TIME.bet);

  const m = sim.ledger.markets.lookup(marketId);
  assert.equal(m.yes_pool, 600n);
  assert.equal(m.no_pool, 400n);
  assert.equal(m.total_pool, 1000n);
});

test('place_bet: records position keyed by private position_id + commitment', () => {
  const { sim, marketId } = withMarket();
  const nonce = bytes32('na');
  const pos = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 600n, IDS.leader, nonce, TIME.bet);
  assert.deepEqual(pos, positionId(marketId, participantId(KEYS.alice), nonce));

  const p = sim.ledger.positions.lookup(pos);
  assert.deepEqual(p.bettor, IDS.alice);
  assert.deepEqual(p.leader, IDS.leader);
  assert.equal(p.amount, 600n);
  assert.equal(p.claimed, false);
  // An audit commitment is stored at the same key.
  assert.equal(sim.ledger.commitments.member(pos), true);
});

test('place_bet: rejected on a non-existent market', () => {
  const sim = deploy();
  assert.throws(
    () => sim.placeBet(KEYS.alice, bytes32('nope'), Outcome.YES, 1n, new Uint8Array(32), bytes32('na'), TIME.bet),
    /Market does not exist/,
  );
});

test('place_bet: rejected after close time', () => {
  const { sim, marketId } = withMarket();
  assert.throws(
    () => sim.placeBet(KEYS.alice, marketId, Outcome.YES, 1n, new Uint8Array(32), bytes32('na'), T.close + 1),
    /Market is closed/,
  );
});

test('place_bet: zero amount rejected', () => {
  const { sim, marketId } = withMarket();
  assert.throws(
    () => sim.placeBet(KEYS.alice, marketId, Outcome.YES, 0n, new Uint8Array(32), bytes32('na'), TIME.bet),
    /Bet amount must be positive/,
  );
});

test('place_bet: side NONE rejected', () => {
  const { sim, marketId } = withMarket();
  assert.throws(
    () => sim.placeBet(KEYS.alice, marketId, Outcome.NONE, 100n, new Uint8Array(32), bytes32('na'), TIME.bet),
    /Outcome must be YES or NO/,
  );
});

test('place_bet: duplicate (market,bettor,nonce) rejected', () => {
  const { sim, marketId } = withMarket();
  const nonce = bytes32('dup');
  sim.placeBet(KEYS.alice, marketId, Outcome.YES, 100n, new Uint8Array(32), nonce, TIME.bet);
  assert.throws(
    () => sim.placeBet(KEYS.alice, marketId, Outcome.YES, 100n, new Uint8Array(32), nonce, TIME.bet),
    /Position already exists/,
  );
});

test('place_bet: same bettor can hold two positions via distinct nonces', () => {
  const { sim, marketId } = withMarket();
  const p1 = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 100n, new Uint8Array(32), bytes32('n1'), TIME.bet);
  const p2 = sim.placeBet(KEYS.alice, marketId, Outcome.YES, 200n, new Uint8Array(32), bytes32('n2'), TIME.bet);
  assert.notDeepEqual(p1, p2);
  assert.equal(sim.ledger.markets.lookup(marketId).yes_pool, 300n);
});
