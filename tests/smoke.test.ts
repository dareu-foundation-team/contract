import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DareuSim,
  Outcome,
  bytes32,
  participantId,
  positionId,
} from './helpers/simulator.js';

// Comfortable absolute unix times (year ~2030) so block-time checks have margin.
const NOW = 1_900_000_000;
const CLOSE = BigInt(NOW + 86_400); // +1 day

const ownerKey = bytes32('owner');
const oracleKey = bytes32('oracle');
const aliceKey = bytes32('alice');
const TOKEN = bytes32('token');

function fresh() {
  const sim = DareuSim.deploy({ ownerKey, tokenType: TOKEN, platformBps: 200n });
  return sim;
}

test('smoke: deploy initializes config', () => {
  const sim = fresh();
  const l = sim.ledger;
  assert.deepEqual(l.owner, participantId(ownerKey));
  assert.deepEqual(l.payment_token, TOKEN);
  assert.equal(l.platform_fee_rate, 200n);
  assert.equal(l.treasury, 0n);
  assert.equal(l.market_count, 0n);
  assert.equal(l.resolution_bond, 1_000_000n);
  assert.equal(l.arbiter_threshold, 1n);
});

test('smoke: create market + place a bet (exercises blockTime + receiveUnshielded)', () => {
  const sim = fresh();
  const marketId = bytes32('m1');
  sim.createMarket(ownerKey, marketId, bytes32('meta'), participantId(oracleKey), CLOSE, NOW);

  assert.equal(sim.ledger.market_count, 1n);
  assert.ok(sim.ledger.markets.member(marketId));

  // Per-market snapshots are recorded at creation (defaults from the harness).
  const created = sim.ledger.markets.lookup(marketId);
  assert.equal(created.challenge_window, 7200n);
  assert.equal(created.platform_fee_rate, 200n);
  assert.equal(created.betting_cutoff, 300n);

  const nonce = bytes32('n1');
  const posId = sim.placeBet(aliceKey, marketId, Outcome.YES, 500n, nonce, NOW + 10);

  // place_bet returns the position_id, and it must match the pure-circuit derivation.
  assert.deepEqual(posId, positionId(marketId, participantId(aliceKey), nonce));

  const market = sim.ledger.markets.lookup(marketId);
  assert.equal(market.yes_pool, 500n);
  assert.equal(market.no_pool, 0n);
  assert.equal(market.total_pool, 500n);

  const pos = sim.ledger.positions.lookup(posId);
  assert.equal(pos.amount, 500n);
  assert.equal(pos.outcome, Outcome.YES);
  assert.equal(pos.claimed, false);
  assert.deepEqual(pos.bettor, participantId(aliceKey));
});
