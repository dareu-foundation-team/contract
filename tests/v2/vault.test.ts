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

test('place_bet: wrong-color coin rejected; value must equal stake plus fee', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m1');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW);
  // Wrong color.
  expectRevert(
    () => sim.placeBet(aliceKey, m, Outcome.YES, 100n, sim.coinOfColor(bytes32('x'), 102n, 'w'), zswapPk('alice'), bytes32('pn'), NOW),
    'Bet coin is not sNIGHT',
  );
  // Right color but value != stake + fee.
  expectRevert(
    () => sim.placeBet(aliceKey, m, Outcome.YES, 100n, sim.snightCoin(99n, 'v'), zswapPk('alice'), bytes32('pn2'), NOW),
    'Coin value must equal stake plus fee',
  );
});

test('place_bet: fee is the exact floor of stake times the market rate', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m-fee-bracket');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW, { platformBps: 100n });
  const amount = 10_000n;
  const exactFee = 100n;
  expectRevert(
    () => sim.placeBet(aliceKey, m, Outcome.YES, amount, sim.snightCoin(amount + exactFee - 1n, 'low'), zswapPk('alice'), bytes32('low'), NOW, exactFee - 1n),
    'Stake fee is too low',
  );
  expectRevert(
    () => sim.placeBet(aliceKey, m, Outcome.YES, amount, sim.snightCoin(amount + exactFee + 1n, 'high'), zswapPk('alice'), bytes32('high'), NOW, exactFee + 1n),
    'Stake fee is too high',
  );
  sim.placeBet(aliceKey, m, Outcome.YES, amount, sim.snightCoin(amount + exactFee, 'exact'), zswapPk('alice'), bytes32('exact'), NOW, exactFee);
  assert.equal(sim.ledger.market_fees.lookup(m), exactFee);
  assert.equal(sim.ledger.markets.lookup(m).total_pool, amount, 'only stake enters the pool');
});

test('place_bet: amounts whose rounded-down fee is zero are rejected', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m-tiny');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW, { platformBps: 100n });
  expectRevert(
    () => sim.placeBet(aliceKey, m, Outcome.YES, 99n, sim.snightCoin(99n, 'tiny'), zswapPk('alice'), bytes32('tiny'), NOW, 0n),
    'Bet amount is too small for a nonzero fee',
  );
});

test('place_bet: duplicate pos_nonce rejected (position already exists)', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m1');
  sim.createMarket(ownerKey, m, participantId(oracleKey), CLOSE, NOW);
  const nonce = bytes32('dup');
  sim.placeBet(aliceKey, m, Outcome.YES, 100n, sim.betCoin(m, 100n, 'a'), zswapPk('alice'), nonce, NOW);
  expectRevert(
    () => sim.placeBet(aliceKey, m, Outcome.YES, 100n, sim.betCoin(m, 100n, 'a2'), zswapPk('alice'), nonce, NOW),
    'Position already exists',
  );
});
