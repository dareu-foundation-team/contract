// Keeper SERVICE: mirror on-chain v2 market state into Postgres — v2 twin of
// sync.ts. Read-only, needs no wallet, only the indexer.
//
//   npm run keeper:v2:sync -- preprod crypto                       # one-shot
//   SYNC_INTERVAL_SEC=30 npm run keeper:v2:sync -- preprod crypto  # poll loop
import pg from 'pg'
import { MarketStatus, Outcome } from '../../src/managed/dareu-v2/contract/index.js'
import { loadEnvFiles, optionalEnv, requiredEnv, resolveNetwork } from '../shared/chain.js'
import { ensureV2MarketColumns, readV2Ledger, resolveDeploymentV2 } from '../shared/chain-v2.js'
import { configureKeeperCategory, requiredKeeperCategory } from './scope-v2.js'

// On-chain enums → the lowercase strings the webapp/Postgres mirror columns expect.
const STATUS_TEXT: Record<number, string> = {
  [MarketStatus.OPEN]: 'open',
  [MarketStatus.PROPOSED]: 'proposed',
  [MarketStatus.DISPUTED]: 'disputed',
  [MarketStatus.RESOLVED]: 'resolved',
  [MarketStatus.CANCELLED]: 'cancelled',
}
const OUTCOME_TEXT: Record<number, string | null> = {
  [Outcome.NONE]: null,
  [Outcome.YES]: 'yes',
  [Outcome.NO]: 'no',
}

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')
}

export async function syncOnceV2(network: ReturnType<typeof resolveNetwork>): Promise<void> {
  const dbUrl = requiredEnv('DATABASE_URL')
  const category = requiredKeeperCategory()
  await ensureV2MarketColumns(dbUrl)
  const deployment = await resolveDeploymentV2(network)
  const led = await readV2Ledger(network)
  if (!led) {
    console.log('[sync-v2] contract state not found on the indexer yet.')
    return
  }

  // One client for the whole batch (avoid a connection per row).
  const client = new pg.Client({ connectionString: dbUrl })
  await client.connect()
  let n = 0
  try {
    for (const [id, m] of led.markets) {
      const result = await client.query(
        `UPDATE markets
            SET onchain_status = $2, onchain_yes_pool = $3, onchain_no_pool = $4,
                onchain_outcome = $5, onchain_contract_version='v2',
                onchain_contract_address=$6, synced_at = now()
          WHERE id = $1 AND category = $7`,
        [toHex(id), STATUS_TEXT[m.status] ?? null, m.yes_pool.toString(), m.no_pool.toString(), OUTCOME_TEXT[m.outcome] ?? null, deployment.contractAddress, category],
      )
      n += result.rowCount ?? 0
    }
  } finally {
    await client.end()
  }
  console.log(`[sync-v2:${category}] mirrored ${n} on-chain market(s) → Postgres.`)
}

async function main(): Promise<void> {
  configureKeeperCategory(process.argv[3])
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const intervalSec = Number(optionalEnv('SYNC_INTERVAL_SEC') ?? '0')

  if (intervalSec > 0) {
    console.log(`[sync-v2] polling every ${intervalSec}s (Ctrl-C to stop)`)
    for (;;) {
      try {
        await syncOnceV2(network)
      } catch (err) {
        console.error('[sync-v2] error:', err instanceof Error ? err.message : err)
      }
      await new Promise((r) => setTimeout(r, intervalSec * 1000))
    }
  } else {
    await syncOnceV2(network) // one-shot
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
