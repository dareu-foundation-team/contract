// Coverage area 5: VAULT (deposit / withdraw) + wrong-color coin rejection across
// withdraw / place_bet / bond payments.
//
// Run: node --import tsx --test "tests/v2/**/*.test.ts"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DareuV2Sim,
  Outcome,
  bytes32,
  participantId,
  userAddress,
  zswapPk,
  expectRevert,
} from './helpers/simulator.js';

const NOW = 1_900_000_000;
const CLOSE = BigInt(NOW + 86_400);
const AFTER_CLOSE = NOW + 90_000;
const CHALLENGE = 7200n;
const BOND = 1_000_000n;

const ownerKey = bytes32('owner');
const oracleKey = bytes32('oracle');
const proposerKey = bytes32('proposer');
const aliceKey = bytes32('alice');

test('deposit: pulls exact underlying in and mints exactly that much sNIGHT', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  sim.deposit(aliceKey, 750n, zswapPk('alice'), bytes32('n1'), NOW);
  assert.equal(sim.lastEffects.unshieldedInputs.get(sim.underlyingColorHex), 750n, 'exact underlying received');
  const minted = [...sim.lastEffects.shieldedMints.values()].reduce((a, b) => a + b, 0n);
  assert.equal(minted, 750n, 'exact sNIGHT minted');
});

test('deposit: zero amount rejected', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  expectRevert(() => sim.deposit(aliceKey, 0n, zswapPk('alice'), bytes32('n0'), NOW), 'Deposit amount must be positive');
});

test('withdraw: pays exact underlying out and mints no new sNIGHT (burn-and-pay)', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  sim.withdraw(aliceKey, sim.snightCoin(400n, 'w'), userAddress('alice'), NOW);
  assert.equal(sim.lastEffects.unshieldedOutputs.get(sim.underlyingColorHex), 400n, 'exact underlying paid out');
  // No sNIGHT is minted on withdraw (the input coin is received and burned). The
  // burn itself (receiveShielded + sendImmediateShielded to shieldedBurnAddress) is
  // NOT surfaced in this simulator's effect maps — that the burn actually destroys a
  // real coin must be confirmed on-chain (see tests/v2/README.md limitations).
  assert.equal([...sim.lastEffects.shieldedMints.values()].reduce((a, b) => a + b, 0n), 0n, 'no sNIGHT minted on withdraw');
});

test('withdraw: zero-value coin rejected', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  expectRevert(() => sim.withdraw(aliceKey, sim.snightCoin(0n, 'z'), userAddress('alice'), NOW), 'Withdraw amount must be positive');
});

test('withdraw: wrong-color coin rejected', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  const wrong = sim.coinOfColor(bytes32('not-snight'), 100n, 'w');
  expectRevert(() => sim.withdraw(aliceKey, wrong, userAddress('alice'), NOW), 'Coin is not sNIGHT');
});

test('place_bet: wrong-color coin rejected; value != amount rejected', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m1');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW);
  // Wrong color.
  expectRevert(
    () => sim.placeBet(aliceKey, m, Outcome.YES, 100n, sim.coinOfColor(bytes32('x'), 100n, 'w'), zswapPk('alice'), bytes32('pn'), NOW),
    'Bet coin is not sNIGHT',
  );
  // Right color but value != amount.
  expectRevert(
    () => sim.placeBet(aliceKey, m, Outcome.YES, 100n, sim.snightCoin(99n, 'v'), zswapPk('alice'), bytes32('pn2'), NOW),
    'Coin value must equal amount',
  );
});

test('place_bet: duplicate pos_nonce rejected (position already exists)', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m1');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW);
  const nonce = bytes32('dup');
  sim.placeBet(aliceKey, m, Outcome.YES, 100n, sim.snightCoin(100n, 'a'), zswapPk('alice'), nonce, NOW);
  expectRevert(
    () => sim.placeBet(aliceKey, m, Outcome.YES, 100n, sim.snightCoin(100n, 'a2'), zswapPk('alice'), nonce, NOW),
    'Position already exists',
  );
});

test('bond payment: wrong-color bond coin rejected in propose and dispute', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m1');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW, { challengeWindow: CHALLENGE });
  sim.placeBet(aliceKey, m, Outcome.YES, 100n, sim.snightCoin(100n, 'a'), zswapPk('alice'), bytes32('pa'), NOW);
  sim.placeBet(bytes32('bob'), m, Outcome.NO, 100n, sim.snightCoin(100n, 'b'), zswapPk('bob'), bytes32('pb'), NOW);
  const deadline = BigInt(AFTER_CLOSE) + CHALLENGE;
  // propose with wrong-color bond.
  expectRevert(
    () => sim.proposeResolution(proposerKey, m, Outcome.YES, deadline, sim.coinOfColor(bytes32('x'), BOND, 'p'), zswapPk('proposer'), AFTER_CLOSE),
    'Bond coin is not sNIGHT',
  );
  // Now propose correctly, then dispute with wrong-color counter-bond.
  sim.proposeResolution(proposerKey, m, Outcome.YES, deadline, sim.snightCoin(BOND, 'p'), zswapPk('proposer'), AFTER_CLOSE);
  expectRevert(
    () => sim.disputeResolution(bytes32('disputer'), m, sim.coinOfColor(bytes32('y'), BOND, 'd'), zswapPk('disputer'), AFTER_CLOSE + 1),
    'Bond coin is not sNIGHT',
  );
});
