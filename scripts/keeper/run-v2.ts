// Keeper SERVICE entrypoint — v2 contract. One long-running transaction process:
//   direct resolve → cancel → bounded/preemptible publish → direct resolve → cancel.
// The read-only on-chain mirror is intentionally a separate 30-second process
// (sync-v2.ts), so wallet/prover work cannot delay web metrics. This process holds
// the OPERATOR hot key (owner key stays cold — D8) + needs the proof server.
//
//   npm run keeper:v2:run -- preprod crypto
import { loadEnvFiles, optionalEnv, resolveNetwork } from '../shared/chain.js'
import { publishDraftsV2 } from './publish-v2.js'
import {
  resolveMarketsV2,
  cancelRequestedV2,
} from './resolve-v2.js'
import { resolveDeploymentV2 } from '../shared/chain-v2.js'
import {
  errorMessage,
  isBrokenKeeperContext,
  isKeeperTransactionTimeout,
  keeperBatchLimit,
} from './reliability.js'
import { configureKeeperCategory } from './scope-v2.js'
import { runKeeperPriorityCycle } from './scheduling-v2.js'

async function main() {
  const category = configureKeeperCategory(process.argv[3])
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const cycleSec = Number(optionalEnv('KEEPER_CYCLE_SEC') ?? '300')
  const busyRetrySec = Number(optionalEnv('KEEPER_BUSY_RETRY_SEC') ?? '5')
  const errorRetrySec = Number(optionalEnv('KEEPER_ERROR_RETRY_SEC') ?? '20')
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
  const deployment = await resolveDeploymentV2(network)
  console.log(
    `[keeper-v2] registry ${deployment.registryAddress} → ${deployment.symbol} ` +
      `${deployment.contractAddress} (${deployment.decimals} decimals, enabled)`,
  )
  console.log(
    `[keeper-v2:${category}] up — settlement-priority cycle every ${cycleSec}s ` +
      `(publish quantum ${publishQuantum}, empty cleanup quantum ${emptyCancelQuantum}, ` +
      `busy retry ${busyRetrySec}s)`,
  )

  for (;;) {
    let cycleFailed = false
    let madeProgress = false
    try {
      const cycle = await runKeeperPriorityCycle({
        resolve: () => resolveMarketsV2(network),
        cancelFunded: () => cancelRequestedV2(network, { mode: 'funded' }),
        cancelEmpty: () => cancelRequestedV2(network, {
          mode: 'empty',
          limit: emptyCancelQuantum,
        }),
        publish: () => publishDraftsV2(network, {
          limit: publishQuantum,
          preemptForSettlement: true,
        }),
      })
      madeProgress = cycle.madeProgress
      console.log(
        `[keeper-v2:${category}] cycle: ` +
          `resolve ${cycle.resolveBeforePublish.succeeded}+${cycle.resolveAfterPublish.succeeded}, ` +
          `funded-cancel ${cycle.fundedCancelBeforePublish.succeeded}+${cycle.fundedCancelAfterPublish.succeeded}, ` +
          `empty-cancel ${cycle.emptyCancelAfterPublish.succeeded}, ` +
          `publish ${cycle.publish.succeeded}` +
          `${cycle.publish.preempted ? ' (preempted for funded settlement/refund)' : ''}.`,
      )
    } catch (err) {
      console.error(`[keeper-v2:${category}] cycle error:`, errorMessage(err))
      if (isKeeperTransactionTimeout(err) || isBrokenKeeperContext(err)) {
        // Promise.race cannot cancel an in-flight SDK call. Exit the whole process
        // so the supervisor can guarantee that no stale wallet/session overlaps
        // its replacement.
        throw err
      }
      cycleFailed = true
    }
    const waitSec = cycleFailed ? errorRetrySec : madeProgress ? busyRetrySec : cycleSec
    const waitReason = cycleFailed
      ? ' (recovery retry)'
      : madeProgress
        ? ' (queue still active)'
        : ''
    console.log(`[keeper-v2:${category}] next cycle in ${waitSec}s${waitReason}.`)
    await new Promise((r) => setTimeout(r, waitSec * 1000))
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[keeper-v2] ${sig} — shutting down`)
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
