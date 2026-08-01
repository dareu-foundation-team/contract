// Keeper SERVICE entrypoint — v2 contract. One long-running process, same cycle
// shape as run.ts:
//   sync (mirror on-chain status/pools, correct PG) → publish drafts →
//   direct resolve → cancel.
// sync runs FIRST so the loops see fresh onchain_status before deciding to send a
// tx (avoids duplicate on-chain submission). Holds the OPERATOR hot key (owner
// key stays cold — D8) + needs the proof server.
//
//   npm run keeper:v2:run -- preprod crypto
import { loadEnvFiles, optionalEnv, resolveNetwork } from '../shared/chain.js'
import { publishDraftsV2 } from './publish-v2.js'
import {
  resolveMarketsV2,
  cancelRequestedV2,
} from './resolve-v2.js'
import { syncOnceV2 } from './sync-v2.js'
import { resolveDeploymentV2 } from '../shared/chain-v2.js'
import {
  errorMessage,
  isKeeperTransactionTimeout,
} from './reliability.js'
import { configureKeeperCategory } from './scope-v2.js'

async function main() {
  const category = configureKeeperCategory(process.argv[3])
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const cycleSec = Number(optionalEnv('KEEPER_CYCLE_SEC') ?? '300')
  const errorRetrySec = Number(optionalEnv('KEEPER_ERROR_RETRY_SEC') ?? '20')
  const deployment = await resolveDeploymentV2(network)
  console.log(
    `[keeper-v2] registry ${deployment.registryAddress} → ${deployment.symbol} ` +
      `${deployment.contractAddress} (${deployment.decimals} decimals, enabled)`,
  )
  console.log(`[keeper-v2:${category}] up — full cycle (sync+publish+resolve+cancel) every ${cycleSec}s`)

  for (;;) {
    let cycleFailed = false
    try {
      // sync FIRST: mirror chain state so the loops below see fresh onchain_status.
      await syncOnceV2(network)
      await publishDraftsV2(network)
      await resolveMarketsV2(network)
      await cancelRequestedV2(network)
    } catch (err) {
      console.error(`[keeper-v2:${category}] cycle error:`, errorMessage(err))
      if (isKeeperTransactionTimeout(err)) {
        // Promise.race cannot cancel an in-flight SDK call. Exit the whole process
        // so the supervisor can guarantee that no zombie submission overlaps the
        // replacement wallet.
        throw err
      }
      cycleFailed = true
    }
    const waitSec = cycleFailed ? errorRetrySec : cycleSec
    console.log(`[keeper-v2:${category}] next cycle in ${waitSec}s${cycleFailed ? ' (recovery retry)' : ''}.`)
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
