import assert from 'node:assert/strict'
import { test } from 'node:test'
import { V3_MARKET_MIRROR_UPDATE_SQL } from '../scripts/keeper/sync-v3-sql.js'
import { PRIORITY_MARKET_EXISTS_SQL } from '../scripts/keeper/publish-v3.js'
import { SettlementAction, Outcome } from '../src/managed/dareu-v3/contract/index.js'

test('V3 keeper settlement actions map resolution and cancellation to distinct values', () => {
  assert.notEqual(SettlementAction.RESOLVE, SettlementAction.CANCEL)
  assert.notEqual(Outcome.YES, Outcome.NONE)
  assert.notEqual(Outcome.NO, Outcome.NONE)
})

test('V3 mirror and priority queries are scoped to the V3 deployment', () => {
  assert.match(V3_MARKET_MIRROR_UPDATE_SQL, /market\.onchain_contract_version = 'v3'/)
  assert.match(V3_MARKET_MIRROR_UPDATE_SQL, /market\.onchain_contract_address = \$6/)
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /onchain_contract_version = 'v3'/)
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /onchain_contract_address = \$1/)
})
