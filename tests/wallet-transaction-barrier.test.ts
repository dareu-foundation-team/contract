import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isWalletTransactionSettled } from '../scripts/shared/midnight.js'

type StateOptions = {
  dustApplied?: number
  dustPending?: number
  pendingTransactions?: number
  synced?: boolean
}

function walletState({
  dustApplied = 101,
  dustPending = 0,
  pendingTransactions = 0,
  synced = true,
}: StateOptions = {}) {
  const progress = {
    appliedIndex: BigInt(dustApplied),
    isCompleteWithin: (_gap: bigint) => synced,
  }
  return {
    shielded: { state: { progress } },
    dust: {
      state: { progress },
      pendingCoins: Array.from({ length: dustPending }, () => ({})),
    },
    unshielded: { progress },
    pending: {
      all: Array.from({ length: pendingTransactions }, () => ({})),
    },
  }
}

test('post-transaction barrier requires Indexer, DUST and strict wallet sync', () => {
  const checkpoint = { dustAppliedIndex: 100 }

  assert.equal(isWalletTransactionSettled(walletState() as any, checkpoint), true)
  assert.equal(isWalletTransactionSettled(
    walletState({ pendingTransactions: 1 }) as any,
    checkpoint,
  ), false)
  assert.equal(isWalletTransactionSettled(
    walletState({ dustPending: 1 }) as any,
    checkpoint,
  ), false)
  assert.equal(isWalletTransactionSettled(
    walletState({ dustApplied: 100 }) as any,
    checkpoint,
  ), false)
  assert.equal(isWalletTransactionSettled(
    walletState({ synced: false }) as any,
    checkpoint,
  ), false)
})
