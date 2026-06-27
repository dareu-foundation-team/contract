import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DareuSim, bytes32, EMPTY_ID } from './helpers/simulator.js';
import { deploy, KEYS, IDS, TOKEN, TIME } from './helpers/fixtures.js';

test('constructor: rejects fee rates summing over 100%', () => {
  assert.throws(
    () =>
      DareuSim.deploy({ ownerKey: KEYS.owner, tokenType: TOKEN, leaderBps: 6000n, platformBps: 5000n }),
    /Fee rates cannot exceed 100%/,
  );
});

test('constructor: accepts fee rates summing to exactly 100%', () => {
  const sim = DareuSim.deploy({
    ownerKey: KEYS.owner,
    tokenType: TOKEN,
    leaderBps: 4000n,
    platformBps: 6000n,
  });
  assert.equal(sim.ledger.leader_commission_rate, 4000n);
  assert.equal(sim.ledger.platform_fee_rate, 6000n);
});

test('set_arbiter: owner enrolls then disables an arbiter', () => {
  const sim = deploy();
  sim.setArbiter(KEYS.owner, IDS.arbiter1, true, TIME.now);
  assert.equal(sim.ledger.arbiters.member(IDS.arbiter1), true);
  assert.equal(sim.ledger.arbiters.lookup(IDS.arbiter1), true);

  sim.setArbiter(KEYS.owner, IDS.arbiter1, false, TIME.now);
  assert.equal(sim.ledger.arbiters.lookup(IDS.arbiter1), false);
});

test('set_arbiter: only owner', () => {
  const sim = deploy();
  assert.throws(
    () => sim.setArbiter(KEYS.stranger, IDS.arbiter1, true, TIME.now),
    /Only owner can call this circuit/,
  );
});

test('set_arbiter: rejects the empty participant', () => {
  const sim = deploy();
  assert.throws(() => sim.setArbiter(KEYS.owner, EMPTY_ID, true, TIME.now), /Arbiter cannot be empty/);
});
