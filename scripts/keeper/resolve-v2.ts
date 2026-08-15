// Keeper SERVICE: direct oracle resolution and cancellation for DareU v2.
//
// DataProvider classifies a closed market as ready_to_resolve or
// cancel_requested. The authorized operator submits exactly one canonical
// resolve_market/cancel_market transaction. There is no proposal, bond,
// challenge, dispute, vote, or finalization phase.
import { Outcome } from '../../src/managed/dareu-v2/contract/index.js'
import {
  loadEnvFiles,
  parseHexBytes,
  pgExec,
  requiredEnv,
  resolveNetwork,
} from '../shared/chain.js'
import {
  connectKeeperV2,
  ensureV2MarketColumns,
  resolveDeploymentV2,
} from '../shared/chain-v2.js'
import {
  abortBatchIfContextBroken,
  errorMessage,
  keeperBatchLimit,
  stopWalletSafely,
  withKeeperTransactionTimeout,
} from './reliability.js'
import { configureKeeperCategory, requiredKeeperCategory } from './scope-v2.js'
import type { KeeperWorkResult } from './scheduling-v2.js'

export type CancelMode = 'funded' | 'empty' | 'all'

type CancelOptions = {
  mode?: CancelMode
  limit?: number
}

export const FUNDED_CANCEL_PREDICATE = `
  COALESCE(onchain_yes_pool, 0::numeric)
    + COALESCE(onchain_no_pool, 0::numeric) > 0`

export const EMPTY_CANCEL_PREDICATE = `
  COALESCE(onchain_yes_pool, 0::numeric)
    + COALESCE(onchain_no_pool, 0::numeric) = 0`

export async function resolveMarketsV2(
  network: ReturnType<typeof resolveNetwork>,
): Promise<KeeperWorkResult> {
  const dbUrl = requiredEnv('DATABASE_URL')
  const category = requiredKeeperCategory()
  const limit = keeperBatchLimit('RESOLVE_LIMIT')
  await ensureV2MarketColumns(dbUrl)
  const deployment = await resolveDeploymentV2(network)

  const { rows } = await pgExec(
    dbUrl,
    `SELECT id, outcome
       FROM markets
      WHERE status = 'ready_to_resolve'
        AND onchain_tx_id IS NOT NULL
        AND onchain_contract_version = 'v2'
        AND onchain_contract_address = $2
        AND COALESCE(onchain_status, 'open') = 'open'
        AND outcome IN ('yes', 'no')
        AND category = $3
      ORDER BY close_time ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit, deployment.contractAddress, category],
  )
  if (rows.length === 0) {
    console.log('[resolve-v2] no ready_to_resolve markets.')
    return { selected: 0, succeeded: 0 }
  }

  console.log(`[resolve-v2] resolving ${rows.length} market(s) directly on-chain…`)
  let succeeded = 0
  const { deployed, walletCtx } = await connectKeeperV2(network)
  try {
    for (const row of rows as Array<{ id: string; outcome: 'yes' | 'no' }>) {
      try {
        const outcome = row.outcome === 'yes' ? Outcome.YES : Outcome.NO
        await withKeeperTransactionTimeout(
          `resolve_market ${row.id.slice(0, 12)}`,
          () => deployed.callTx.resolve_market(
            parseHexBytes(row.id, 32, 'market_id'),
            outcome,
          ),
        )
        await pgExec(
          dbUrl,
          `UPDATE markets
              SET status='resolved', onchain_status='resolved', updated_at=now()
            WHERE id=$1 AND status='ready_to_resolve'`,
          [row.id],
        )
        succeeded++
        console.log(`  ✓ ${row.id.slice(0, 12)}… resolved ${row.outcome.toUpperCase()}`)
      } catch (error) {
        console.error(`  ✗ ${row.id.slice(0, 12)}… resolve failed: ${errorMessage(error)}`)
        abortBatchIfContextBroken(`resolve-v2 ${row.id.slice(0, 12)}`, error)
      }
    }
  } finally {
    await stopWalletSafely(walletCtx.wallet, 'resolve-v2')
  }
  return { selected: rows.length, succeeded }
}

export async function cancelRequestedV2(
  network: ReturnType<typeof resolveNetwork>,
  options: CancelOptions = {},
): Promise<KeeperWorkResult> {
  const dbUrl = requiredEnv('DATABASE_URL')
  const category = requiredKeeperCategory()
  const mode = options.mode ?? 'all'
  const configuredLimit = mode === 'empty'
    ? keeperBatchLimit('EMPTY_CANCEL_LIMIT', 2, 'KEEPER_MAX_EMPTY_CANCEL_LIMIT', 10)
    : keeperBatchLimit('CANCEL_LIMIT')
  const limit = options.limit == null
    ? configuredLimit
    : Math.min(configuredLimit, Math.max(1, Math.floor(options.limit)))
  const poolPredicate = mode === 'funded'
    ? `AND ${FUNDED_CANCEL_PREDICATE}`
    : mode === 'empty'
      ? `AND ${EMPTY_CANCEL_PREDICATE}`
      : ''
  await ensureV2MarketColumns(dbUrl)
  const deployment = await resolveDeploymentV2(network)

  const { rows } = await pgExec(
    dbUrl,
    `SELECT id
       FROM markets
      WHERE status = 'cancel_requested'
        AND onchain_tx_id IS NOT NULL
        AND onchain_contract_version = 'v2'
        AND onchain_contract_address = $2
        AND COALESCE(onchain_status, 'open') = 'open'
        AND category = $3
        ${poolPredicate}
      ORDER BY
        (COALESCE(onchain_yes_pool, 0::numeric)
          + COALESCE(onchain_no_pool, 0::numeric) > 0) DESC,
        updated_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit, deployment.contractAddress, category],
  )
  if (rows.length === 0) {
    console.log(`[cancel-v2:${mode}] no cancel_requested markets.`)
    return { selected: 0, succeeded: 0 }
  }

  console.log(`[cancel-v2:${mode}] cancelling ${rows.length} market(s) on-chain…`)
  let succeeded = 0
  const { deployed, walletCtx } = await connectKeeperV2(network)
  try {
    for (const row of rows as Array<{ id: string }>) {
      try {
        await withKeeperTransactionTimeout(
          `cancel_market ${row.id.slice(0, 12)}`,
          () => deployed.callTx.cancel_market(parseHexBytes(row.id, 32, 'market_id')),
        )
        await pgExec(
          dbUrl,
          `UPDATE markets
              SET status='cancelled', onchain_status='cancelled', updated_at=now()
            WHERE id=$1 AND status='cancel_requested'`,
          [row.id],
        )
        succeeded++
        console.log(`  ✓ ${row.id.slice(0, 12)}… cancelled`)
      } catch (error) {
        console.error(`  ✗ ${row.id.slice(0, 12)}… cancel failed: ${errorMessage(error)}`)
        abortBatchIfContextBroken(`cancel-v2 ${row.id.slice(0, 12)}`, error)
      }
    }
  } finally {
    await stopWalletSafely(walletCtx.wallet, 'cancel-v2')
  }
  return { selected: rows.length, succeeded }
}

async function main() {
  configureKeeperCategory(process.argv[3])
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  await resolveMarketsV2(network)
  await cancelRequestedV2(network)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
