import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  dustCostParameters,
  isWalletTransactionSettled,
} from '../scripts/shared/midnight.js'

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

test('remote DUST fee overhead defaults low and remains configurable', () => {
  const previous = process.env.MIDNIGHT_DUST_ADDITIONAL_FEE_OVERHEAD
  try {
    delete process.env.MIDNIGHT_DUST_ADDITIONAL_FEE_OVERHEAD
    assert.equal(dustCostParameters().additionalFeeOverhead, 1_000n)

    process.env.MIDNIGHT_DUST_ADDITIONAL_FEE_OVERHEAD = '2500'
    assert.equal(dustCostParameters().additionalFeeOverhead, 2_500n)
  } finally {
    if (previous === undefined) delete process.env.MIDNIGHT_DUST_ADDITIONAL_FEE_OVERHEAD
    else process.env.MIDNIGHT_DUST_ADDITIONAL_FEE_OVERHEAD = previous
  }
})
