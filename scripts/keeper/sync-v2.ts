// Keeper SERVICE: mirror on-chain v2 market state into Postgres — v2 twin of
// sync.ts. Read-only, needs no wallet, only the indexer.
//
//   npm run keeper:v2:sync -- preprod                    # dedicated 30s loop
//   SYNC_INTERVAL_SEC=0 npm run keeper:v2:sync -- preprod # one-shot
import pg from 'pg'
import { MarketStatus, Outcome } from '../../src/managed/dareu-v2/contract/index.js'
import { loadEnvFiles, optionalEnv, requiredEnv, resolveNetwork } from '../shared/chain.js'
import { ensureV2MarketColumns, readV2Ledger, resolveDeploymentV2 } from '../shared/chain-v2.js'
import { V2_MARKET_MIRROR_UPDATE_SQL } from './sync-v2-sql.js'

// On-chain enums → the lowercase strings the webapp/Postgres mirror columns expect.
const STATUS_TEXT: Record<number, string> = {
  [MarketStatus.OPEN]: 'open',
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

export type SyncV2Stats = {
  scanned: number
  updated: number
  durationMs: number
}

let schemaReady: Promise<void> | undefined

/**
 * Mirror one ledger snapshot with one conditional batch UPDATE.
 *
 * PostgreSQL performs change/freshness detection, so unchanged markets are not
 * continuously rewritten. A closed OPEN market is observed once after close even
 * when its pools did not change; the resolver needs that observation to prove the
 * final pool snapshot is fresh. The global process intentionally has no category
 * scope: all categories share this contract and market ids are globally unique.
 */
export async function syncOnceV2(network: ReturnType<typeof resolveNetwork>): Promise<SyncV2Stats> {
  const startedAt = Date.now()
  const dbUrl = requiredEnv('DATABASE_URL')
  schemaReady ??= ensureV2MarketColumns(dbUrl)
  await schemaReady
  const deployment = await resolveDeploymentV2(network)
  const led = await readV2Ledger(network)
  if (!led) {
    console.log('[sync-v2] contract state not found on the indexer yet.')
    return { scanned: 0, updated: 0, durationMs: Date.now() - startedAt }
  }

  const ids: string[] = []
  const statuses: Array<string | null> = []
  const yesPools: string[] = []
  const noPools: string[] = []
  const outcomes: Array<string | null> = []
  for (const [id, market] of led.markets) {
    ids.push(toHex(id))
    statuses.push(STATUS_TEXT[market.status] ?? null)
    yesPools.push(market.yes_pool.toString())
    noPools.push(market.no_pool.toString())
    outcomes.push(OUTCOME_TEXT[market.outcome] ?? null)
  }

  if (ids.length === 0) {
    return { scanned: 0, updated: 0, durationMs: Date.now() - startedAt }
  }

  const client = new pg.Client({ connectionString: dbUrl })
  await client.connect()
  let updated = 0
  try {
    const result = await client.query(
      V2_MARKET_MIRROR_UPDATE_SQL,
      [ids, statuses, yesPools, noPools, outcomes, deployment.contractAddress],
    )
    updated = result.rowCount ?? 0
  } finally {
    await client.end()
  }

  const stats = { scanned: ids.length, updated, durationMs: Date.now() - startedAt }
  console.log(
    `[sync-v2] checked ${stats.scanned} on-chain market(s); ` +
      `refreshed ${stats.updated} changed/stale row(s) in ${stats.durationMs}ms.`,
  )
  return stats
}

async function main(): Promise<void> {
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const intervalSec = Number(optionalEnv('SYNC_INTERVAL_SEC') ?? '30')
  if (!Number.isFinite(intervalSec) || intervalSec < 0) {
    throw new Error('SYNC_INTERVAL_SEC must be a non-negative number.')
  }

  if (intervalSec > 0) {
    console.log(
      `[sync-v2] independent mirror up — one non-overlapping cycle every ${intervalSec}s ` +
        '(interval begins after the previous cycle finishes)',
    )
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
