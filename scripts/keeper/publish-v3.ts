// Keeper SERVICE: publish drafted markets on-chain — v3 contract.
//
// Publishes the direct-resolution V3 create_market ABI; only the connection layer differs:
// dareu-v3 assets + the hot OPERATOR key (create_market authorizes owner OR
// operator — D8 keeps the owner key off the keeper server).
//
//   npm run keeper:v3:publish -- preprod crypto
import {
  loadEnvFiles,
  parseHexBytes,
  pgExec,
  requiredEnv,
  resolveNetwork,
} from '../shared/chain.js'
import { connectKeeperV3, ensureV3MarketColumns, type KeeperV3Context, resolveDeploymentV3 } from '../shared/chain-v3.js'
import {
  clearWalletCanaryRequirement,
  walletRequiresCanary,
} from '../shared/midnight.js'
import {
  abortBatchIfWalletUnavailable,
  errorMessage,
  keeperBatchLimit,
  stopWalletSafely,
} from './reliability.js'
import { executeKeeperTransaction } from './transaction-executor.js'
import { configureKeeperCategory, requiredKeeperCategory } from './scope-v2.js'
import type { KeeperWorkResult } from './scheduling-v2.js'

type PublishOptions = {
  /** Bound one scheduler turn. The standalone CLI keeps using PUBLISH_LIMIT. */
  limit?: number
  /** Yield between transactions when settlement/refund work appears. */
  preemptForSettlement?: boolean
  /** Reuse the scheduler's one wallet/contract context for this whole cycle. */
  context?: KeeperV3Context
}

export function publishLimitForWallet(requestedLimit: number, canaryRequired: boolean): number {
  return canaryRequired ? 1 : requestedLimit
}

export const PRIORITY_MARKET_EXISTS_SQL = `SELECT EXISTS (
  SELECT 1
    FROM markets
   WHERE (
          status = 'ready_to_resolve'
          OR (
            status = 'cancel_requested'
            AND COALESCE(onchain_yes_pool, 0::numeric)
                + COALESCE(onchain_no_pool, 0::numeric) > 0
          )
         )
     AND onchain_tx_id IS NOT NULL
     AND onchain_contract_version = 'v3'
     AND onchain_contract_address = $1
     AND COALESCE(onchain_status, 'open') = 'open'
     AND category = $2
) AS has_priority_work`

async function hasPrioritySettlementWork(
  dbUrl: string,
  contractAddress: string,
  category: string,
): Promise<boolean> {
  const { rows } = await pgExec(
    dbUrl,
    PRIORITY_MARKET_EXISTS_SQL,
    [contractAddress, category],
  )
  return rows[0]?.has_priority_work === true
}

export async function publishDraftsV3(
  network: ReturnType<typeof resolveNetwork>,
  options: PublishOptions = {},
): Promise<KeeperWorkResult> {
  const dbUrl = requiredEnv('DATABASE_URL')
  const category = requiredKeeperCategory()
  // The standalone publish CLI may still drain a large configured batch. The
  // long-running scheduler passes a much smaller quantum so lifecycle work can
  // preempt creation between transactions. Wallet rotation below prevents one
  // websocket/UTXO context from living for hundreds of proofs.
  const configuredLimit = keeperBatchLimit('PUBLISH_LIMIT', 500, 'KEEPER_MAX_PUBLISH_LIMIT', 1000)
  let limit = options.limit == null
    ? configuredLimit
    : Math.min(configuredLimit, Math.max(1, Math.floor(options.limit)))
  const canaryRequired = walletRequiresCanary(network)
  if (canaryRequired) {
    limit = publishLimitForWallet(limit, true)
    console.warn('[publish-v3] wallet recovered by cold replay; limiting this run to one canary market.')
  }
  const sessionSize = options.context
    ? limit
    : Math.min(keeperBatchLimit('PUBLISH_SESSION_SIZE', 20), limit)
  const minLeadSec = keeperBatchLimit('PUBLISH_MIN_LEAD_SEC', 120, 'PUBLISH_MAX_MIN_LEAD_SEC', 3600)
  await ensureV3MarketColumns(dbUrl)
  const deployment = await resolveDeploymentV3(network)
  // Per-market params come from the PG draft row's mirror columns
  // (betting_cutoff / platform_fee_rate), written by the
  // dataprovider when it drafted the market — NEVER from env here (spec §6).
  const { rows } = await pgExec(
    dbUrl,
    `SELECT id, metadata_hash, oracle_participant_id,
            EXTRACT(EPOCH FROM close_time)::bigint AS close_unix,
            betting_cutoff, platform_fee_rate
       FROM markets
      WHERE onchain_tx_id IS NULL
        AND onchain_contract_version IS NULL
        AND onchain_contract_address IS NULL
        AND status IN ('draft', 'open')
        AND betting_cutoff IS NOT NULL
        AND platform_fee_rate IS NOT NULL
        AND close_time > now() + (betting_cutoff + $2::bigint) * interval '1 second'
        AND oracle_participant_id !~* '^(0x)?0+$'
        AND category = $3
      ORDER BY close_time ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit, minLeadSec, category],
  )
  if (rows.length === 0) {
    console.log('[publish-v3] no draft markets to publish.')
    return { selected: 0, succeeded: 0 }
  }
  console.log(
    `[publish-v3:${category}] publishing up to ${rows.length} market(s) on-chain ` +
      `(wallet session ${sessionSize}, minimum lead ${minLeadSec}s)…`,
  )

  let ok = 0
  let preempted = false
  type PublishRow = {
    id: string
    metadata_hash: string
    oracle_participant_id: string
    close_unix: string
    betting_cutoff: string | number
    platform_fee_rate: string | number
  }
  const publishRows = rows as PublishRow[]

  for (let offset = 0; offset < publishRows.length; offset += sessionSize) {
    const chunk = publishRows.slice(offset, offset + sessionSize)
    const sessionNumber = Math.floor(offset / sessionSize) + 1
    const sessionCount = Math.ceil(publishRows.length / sessionSize)
    console.log(`[publish-v3] wallet session ${sessionNumber}/${sessionCount}: ${chunk.length} market(s)`)

    if (
      options.preemptForSettlement &&
      await hasPrioritySettlementWork(dbUrl, deployment.contractAddress, category)
    ) {
      preempted = true
      console.log('[publish-v3] yielding before wallet start: funded settlement/refund work is waiting.')
      break
    }

    const context = options.context ?? await connectKeeperV3(network)
    const { deployed, walletCtx } = context
    try {
      for (const row of chunk) {
        // A proof/call already in flight cannot be cancelled safely. Check only
        // at transaction boundaries and let the outer scheduler settle first.
        if (
          options.preemptForSettlement &&
          await hasPrioritySettlementWork(dbUrl, deployment.contractAddress, category)
        ) {
          preempted = true
          console.log('[publish-v3] yielding at transaction boundary: funded settlement/refund work is waiting.')
          break
        }
        let confirmedOnChain = false
        let recordedInDatabase = false
        try {
          // A large backlog can take hours. Re-check the lead time immediately
          // before proving so an item selected at the start of the sweep cannot
          // become born-closed while waiting behind earlier proofs.
          const requiredLead = BigInt(row.betting_cutoff) + BigInt(minLeadSec)
          const remaining = BigInt(row.close_unix) - BigInt(Math.floor(Date.now() / 1000))
          if (remaining <= requiredLead) {
            console.log(
              `  ↷ ${row.id.slice(0, 12)}… skipped: only ${remaining}s before close ` +
                `(requires > ${requiredLead}s)`,
            )
            continue
          }

          const { txId } = await executeKeeperTransaction(
            walletCtx,
            network,
            `create_market ${row.id.slice(0, 12)}`,
            () => deployed.callTx.create_market(
              parseHexBytes(row.id, 32, 'market_id'),
              parseHexBytes(row.metadata_hash, 32, 'metadata_hash'),
              parseHexBytes(row.oracle_participant_id, 32, 'oracle'),
              BigInt(row.close_unix),
              BigInt(row.platform_fee_rate),
              BigInt(row.betting_cutoff),
            ),
          )
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          // The shared executor returns only after Indexer finalization and exact
          // wallet/DUST settlement, so every write path has the same barrier.
          confirmedOnChain = true
          await pgExec(
            dbUrl,
            `UPDATE markets SET status='open', onchain_tx_id=$2,
                    onchain_contract_version='v3', onchain_contract_address=$3,
                    onchain_status='open', onchain_yes_pool='0', onchain_no_pool='0',
                    onchain_outcome=NULL, synced_at=now(), updated_at=now()
              WHERE id=$1 AND status IN ('draft', 'open')`,
            [row.id, txId || 'onchain', deployment.contractAddress],
          )
          recordedInDatabase = true
          ok++
          console.log(`  ✓ ${row.id.slice(0, 12)}… published (tx ${txId ? txId.slice(0, 12) + '…' : '?'})`)

          if (canaryRequired) {
            clearWalletCanaryRequirement(network)
            console.log('[publish-v3] canary finalized and wallet settled; normal publish limits are restored.')
          }
        } catch (err) {
          const msg = errorMessage(err)
          if (confirmedOnChain) {
            console.error(
              `  ✗ ${row.id.slice(0, 12)}… is on-chain, but post-confirmation handling failed; ` +
                `${recordedInDatabase ? 'the market remains marked open' : 'the database will reconcile it on retry'} ` +
                `and this wallet session will be destroyed: ${msg}`,
            )
            throw err
          } else if (/Market already exists/i.test(msg)) {
            await pgExec(
              dbUrl,
              `UPDATE markets SET status='open', onchain_tx_id='onchain',
                      onchain_contract_version='v3', onchain_contract_address=$2,
                      updated_at=now() WHERE id=$1`,
              [row.id, deployment.contractAddress],
            )
            ok++
            console.log(`  • ${row.id.slice(0, 12)}… already on-chain — marked`)
          } else {
            console.error(`  ✗ ${row.id.slice(0, 12)}… failed (left as draft): ${msg}`)
            // A transport failure or InvalidDustSpendProof (Custom error 170)
            // invalidates the wallet's view of DUST/UTXOs. 170 is deliberately
            // fatal here: only the supervisor may retry it in a fresh process and
            // wallet context; this loop must never retry it in the same session.
            // Insufficient DUST is batch-wide, not market-specific. Stop after
            // the first failure instead of proving every remaining draft only
            // to hit the same wallet coin-selection error.
            abortBatchIfWalletUnavailable(`publish-v3 ${row.id.slice(0, 12)}`, err)
          }
        }
      }
    } finally {
      // Preserve the latest DUST/shielded progress so the next session performs
      // only a short incremental sync, not a full wallet replay.
      try {
        await walletCtx.saveState()
      } catch (error) {
        console.warn(`[publish-v3] wallet cache save failed: ${errorMessage(error)}`)
      }
      if (!options.context) {
        await stopWalletSafely(walletCtx.wallet, `publish-v3 session ${sessionNumber}`)
      }
    }
    if (preempted) break
  }
  console.log(
    `[publish-v3] done. ${ok}/${rows.length} published` +
      `${preempted ? '; yielded to funded settlement/refund work.' : '.'}`,
  )
  return { selected: rows.length, succeeded: ok, preempted }
}

async function main() {
  configureKeeperCategory(process.argv[3])
  loadEnvFiles()
  await publishDraftsV3(resolveNetwork(process.argv[2]))
}

// Run as a CLI unless imported by the scheduler (run-v3.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
