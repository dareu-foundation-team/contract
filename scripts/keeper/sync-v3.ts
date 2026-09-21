// Keeper SERVICE: mirror on-chain v3 market state into Postgres — v3 twin of
// sync.ts. Read-only, needs no wallet, only the indexer.
//
//   npm run keeper:v3:sync -- preprod                    # dedicated 30s loop
//   SYNC_INTERVAL_SEC=0 npm run keeper:v3:sync -- preprod # one-shot
import { MarketStatus, Outcome } from '../../src/managed/dareu-v3/contract/index.js'
import {
  loadEnvFiles,
  optionalEnv,
  pgExec,
  requiredEnv,
  resolveNetwork,
} from '../shared/chain.js'
import { ensureV3MarketColumns, readV3Ledger, resolveDeploymentV3 } from '../shared/chain-v3.js'
import { V3_MARKET_MIRROR_UPDATE_SQL } from './sync-v3-sql.js'

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

export type SyncV3Stats = {
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
export async function syncOnceV3(network: ReturnType<typeof resolveNetwork>): Promise<SyncV3Stats> {
  const startedAt = Date.now()
  const dbUrl = requiredEnv('DATABASE_URL')
  schemaReady ??= ensureV3MarketColumns(dbUrl)
  await schemaReady
  const deployment = await resolveDeploymentV3(network)
  const led = await readV3Ledger(network)
  if (!led) {
    console.log('[sync-v3] contract state not found on the indexer yet.')
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

  // Idempotent chain-to-DB reconciliation. This repairs the crash window where
  // callTx finalized but the keeper died before recording the transaction.
  const reconciled = await pgExec(
    dbUrl,
    `WITH chain_market AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::numeric[], $4::numeric[], $5::text[])
         AS c(id, status, yes_pool, no_pool, outcome)
     )
     UPDATE markets AS m
        SET onchain_tx_id = COALESCE(m.onchain_tx_id, 'reconciled-from-chain'),
            onchain_contract_version = 'v3',
            onchain_contract_address = $6,
            onchain_status = c.status,
            onchain_yes_pool = c.yes_pool,
            onchain_no_pool = c.no_pool,
            onchain_outcome = c.outcome,
            status = CASE
              WHEN c.status IN ('resolved', 'cancelled') THEN c.status
              WHEN m.status = 'draft' THEN 'open'
              ELSE m.status
            END,
            synced_at = now(),
            onchain_observed_at = now(),
            updated_at = now()
       FROM chain_market AS c
      WHERE m.id = c.id
        AND (m.onchain_tx_id IS NULL
          OR (m.onchain_contract_version = 'v3' AND m.onchain_contract_address = $6))
        AND (m.onchain_tx_id IS NULL
          OR m.onchain_contract_version IS DISTINCT FROM 'v3'
          OR m.onchain_contract_address IS DISTINCT FROM $6)`,
    [ids, statuses, yesPools, noPools, outcomes, deployment.contractAddress],
  )
  if ((reconciled.rowCount ?? 0) > 0) {
    console.warn(`[sync-v3] reconciled ${reconciled.rowCount} finalized on-chain market(s) into Postgres.`)
  }

  const result = await pgExec(
    dbUrl,
    V3_MARKET_MIRROR_UPDATE_SQL,
    [ids, statuses, yesPools, noPools, outcomes, deployment.contractAddress],
  )
  const updated = result.rowCount ?? 0

  const stats = { scanned: ids.length, updated, durationMs: Date.now() - startedAt }
  console.log(
    `[sync-v3] checked ${stats.scanned} on-chain market(s); ` +
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
      `[sync-v3] independent mirror up — one non-overlapping cycle every ${intervalSec}s ` +
        '(interval begins after the previous cycle finishes)',
    )
    for (;;) {
      try {
        await syncOnceV3(network)
      } catch (err) {
        console.error('[sync-v3] error:', err instanceof Error ? err.message : err)
      }
      await new Promise((r) => setTimeout(r, intervalSec * 1000))
    }
  } else {
    await syncOnceV3(network) // one-shot
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
