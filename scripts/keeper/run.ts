// Keeper SERVICE entrypoint: one long-running process for production.
// Mirrors on-chain state every SYNC_INTERVAL_SEC, and publishes drafts + proposes
// outcomes every KEEPER_CYCLE_SEC. Holds the owner key + needs the proof server.
//
//   npm run keeper:run -- preprod
import { loadEnvFiles, optionalEnv, resolveNetwork } from '../shared/chain.js'
import { publishDrafts } from './publish.js'
import { autoProposeResolutions } from './autopropose.js'
import { syncOnce } from './sync.js'

async function main() {
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const syncSec = Number(optionalEnv('SYNC_INTERVAL_SEC') ?? '30')
  const cycleSec = Number(optionalEnv('KEEPER_CYCLE_SEC') ?? '300')
  console.log(`[keeper] up — sync every ${syncSec}s, publish+propose every ${cycleSec}s`)

  let lastCycle = 0
  for (;;) {
    const now = Date.now()
    try {
      // Publish drafts + propose outcomes on the slower cycle (and once on startup).
      if (now - lastCycle >= cycleSec * 1000) {
        await publishDrafts(network)
        await autoProposeResolutions(network)
        lastCycle = now
      }
      // Mirror on-chain state every tick.
      await syncOnce(network)
    } catch (err) {
      console.error('[keeper] cycle error:', err instanceof Error ? err.message : err)
    }
    await new Promise((r) => setTimeout(r, syncSec * 1000))
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
