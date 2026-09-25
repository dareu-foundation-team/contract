import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  WalletSyncRecoveryExhaustedError,
  WalletReplayMemoryLimitError,
  WalletReplaySegmentBoundaryError,
  WalletSyncStalledError,
  chooseWalletSyncRecoveryMode,
  hasWalletAppliedProgress,
  isWalletCacheFingerprintCompatible,
  isWalletSyncRecoveryExhausted,
  isWalletReplayMemoryLimit,
  isWalletReplaySegmentBoundary,
  nextWalletSyncRecoveryAttempt,
  nextWalletReplayHeapLimitMb,
  walletReplaySegmentStream,
} from '../scripts/shared/midnight.js'

test('wallet cache rejects legacy snapshots without an SDK fingerprint', () => {
  assert.equal(isWalletCacheFingerprintCompatible(undefined), false)
  assert.equal(isWalletCacheFingerprintCompatible(''), false)
})

test('wallet replay memory limits request a clean-process checkpoint resume', () => {
  const error = new WalletReplayMemoryLimitError(6144, 6144)
  assert.equal(isWalletReplayMemoryLimit(error), true)
  assert.equal(isWalletReplayMemoryLimit(new Error('ordinary failure')), false)
  assert.match(error.message, /checkpointing before a fresh-process resume/)
})

test('wallet replay OOM recovery lowers the next soft boundary with a floor', () => {
  assert.equal(nextWalletReplayHeapLimitMb(4096, 2048), 3072)
  assert.equal(nextWalletReplayHeapLimitMb(3072, 2048), 2304)
  assert.equal(nextWalletReplayHeapLimitMb(2304, 2048), 2048)
  assert.equal(nextWalletReplayHeapLimitMb(2048, 2048), 2048)
})

test('wallet replay cursor/time boundaries request a clean-process checkpoint resume', () => {
  const error = new WalletReplaySegmentBoundaryError('cursor', 50_000, 'dust advanced by 50000')
  assert.equal(isWalletReplaySegmentBoundary(error), true)
  assert.equal(isWalletReplaySegmentBoundary(new WalletReplayMemoryLimitError(6144, 6144)), true)
  assert.equal(isWalletReplaySegmentBoundary(new Error('ordinary failure')), false)
})

test('wallet replay cursor segmentation follows DUST and ignores fast shielded/unshielded catch-up', () => {
  const baseline = { shielded: 0n, dust: 0n, unshielded: 0n }
  assert.equal(
    walletReplaySegmentStream(baseline, { shielded: 2_000n, dust: 500n, unshielded: 607_000n }, 50_000n),
    undefined,
  )
  assert.equal(
    walletReplaySegmentStream(baseline, { shielded: 50_000n, dust: 500n, unshielded: 607_000n }, 50_000n),
    undefined,
  )
  assert.equal(
    walletReplaySegmentStream(baseline, { shielded: 50_000n, dust: 50_000n, unshielded: 607_000n }, 50_000n),
    'dust',
  )
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
  const first = nextWalletSyncRecoveryAttempt(undefined, 1449881, '2026-08-23T00:00:00.000Z', 'a', 'cold')
  const second = nextWalletSyncRecoveryAttempt(first, 1449881, '2026-08-23T00:10:00.000Z', 'b', 'cold')
  const moved = nextWalletSyncRecoveryAttempt(second, 1449999, '2026-08-23T00:20:00.000Z', 'c', 'cold')

  assert.deepEqual(first, {
    dustAppliedIndex: 1449881,
    attempts: 1,
    checkpointHash: 'a',
    recoveryMode: 'cold',
    updatedAt: '2026-08-23T00:00:00.000Z',
  })
  assert.equal(second.attempts, 2)
  assert.equal(moved.attempts, 1)
})

test('identical last-good snapshots force cold replay', () => {
  assert.equal(chooseWalletSyncRecoveryMode('same', 'same'), 'cold')
  assert.equal(chooseWalletSyncRecoveryMode('active', undefined), 'cold')
  assert.equal(chooseWalletSyncRecoveryMode('active', 'distinct'), 'last-good')
})

test('legacy recovery counters reset once under the fingerprint-aware policy', () => {
  const legacy = { dustAppliedIndex: 1449881, attempts: 9, updatedAt: '2026-08-22T00:00:00.000Z' }
  const migrated = nextWalletSyncRecoveryAttempt(
    legacy, 1449881, '2026-08-23T00:00:00.000Z', 'checkpoint-a', 'cold',
  )
  assert.equal(migrated.attempts, 1)
})

test('wallet sync recovery records checkpoint identity and recovery mode', () => {
  const first = nextWalletSyncRecoveryAttempt(
    undefined, 1449881, '2026-08-23T00:00:00.000Z', 'checkpoint-a', 'cold',
  )
  const repeated = nextWalletSyncRecoveryAttempt(
    first, 1449881, '2026-08-23T00:10:00.000Z', 'checkpoint-b', 'cold',
  )

  assert.equal(repeated.attempts, 2)
  assert.equal(repeated.checkpointHash, 'checkpoint-b')
  assert.equal(repeated.recoveryMode, 'cold')
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

test('wallet sync errors distinguish transport disconnects from cursor stalls', () => {
  const disconnected = new WalletSyncStalledError(
    600_000,
    1_462_369,
    ['dust'],
    'dust disconnected during restore',
    ['dust'],
  )
  assert.deepEqual(disconnected.disconnectedStreams, ['dust'])

  const cursorStall = new WalletSyncStalledError(600_000, 1_462_369, ['dust'], 'dust stopped advancing')
  assert.deepEqual(cursorStall.disconnectedStreams, [])
})
