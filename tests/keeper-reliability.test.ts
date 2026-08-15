import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  KeeperContextBrokenError,
  KeeperTransactionTimeoutError,
  abortBatchIfContextBroken,
  isBrokenKeeperContext,
  keeperBatchLimit,
  withKeeperTransactionTimeout,
} from '../scripts/keeper/reliability.js'

test('keeper transaction timeout rejects instead of hanging forever', async () => {
  await assert.rejects(
    withKeeperTransactionTimeout('test operation', () => new Promise(() => undefined), 20),
    (error: unknown) => error instanceof KeeperTransactionTimeoutError && error.operation === 'test operation',
  )
})

test('transport failures invalidate the current wallet context', () => {
  for (const message of [
    'read ECONNRESET',
    'Wallet.Sync: [object Object]',
    'Observed ServerError in PendingTransactionsService',
    'Invalid Transaction: Custom error: 170',
    'websocket connection closed',
    'connection terminated due to connection timeout',
    'Query read timeout',
    'canceling statement due to statement timeout',
    'Timed out while waiting for Midnight wallet sync. Check the Indexer websocket and wallet seed.',
    'No response received from RPC endpoint in 60s',
    'FATAL: Unable to initialize the API: No response received from RPC endpoint in 60s',
    'API-WS disconnected: 1006 Abnormal Closure',
    'RPC preflight timed out after 15000ms',
  ]) {
    assert.equal(isBrokenKeeperContext(new Error(message)), true, message)
  }
  assert.equal(isBrokenKeeperContext(new Error('failed assert: Market does not exist')), false)
  assert.throws(
    () => abortBatchIfContextBroken('publish-v2', new Error('read ECONNRESET')),
    KeeperContextBrokenError,
  )
  assert.throws(
    () => abortBatchIfContextBroken(
      'publish-v2 create_market',
      new Error('Invalid Transaction: Custom error: 170'),
    ),
    KeeperContextBrokenError,
  )
})

test('keeper batch limit caps an unsafe requested batch', () => {
  const oldLimit = process.env.TEST_KEEPER_LIMIT
  const oldMax = process.env.KEEPER_MAX_BATCH_SIZE
  const oldWarn = console.warn
  try {
    process.env.TEST_KEEPER_LIMIT = '500'
    process.env.KEEPER_MAX_BATCH_SIZE = '50'
    console.warn = () => undefined
    assert.equal(keeperBatchLimit('TEST_KEEPER_LIMIT'), 50)
  } finally {
    console.warn = oldWarn
    if (oldLimit === undefined) delete process.env.TEST_KEEPER_LIMIT
    else process.env.TEST_KEEPER_LIMIT = oldLimit
    if (oldMax === undefined) delete process.env.KEEPER_MAX_BATCH_SIZE
    else process.env.KEEPER_MAX_BATCH_SIZE = oldMax
  }
})

test('publish total and wallet session can use independent caps', () => {
  const previous = {
    total: process.env.TEST_PUBLISH_TOTAL,
    totalMax: process.env.TEST_PUBLISH_TOTAL_MAX,
    session: process.env.TEST_PUBLISH_SESSION,
    sessionMax: process.env.KEEPER_MAX_BATCH_SIZE,
  }
  try {
    process.env.TEST_PUBLISH_TOTAL = '500'
    process.env.TEST_PUBLISH_TOTAL_MAX = '1000'
    process.env.TEST_PUBLISH_SESSION = '20'
    process.env.KEEPER_MAX_BATCH_SIZE = '50'
    assert.equal(keeperBatchLimit('TEST_PUBLISH_TOTAL', 500, 'TEST_PUBLISH_TOTAL_MAX', 1000), 500)
    assert.equal(keeperBatchLimit('TEST_PUBLISH_SESSION', 20), 20)
  } finally {
    for (const [key, value] of [
      ['TEST_PUBLISH_TOTAL', previous.total],
      ['TEST_PUBLISH_TOTAL_MAX', previous.totalMax],
      ['TEST_PUBLISH_SESSION', previous.session],
      ['KEEPER_MAX_BATCH_SIZE', previous.sessionMax],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
