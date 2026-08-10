import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Effect } from 'effect'

import { makeHeadlessTransactionHistoryService } from '../scripts/shared/midnight.js'

test('headless transaction history returns metadata without querying the Indexer', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error('transaction-history service must not call fetch')
  }) as typeof fetch

  try {
    const service = makeHeadlessTransactionHistoryService()
    const details = await Effect.runPromise(service.getTransactionDetails('test-transaction-hash'))
    await Effect.runPromise(service.put())

    assert.deepEqual(details, {
      hash: 'test-transaction-hash',
      status: 'SUCCESS',
      timestamp: 0,
    })
    assert.equal(fetchCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
