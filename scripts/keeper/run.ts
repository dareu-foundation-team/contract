// Keeper SERVICE entrypoint: one long-running process for production.
// Each fast cycle (KEEPER_CYCLE_SEC, default 300=5min) runs, in order:
//   sync (mirror on-chain status/pools, correct PG) → publish drafts →
//   propose (4C) → finalize (4C-2) → cancel (4C-3) → stuck-cancel (4C-4).
// sync runs FIRST so the loops see fresh onchain_status before deciding to send a
// tx (avoids duplicate on-chain submission). Holds the owner key + proof server.
//
//   npm run keeper:run -- preprod
import { loadEnvFiles, optionalEnv, resolveNetwork } from '../shared/chain.js'
import { publishDrafts } from './publish.js'
import {
  autoProposeResolutions,
  finalizeProposals,
  cancelRequested,
  cancelStuck,
} from './autopropose.js'
import { syncOnce } from './sync.js'

async function main() {
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const cycleSec = Number(optionalEnv('KEEPER_CYCLE_SEC') ?? '300')
  console.log(`[keeper] up — full cycle (sync+publish+propose+finalize+cancel+stuck-cancel) every ${cycleSec}s`)

  for (;;) {
    try {
      // sync FIRST: mirror chain state so the loops below see fresh onchain_status.
      await syncOnce(network)
      await publishDrafts(network)
      await autoProposeResolutions(network)
      await finalizeProposals(network)
      await cancelRequested(network)
      await cancelStuck(network)
    } catch (err) {
      console.error('[keeper] cycle error:', err instanceof Error ? err.message : err)
    }
    await new Promise((r) => setTimeout(r, cycleSec * 1000))
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[keeper] ${sig} — shutting down`)
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
