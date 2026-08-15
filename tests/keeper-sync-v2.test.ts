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

test('V2 mirror converges final on-chain status back into the canonical DB status', () => {
  assert.match(V2_MARKET_MIRROR_UPDATE_SQL, /state\.status IN \('resolved', 'cancelled'\)/)
  assert.match(V2_MARKET_MIRROR_UPDATE_SQL, /market\.status IS DISTINCT FROM state\.status/)
  assert.match(V2_MARKET_MIRROR_UPDATE_SQL, /WHEN state\.status = 'resolved' THEN state\.outcome/)
  assert.match(V2_MARKET_MIRROR_UPDATE_SQL, /WHEN state\.status = 'cancelled' THEN NULL/)
})
