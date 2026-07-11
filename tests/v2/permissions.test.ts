// Coverage area 1: PERMISSION MATRIX (owner / operator / stranger authority split).
// Persists the ad-hoc runtime probes from the role-split phase as repo tests.
//
// Run: node --import tsx --test "tests/v2/**/*.test.ts"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DareuV2Sim,
  Role,
  bytes32,
  participantId,
  userAddress,
  EMPTY_ID,
  expectRevert,
} from './helpers/simulator.js';

const NOW = 1_900_000_000;
const CLOSE = BigInt(NOW + 86_400);

const ownerKey = bytes32('owner');
const operatorKey = bytes32('operator');
const strangerKey = bytes32('stranger');
const oracleKey = bytes32('oracle');

function deployWithOperator() {
  return DareuV2Sim.deploy({ ownerKey, operatorId: participantId(operatorKey) });
}

test('constructor: zero operator_id defaults operator = owner', () => {
  const sim = DareuV2Sim.deploy({ ownerKey, operatorId: EMPTY_ID });
  assert.deepEqual(sim.ledger.owner, participantId(ownerKey));
  assert.deepEqual(sim.ledger.operator, participantId(ownerKey), 'operator defaults to owner id');
});

test('constructor: explicit operator_id stored distinctly from owner', () => {
  const sim = deployWithOperator();
  assert.deepEqual(sim.ledger.operator, participantId(operatorKey));
  assert.notDeepEqual(sim.ledger.operator, sim.ledger.owner);
});

test('create_market: owner allowed, operator allowed, stranger rejected', () => {
  const sim = deployWithOperator();
  sim.createMarket(ownerKey, bytes32('m-owner'), participantId(oracleKey), CLOSE, NOW);
  sim.createMarket(operatorKey, bytes32('m-op'), participantId(oracleKey), CLOSE, NOW);
  expectRevert(
    () => sim.createMarket(strangerKey, bytes32('m-x'), participantId(oracleKey), CLOSE, NOW),
    'Only owner or operator',
  );
});

test('withdraw_treasury: owner-only — operator cannot reach the treasury', () => {
  const sim = deployWithOperator();
  // Even with no fees, the authorization check fires before the "no fees" check.
  expectRevert(
    () => sim.withdrawTreasury(operatorKey, bytes32('m1'), userAddress('t'), NOW),
    'Only owner',
  );
  expectRevert(
    () => sim.withdrawTreasury(strangerKey, bytes32('m1'), userAddress('t'), NOW),
    'Only owner',
  );
});

test('set_role: owner-only — operator cannot appoint arbiters or self-escalate', () => {
  const sim = deployWithOperator();
  expectRevert(
    () => sim.setRole(operatorKey, Role.OPERATOR, participantId(bytes32('evil')), true, NOW),
    'Only owner',
  );
  expectRevert(
    () => sim.setRole(operatorKey, Role.ARBITER, participantId(bytes32('evil')), true, NOW),
    'Only owner',
  );
  expectRevert(
    () => sim.setRole(strangerKey, Role.ARBITER, participantId(bytes32('x')), true, NOW),
    'Only owner',
  );
});

test('set_role ARBITER: owner enrolls/disables an arbiter; empty rejected', () => {
  const sim = deployWithOperator();
  const arb = participantId(bytes32('arb1'));
  sim.setRole(ownerKey, Role.ARBITER, arb, true, NOW);
  assert.equal(sim.ledger.arbiters.lookup(arb), true);
  sim.setRole(ownerKey, Role.ARBITER, arb, false, NOW);
  assert.equal(sim.ledger.arbiters.lookup(arb), false);
  expectRevert(() => sim.setRole(ownerKey, Role.ARBITER, EMPTY_ID, true, NOW), 'Arbiter cannot be empty');
});

test('set_role OPERATOR: owner rotates the operator; enable-empty rejected', () => {
  const sim = deployWithOperator();
  const newOp = participantId(bytes32('operator2'));
  sim.setRole(ownerKey, Role.OPERATOR, newOp, true, NOW);
  assert.deepEqual(sim.ledger.operator, newOp);
  expectRevert(() => sim.setRole(ownerKey, Role.OPERATOR, EMPTY_ID, true, NOW), 'Operator cannot be empty');
});

test('operator revoke: after set_role(OPERATOR,_,false) the operator sentinel blocks the old key', () => {
  const sim = deployWithOperator();
  // Sanity: operator can create a market first.
  sim.createMarket(operatorKey, bytes32('before'), participantId(oracleKey), CLOSE, NOW);
  // Revoke — participant arg is ignored on revoke; operator becomes the all-zero sentinel.
  sim.setRole(ownerKey, Role.OPERATOR, bytes32('ignored'), false, NOW);
  assert.deepEqual(sim.ledger.operator, EMPTY_ID, 'operator cleared to sentinel');
  // Revoked operator can no longer create markets.
  expectRevert(
    () => sim.createMarket(operatorKey, bytes32('after'), participantId(oracleKey), CLOSE, NOW),
    'Only owner or operator',
  );
  // Owner still can.
  sim.createMarket(ownerKey, bytes32('owner-still'), participantId(oracleKey), CLOSE, NOW);
});

test('cancel_market OPEN mode: owner, operator, and oracle may cancel; stranger cannot', () => {
  // Fresh markets per caller so each starts OPEN.
  for (const caller of [ownerKey, operatorKey, oracleKey]) {
    const sim = deployWithOperator();
    const m = bytes32(`open-${caller[0]}`);
    sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW);
    sim.cancelMarket(caller, m, NOW);
    assert.equal(Number(sim.ledger.markets.lookup(m).status), 4, 'CANCELLED'); // MarketStatus.CANCELLED = 4
  }
  const sim = deployWithOperator();
  const m = bytes32('open-x');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW);
  expectRevert(() => sim.cancelMarket(strangerKey, m, NOW), 'Only owner, operator, or oracle');
});
