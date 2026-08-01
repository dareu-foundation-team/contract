import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DareuV2Sim,
  Outcome,
  bytes32,
  participantId,
  userAddress,
  EMPTY_ID,
  expectRevert,
} from './helpers/simulator.js'

const NOW = 1_900_000_000
const CLOSE = BigInt(NOW + 86_400)
const AFTER_CLOSE = NOW + 90_000
const ownerKey = bytes32('owner')
const operatorKey = bytes32('operator')
const strangerKey = bytes32('stranger')
const oracleKey = bytes32('oracle')

function deploy() {
  return DareuV2Sim.deploy({ ownerKey, operatorId: participantId(operatorKey) })
}

test('constructor requires an explicit non-empty operator', () => {
  expectRevert(
    () => DareuV2Sim.deploy({ ownerKey, operatorId: EMPTY_ID }),
    'Operator cannot be empty',
  )
  assert.deepEqual(deploy().ledger.operator, participantId(operatorKey))
})

test('create_market allows owner/operator and rejects a stranger', () => {
  const sim = deploy()
  sim.createMarket(ownerKey, bytes32('m-owner'), participantId(oracleKey), CLOSE, NOW)
  sim.createMarket(operatorKey, bytes32('m-op'), participantId(oracleKey), CLOSE, NOW)
  expectRevert(
    () => sim.createMarket(strangerKey, bytes32('m-x'), participantId(oracleKey), CLOSE, NOW),
    'Only owner or operator',
  )
})

test('set_operator is owner-only and supports rotation/revocation', () => {
  const sim = deploy()
  const next = participantId(bytes32('operator2'))
  expectRevert(
    () => sim.setOperator(operatorKey, next, true, NOW),
    'Only owner',
  )
  sim.setOperator(ownerKey, next, true, NOW)
  assert.deepEqual(sim.ledger.operator, next)
  expectRevert(
    () => sim.setOperator(ownerKey, EMPTY_ID, true, NOW),
    'Operator cannot be empty',
  )
  sim.setOperator(ownerKey, bytes32('ignored'), false, NOW)
  assert.deepEqual(sim.ledger.operator, EMPTY_ID)
})

test('resolve_market allows owner/operator/market oracle only after close', () => {
  for (const caller of [ownerKey, operatorKey, oracleKey]) {
    const sim = deploy()
    const market = bytes32(`resolve-${caller[0]}`)
    sim.createMarket(ownerKey, market, participantId(oracleKey), CLOSE, NOW)
    sim.placeBet(ownerKey, market, Outcome.YES, 100n, sim.betCoin(market, 100n, 'y'), { bytes: bytes32('pk-y') }, bytes32('n-y'), NOW)
    expectRevert(
      () => sim.resolveMarket(caller, market, Outcome.YES, NOW),
      'Market has not closed',
    )
    sim.resolveMarket(caller, market, Outcome.YES, AFTER_CLOSE)
    assert.equal(Number(sim.ledger.markets.lookup(market).status), 1)
  }

  const sim = deploy()
  const market = bytes32('resolve-stranger')
  sim.createMarket(ownerKey, market, participantId(oracleKey), CLOSE, NOW)
  sim.placeBet(ownerKey, market, Outcome.YES, 100n, sim.betCoin(market, 100n, 'ys'), { bytes: bytes32('pk-ys') }, bytes32('n-ys'), NOW)
  expectRevert(
    () => sim.resolveMarket(strangerKey, market, Outcome.YES, AFTER_CLOSE),
    'Only owner, operator, or market oracle',
  )
})

test('cancel_market allows owner/operator/oracle while OPEN and is terminal', () => {
  for (const caller of [ownerKey, operatorKey, oracleKey]) {
    const sim = deploy()
    const market = bytes32(`cancel-${caller[0]}`)
    sim.createMarket(ownerKey, market, participantId(oracleKey), CLOSE, NOW)
    sim.cancelMarket(caller, market, NOW)
    assert.equal(Number(sim.ledger.markets.lookup(market).status), 2)
    expectRevert(() => sim.cancelMarket(caller, market, NOW), 'Market is not open')
  }
})

test('withdraw_treasury remains owner-only', () => {
  const sim = deploy()
  expectRevert(
    () => sim.withdrawTreasury(operatorKey, bytes32('m1'), userAddress('t'), NOW),
    'Only owner',
  )
})
