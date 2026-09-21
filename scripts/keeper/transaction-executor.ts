import type { WalletContext } from '../shared/midnight.js'
import type { SupportedNetwork } from '../shared/network.js'
import {
  captureWalletTransactionCheckpoint,
  walletHealthSnapshot,
  waitForWalletTransactionSettlement,
} from '../shared/midnight.js'
import {
  KeeperContextBrokenError,
  withKeeperTransactionTimeout,
} from './reliability.js'

export function keeperTxId(result: unknown): string {
  const value = result as any
  return value?.public?.txId ?? value?.txId ?? value?.finalizedTxData?.txId ?? ''
}

/** One transaction boundary shared by publish, resolve and cancel. */
export async function executeKeeperTransaction<T>(
  walletCtx: WalletContext,
  network: SupportedNetwork,
  operation: string,
  submit: () => Promise<T>,
): Promise<{ result: T; txId: string }> {
  const checkpoint = await captureWalletTransactionCheckpoint(walletCtx.wallet)
  const result = await withKeeperTransactionTimeout(operation, submit)
  const txId = keeperTxId(result)
  try {
    await withKeeperTransactionTimeout(
      `post-transaction wallet sync: ${operation}`,
      () => waitForWalletTransactionSettlement(walletCtx.wallet, txId, checkpoint),
    )
    await walletCtx.saveState()
  } catch (error) {
    try {
      console.error(JSON.stringify({
        ...(await walletHealthSnapshot(walletCtx.wallet, network)),
        event: 'wallet_transaction_failure',
        operation,
      }))
    } catch { /* retain the transaction failure as the primary error */ }
    throw new KeeperContextBrokenError(`post-transaction wallet sync: ${operation}`, error)
  }
  return { result, txId }
}
