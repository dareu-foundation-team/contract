// Keeper SERVICE entrypoint — v3 contract. One long-running transaction process:
//   direct resolve → cancel → bounded/preemptible publish → direct resolve → cancel.
// The read-only on-chain mirror is intentionally a separate 30-second process
// (sync-v3.ts), so wallet/prover work cannot delay web metrics. This process holds
// the OPERATOR hot key (owner key stays cold — D8) + needs the proof server.
//
//   npm run keeper:v3:run -- preprod crypto
import { loadEnvFiles, optionalEnv, resolveNetwork } from '../shared/chain.js'
import { publishDraftsV3 } from './publish-v3.js'
import {
  resolveMarketsV3,
  cancelRequestedV3,
} from './resolve-v3.js'
import { connectKeeperV3, resolveDeploymentV3 } from '../shared/chain-v3.js'
import { isWalletSyncRecoveryExhausted } from '../shared/midnight.js'
import { startWalletHealthMetrics } from '../shared/midnight.js'
import {
  errorMessage,
  isBrokenKeeperContext,
  isKeeperDustUnavailable,
  isKeeperTransactionTimeout,
  keeperBatchLimit,
  stopWalletSafely,
} from './reliability.js'
import { configureKeeperCategory } from './scope-v2.js'
import { runKeeperPriorityCycle, type KeeperPriorityCycle } from './scheduling-v2.js'

async function main() {
  const category = configureKeeperCategory(process.argv[3])
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const cycleSec = Number(optionalEnv('KEEPER_CYCLE_SEC') ?? '300')
  const busyRetrySec = Number(optionalEnv('KEEPER_BUSY_RETRY_SEC') ?? '5')
  const errorRetrySec = Number(optionalEnv('KEEPER_ERROR_RETRY_SEC') ?? '20')
  const dustRetrySec = Number(optionalEnv('KEEPER_DUST_RETRY_SEC') ?? String(cycleSec))
  const publishQuantum = keeperBatchLimit(
    'PUBLISH_QUANTUM',
    10,
    'KEEPER_MAX_PUBLISH_QUANTUM',
    50,
  )
  const emptyCancelQuantum = keeperBatchLimit(
    'EMPTY_CANCEL_LIMIT',
    2,
    'KEEPER_MAX_EMPTY_CANCEL_LIMIT',
    10,
  )
  const deployment = await resolveDeploymentV3(network)
  console.log(
    `[keeper-v3] registry ${deployment.registryAddress} → ${deployment.symbol} ` +
      `${deployment.contractAddress} (${deployment.decimals} decimals, enabled)`,
  )
  console.log(
    `[keeper-v3:${category}] up — settlement-priority cycle every ${cycleSec}s ` +
      `(publish quantum ${publishQuantum}, empty cleanup quantum ${emptyCancelQuantum}, ` +
      `busy retry ${busyRetrySec}s)`,
  )

  for (;;) {
    let cycleFailed = false
    let dustUnavailable = false
    let madeProgress = false
    try {
      const context = await connectKeeperV3(network)
      const stopHealthMetrics = startWalletHealthMetrics(context.walletCtx.wallet, network)
      let cycle: KeeperPriorityCycle
      try {
        cycle = await runKeeperPriorityCycle({
          resolve: () => resolveMarketsV3(network, context),
          cancelFunded: () => cancelRequestedV3(network, { mode: 'funded' }, context),
          cancelEmpty: () => cancelRequestedV3(network, {
            mode: 'empty',
            limit: emptyCancelQuantum,
          }, context),
          publish: () => publishDraftsV3(network, {
            limit: publishQuantum,
            preemptForSettlement: true,
            context,
          }),
        })
      } finally {
        stopHealthMetrics()
        await stopWalletSafely(context.walletCtx.wallet, `keeper-v3:${category} cycle`)
      }
      madeProgress = cycle.madeProgress
      console.log(
        `[keeper-v3:${category}] cycle: ` +
          `resolve ${cycle.resolveBeforePublish.succeeded}+${cycle.resolveAfterPublish.succeeded}, ` +
          `funded-cancel ${cycle.fundedCancelBeforePublish.succeeded}+${cycle.fundedCancelAfterPublish.succeeded}, ` +
          `empty-cancel ${cycle.emptyCancelAfterPublish.succeeded}, ` +
          `publish ${cycle.publish.succeeded}` +
          `${cycle.publish.preempted ? ' (preempted for funded settlement/refund)' : ''}.`,
      )
    } catch (err) {
      console.error(`[keeper-v3:${category}] cycle error:`, errorMessage(err))
      if (isKeeperDustUnavailable(err)) {
        dustUnavailable = true
      } else if (isKeeperTransactionTimeout(err) || isBrokenKeeperContext(err)) {
        // Promise.race cannot cancel an in-flight SDK call. Exit the whole process
        // so the supervisor can guarantee that no stale wallet/session overlaps
        // its replacement.
        throw err
      } else {
        cycleFailed = true
      }
    }
    const waitSec = dustUnavailable
      ? dustRetrySec
      : cycleFailed
        ? errorRetrySec
        : madeProgress
          ? busyRetrySec
          : cycleSec
    const waitReason = dustUnavailable
      ? ' (waiting for spendable DUST)'
      : cycleFailed
        ? ' (recovery retry)'
        : madeProgress
          ? ' (queue still active)'
          : ''
    console.log(`[keeper-v3:${category}] next cycle in ${waitSec}s${waitReason}.`)
    await new Promise((r) => setTimeout(r, waitSec * 1000))
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[keeper-v3] ${sig} — shutting down`)
    process.exit(0)
  })
}

process.on('unhandledRejection', (reason) => {
  // Wallet/RPC libraries can reject an internal transport Promise with a raw
  // ErrorEvent. Continuing would reuse an unknown wallet context, so fail in a
  // controlled, supervisor-restartable way while preserving the original cause.
  console.error('[keeper-v3] unhandled rejection — exiting with a fresh wallet required:', errorMessage(reason))
  process.exit(1)
})

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  // Exit 78 tells the shell supervisor that automatic wallet recovery has
  // already been exhausted and operator inspection is required.
  process.exit(isWalletSyncRecoveryExhausted(err) ? 78 : 1)
})
