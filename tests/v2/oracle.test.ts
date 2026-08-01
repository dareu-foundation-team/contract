import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DareuV2Sim,
  Outcome,
  bytes32,
  participantId,
  zswapPk,
  expectRevert,
} from './helpers/simulator.js'

const NOW = 1_900_000_000
const CLOSE = BigInt(NOW + 86_400)
const AFTER_CLOSE = NOW + 90_000
const ownerKey = bytes32('owner')
const operatorKey = bytes32('operator')
const oracleKey = bytes32('oracle')
const aliceKey = bytes32('alice')
const bobKey = bytes32('bob')

function twoSidedClosed() {
  const sim = DareuV2Sim.deploy({
    ownerKey,
    operatorId: participantId(operatorKey),
  })
  const market = bytes32('market')
  sim.createMarket(ownerKey, market, participantId(oracleKey), CLOSE, NOW)
  sim.placeBet(aliceKey, market, Outcome.YES, 100n, sim.betCoin(market, 100n, 'a'), zswapPk('alice'), bytes32('pn-a'), NOW)
  sim.placeBet(bobKey, market, Outcome.NO, 100n, sim.betCoin(market, 100n, 'b'), zswapPk('bob'), bytes32('pn-b'), NOW)
  return { sim, market }
}

test('direct resolution moves OPEN to RESOLVED in one authorized call', () => {
  const { sim, market } = twoSidedClosed()
  sim.resolveMarket(oracleKey, market, Outcome.YES, AFTER_CLOSE)
  const resolved = sim.ledger.markets.lookup(market)
  assert.equal(Number(resolved.status), 1)
  assert.equal(Number(resolved.outcome), Number(Outcome.YES))
})

test('resolution rejects NONE and cannot be replayed', () => {
  const { sim, market } = twoSidedClosed()
  expectRevert(
    () => sim.resolveMarket(oracleKey, market, Outcome.NONE, AFTER_CLOSE),
    'Outcome must be YES or NO',
  )
  sim.resolveMarket(operatorKey, market, Outcome.NO, AFTER_CLOSE)
  expectRevert(
    () => sim.resolveMarket(ownerKey, market, Outcome.YES, AFTER_CLOSE + 1),
    'Market is not open',
  )
})

test('resolution rejects an outcome with no winning stake', () => {
  const sim = DareuV2Sim.deploy({
    ownerKey,
    operatorId: participantId(operatorKey),
  })
  const market = bytes32('no-winners')
  sim.createMarket(ownerKey, market, participantId(oracleKey), CLOSE, NOW)
  sim.placeBet(bobKey, market, Outcome.NO, 100n, sim.betCoin(market, 100n, 'b'), zswapPk('bob'), bytes32('pn-b'), NOW)
  expectRevert(
    () => sim.resolveMarket(oracleKey, market, Outcome.YES, AFTER_CLOSE),
    'Cannot resolve with no winners',
  )
})

test('cancelled market cannot later be resolved', () => {
  const { sim, market } = twoSidedClosed()
  sim.cancelMarket(operatorKey, market, AFTER_CLOSE)
  expectRevert(
    () => sim.resolveMarket(oracleKey, market, Outcome.YES, AFTER_CLOSE + 1),
    'Market is not open',
  )
})
