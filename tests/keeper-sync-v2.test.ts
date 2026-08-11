import assert from 'node:assert/strict'
import { test } from 'node:test'
import { V2_MARKET_MIRROR_UPDATE_SQL } from '../scripts/keeper/sync-v2-sql.js'

test('V2 mirror refreshes an unchanged market once after close', () => {
  assert.match(V2_MARKET_MIRROR_UPDATE_SQL, /onchain_observed_at = now\(\)/)
  assert.match(V2_MARKET_MIRROR_UPDATE_SQL, /market\.status = 'open'/)
  assert.match(V2_MARKET_MIRROR_UPDATE_SQL, /market\.close_time <= now\(\)/)
  assert.match(V2_MARKET_MIRROR_UPDATE_SQL, /market\.onchain_observed_at < market\.close_time/)
})

test('V2 mirror initializes observation time for existing rows', () => {
  assert.match(V2_MARKET_MIRROR_UPDATE_SQL, /market\.onchain_observed_at IS NULL/)
})
