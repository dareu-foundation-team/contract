import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pgClientConfig } from '../scripts/shared/chain.js'

test('keeper Postgres clients have bounded connect, query, statement and lock waits', () => {
  const names = [
    'PG_CONNECT_TIMEOUT_MS',
    'PG_QUERY_TIMEOUT_MS',
    'PG_STATEMENT_TIMEOUT_MS',
    'PG_LOCK_TIMEOUT_MS',
  ] as const
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  try {
    for (const name of names) delete process.env[name]
    const config = pgClientConfig('postgresql://example.invalid/dareu')

    assert.equal(config.connectionTimeoutMillis, 10_000)
    assert.equal(config.query_timeout, 30_000)
    assert.equal(config.statement_timeout, 30_000)
    assert.equal(config.lock_timeout, 10_000)
    assert.equal(config.keepAlive, true)
  } finally {
    for (const name of names) {
      const value = previous[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
