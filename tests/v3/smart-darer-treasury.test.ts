import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DareuV3Sim,
  bytes32,
  expectRevert,
  smartDarerFeeBucket,
  userAddress,
} from './helpers/simulator.js';

const owner = bytes32('owner');
const subscriber = bytes32('subscriber');

test('Smart Darer payment pays the creator and accrues its fee in the shared treasury', () => {
  const sim = DareuV3Sim.deploy({ ownerKey: owner });
  const paymentId = bytes32('intent-1');

  sim.paySmartDarerSubscription(subscriber, paymentId, userAddress('darer'), 10_000n, 100n, 1);

  assert.equal(sim.ledger.subscription_payments.member(paymentId), true);
  assert.equal(sim.ledger.market_fees.lookup(smartDarerFeeBucket()), 100n);
  assert.equal(sim.lastEffects.unshieldedInputs.get(sim.underlyingColorHex), 10_100n);
  assert.equal(sim.lastEffects.unshieldedOutputs.get(sim.underlyingColorHex), 10_000n);
});

test('Smart Darer payment rejects replay and an incorrect platform fee', () => {
  const sim = DareuV3Sim.deploy({ ownerKey: owner });
  const paymentId = bytes32('intent-2');
  sim.paySmartDarerSubscription(subscriber, paymentId, userAddress('darer'), 10_000n, 100n, 1);

  expectRevert(
    () => sim.paySmartDarerSubscription(subscriber, paymentId, userAddress('darer'), 10_000n, 100n, 2),
    'already processed',
  );
  expectRevert(
    () => sim.paySmartDarerSubscription(subscriber, bytes32('intent-3'), userAddress('darer'), 10_000n, 99n, 2),
    'too low',
  );
});

test('owner withdraws the Smart Darer fee through the existing treasury circuit', () => {
  const sim = DareuV3Sim.deploy({ ownerKey: owner });
  sim.paySmartDarerSubscription(subscriber, bytes32('intent-4'), userAddress('darer'), 10_000n, 100n, 1);

  sim.withdrawTreasury(owner, smartDarerFeeBucket(), userAddress('treasury'), 2);
  assert.equal(sim.ledger.market_fees.lookup(smartDarerFeeBucket()), 0n);
  assert.equal(sim.lastEffects.unshieldedOutputs.get(sim.underlyingColorHex), 100n);
  expectRevert(
    () => sim.withdrawTreasury(subscriber, smartDarerFeeBucket(), userAddress('attacker'), 3),
    'Only owner',
  );
});
