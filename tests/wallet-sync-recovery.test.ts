import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  WalletSyncRecoveryExhaustedError,
  WalletSyncStalledError,
  hasWalletAppliedProgress,
  isWalletCacheFingerprintCompatible,
  isWalletSyncRecoveryExhausted,
  nextWalletSyncRecoveryAttempt,
} from '../scripts/shared/midnight.js'

test('wallet cache rejects legacy snapshots without an SDK fingerprint', () => {
  assert.equal(isWalletCacheFingerprintCompatible(undefined), false)
  assert.equal(isWalletCacheFingerprintCompatible(''), false)
})

test('wallet applied progress advances when any applied cursor moves forward', () => {
  const baseline = { shielded: 10n, dust: 20n, unshielded: 30n }
  assert.equal(hasWalletAppliedProgress(baseline, baseline), false)
  assert.equal(hasWalletAppliedProgress(baseline, { ...baseline, dust: 21n }), true)
  assert.equal(hasWalletAppliedProgress(baseline, { ...baseline, shielded: 11n }), true)
  assert.equal(hasWalletAppliedProgress(baseline, { ...baseline, unshielded: 31n }), true)
  assert.equal(
    hasWalletAppliedProgress(baseline, { shielded: 9n, dust: 19n, unshielded: 29n }),
    false,
  )
})

test('wallet sync recovery counts only repeated stalls at the same DUST index', () => {
  const first = nextWalletSyncRecoveryAttempt(undefined, 1449881, '2026-08-23T00:00:00.000Z')
  const second = nextWalletSyncRecoveryAttempt(first, 1449881, '2026-08-23T00:10:00.000Z')
  const moved = nextWalletSyncRecoveryAttempt(second, 1449999, '2026-08-23T00:20:00.000Z')

  assert.deepEqual(first, {
    dustAppliedIndex: 1449881,
    attempts: 1,
    updatedAt: '2026-08-23T00:00:00.000Z',
  })
  assert.equal(second.attempts, 2)
  assert.equal(moved.attempts, 1)
})

test('wallet sync recovery errors preserve the stalled index and fatal classification', () => {
  const stalled = new WalletSyncStalledError(
    600_000,
    1449881,
    ['dust'],
    'Wallet sync progress: dust(applied=1449881)',
  )
  assert.match(stalled.message, /no applied-index progress/)
  assert.equal(stalled.dustAppliedIndex, 1449881)

  const exhausted = new WalletSyncRecoveryExhaustedError(2, stalled.dustAppliedIndex)
  assert.equal(isWalletSyncRecoveryExhausted(exhausted), true)
  assert.equal(isWalletSyncRecoveryExhausted(new Error('ordinary failure')), false)
})
