// Keeper SERVICE entrypoint — v2 contract. One long-running process, same cycle
// shape as run.ts:
//   sync (mirror on-chain status/pools, correct PG) → publish drafts →
//   propose (sNIGHT bond) → finalize → cancel → stuck-cancel.
// sync runs FIRST so the loops see fresh onchain_status before deciding to send a
// tx (avoids duplicate on-chain submission). Holds the OPERATOR hot key (owner
// key stays cold — D8) + needs the proof server.
//
//   npm run keeper:v2:run -- preprod
import { loadEnvFiles, optionalEnv, resolveNetwork } from '../shared/chain.js'
import { publishDraftsV2 } from './publish-v2.js'
import {
  autoProposeResolutionsV2,
  finalizeProposalsV2,
  cancelRequestedV2,
  cancelStuckV2,
} from './autopropose-v2.js'
import { syncOnceV2 } from './sync-v2.js'
import { resolveDeploymentV2 } from '../shared/chain-v2.js'

async function main() {
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const cycleSec = Number(optionalEnv('KEEPER_CYCLE_SEC') ?? '300')
  const deployment = await resolveDeploymentV2(network)
  console.log(
    `[keeper-v2] registry ${deployment.registryAddress} → ${deployment.symbol} ` +
      `${deployment.contractAddress} (${deployment.decimals} decimals, enabled)`,
  )
  console.log(`[keeper-v2] up — full cycle (sync+publish+propose+finalize+cancel+stuck-cancel) every ${cycleSec}s`)

  for (;;) {
    try {
      // sync FIRST: mirror chain state so the loops below see fresh onchain_status.
      await syncOnceV2(network)
      await publishDraftsV2(network)
      await autoProposeResolutionsV2(network)
      await finalizeProposalsV2(network)
      await cancelRequestedV2(network)
      await cancelStuckV2(network)
    } catch (err) {
      console.error('[keeper-v2] cycle error:', err instanceof Error ? err.message : err)
    }
    await new Promise((r) => setTimeout(r, cycleSec * 1000))
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
