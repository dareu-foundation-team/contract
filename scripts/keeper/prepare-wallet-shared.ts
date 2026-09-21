import { spawnSync } from 'node:child_process'

import { loadEnvFiles, resolveNetwork } from '../shared/chain.js'
import {
  configureNetwork,
  createWallet,
  ensureDust,
  isWalletReplaySegmentBoundary,
  isWalletSyncRecoveryExhausted,
  requiredWalletSeedOrMnemonic,
  waitForSyncedState,
  WalletSyncRecoveryExhaustedError,
  WalletSyncStalledError,
} from '../shared/midnight.js'
import { errorMessage, stopWalletSafely } from './reliability.js'
import { configureKeeperCategory } from './scope-v2.js'

const REPLAY_SEGMENT_EXIT = 75
const REPLAY_TRANSPORT_RETRY_EXIT = 76

async function prepare(version: 'v2' | 'v3'): Promise<void> {
  const category = configureKeeperCategory(process.argv[3])
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const config = configureNetwork(network)

  for (;;) {
    const walletCtx = await createWallet(requiredWalletSeedOrMnemonic(), network, config)
    let stopped = false
    try {
      const address = String(walletCtx.unshieldedKeystore.getBech32Address())
      console.log(`[keeper-wallet:${category}] address: ${address}`)
      await waitForSyncedState(walletCtx.wallet)
      const dust = await ensureDust(walletCtx, config)
      await waitForSyncedState(walletCtx.wallet, 0n)
      await stopWalletSafely(walletCtx.wallet, `prepare-wallet-${version} ${category}`)
      stopped = true
      await walletCtx.saveState()
      console.log(`[keeper-wallet:${category}] ready; DUST balance: ${dust.toString()}`)
      return
    } catch (error) {
      if (error instanceof WalletSyncStalledError) {
        if (error.disconnectedStreams.length > 0) {
          console.warn(
            `[keeper-wallet:${category}] transport remained disconnected ` +
              `(${error.disconnectedStreams.join(', ')}); restarting from the same checkpoint.`,
          )
          continue
        }
        const recovery = await walletCtx.recoverFromSyncStall(error)
        if (recovery.exhausted) {
          throw new WalletSyncRecoveryExhaustedError(recovery.attempt, error.dustAppliedIndex)
        }
        console.warn(`[keeper-wallet:${category}] stalled checkpoint quarantined; retrying from ${recovery.recoveryMode}.`)
      } else {
        const segmentBoundary = isWalletReplaySegmentBoundary(error)
        if (segmentBoundary) {
          console.log(`[keeper-wallet:${category}] replay segment complete: ${errorMessage(error)}`)
        } else {
          console.error(`[keeper-wallet:${category}] preparation interrupted: ${errorMessage(error)}`)
        }
        await stopWalletSafely(walletCtx.wallet, `prepare-wallet-${version} checkpoint ${category}`)
        stopped = true
        const saved = await walletCtx.saveCheckpoint()
        if (segmentBoundary && !saved) {
          throw new Error(
            `Keeper wallet reached a replay segment boundary but no safe checkpoint was written; ` +
              `refusing a zero-progress restart loop. Original error: ${errorMessage(error)}`,
            { cause: error },
          )
        }
        throw error
      }
    } finally {
      if (!stopped) await stopWalletSafely(walletCtx.wallet, `prepare-wallet-${version} ${category}`)
    }
  }
}

export function runKeeperWalletPreparation(version: 'v2' | 'v3'): void {
  if (process.env.DAREU_WALLET_PREPARE_CHILD === '1') {
    process.on('unhandledRejection', (reason) => {
      console.error(`[keeper-wallet] SDK transport rejected outside the sync promise: ${errorMessage(reason)}`)
      process.exit(REPLAY_TRANSPORT_RETRY_EXIT)
    })
    void prepare(version).catch((error) => {
      const segmentBoundary = isWalletReplaySegmentBoundary(error)
      if (!segmentBoundary) console.error(errorMessage(error))
      process.exitCode = segmentBoundary
        ? REPLAY_SEGMENT_EXIT
        : isWalletSyncRecoveryExhausted(error)
          ? 78
          : 1
    })
    return
  }

  let segment = 0
  for (;;) {
    segment += 1
    console.log(`[keeper-wallet] starting replay segment ${segment} in a fresh process.`)
    const child = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], ...process.argv.slice(2)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DAREU_WALLET_PREPARE_CHILD: '1',
        DAREU_WALLET_SEGMENTED_REPLAY: '1',
      },
      stdio: 'inherit',
    })
    if (child.error) {
      console.error(`[keeper-wallet] could not start replay child: ${child.error.message}`)
      process.exitCode = 1
      return
    }
    if (child.status === REPLAY_SEGMENT_EXIT) {
      console.warn('[keeper-wallet] safe checkpoint saved; resuming in a fresh process.')
      continue
    }
    if (child.status === REPLAY_TRANSPORT_RETRY_EXIT) {
      console.warn('[keeper-wallet] wallet transport failed; restarting from the unchanged checkpoint.')
      continue
    }
    process.exitCode = child.status ?? 1
    return
  }
}
