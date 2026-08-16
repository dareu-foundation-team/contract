// Keeper SERVICE: publish drafted markets on-chain — v2 contract.
//
// Publishes the direct-resolution V2 create_market ABI; only the connection layer differs:
// dareu-v2 assets + the hot OPERATOR key (create_market authorizes owner OR
// operator — D8 keeps the owner key off the keeper server).
//
//   npm run keeper:v2:publish -- preprod crypto
import {
  loadEnvFiles,
  parseHexBytes,
  pgExec,
  requiredEnv,
  resolveNetwork,
} from '../shared/chain.js'
import { connectKeeperV2, ensureV2MarketColumns, resolveDeploymentV2 } from '../shared/chain-v2.js'
import {
  captureWalletTransactionCheckpoint,
  waitForWalletTransactionSettlement,
} from '../shared/midnight.js'
import {
  abortBatchIfWalletUnavailable,
  errorMessage,
  KeeperContextBrokenError,
  keeperBatchLimit,
  stopWalletSafely,
  withKeeperTransactionTimeout,
} from './reliability.js'
import { configureKeeperCategory, requiredKeeperCategory } from './scope-v2.js'
import type { KeeperWorkResult } from './scheduling-v2.js'

type PublishOptions = {
  /** Bound one scheduler turn. The standalone CLI keeps using PUBLISH_LIMIT. */
  limit?: number
  /** Yield between transactions when settlement/refund work appears. */
  preemptForSettlement?: boolean
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
     AND onchain_contract_version = 'v2'
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

export async function publishDraftsV2(
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
  const limit = options.limit == null
    ? configuredLimit
    : Math.min(configuredLimit, Math.max(1, Math.floor(options.limit)))
  const sessionSize = Math.min(keeperBatchLimit('PUBLISH_SESSION_SIZE', 20), limit)
  const minLeadSec = keeperBatchLimit('PUBLISH_MIN_LEAD_SEC', 120, 'PUBLISH_MAX_MIN_LEAD_SEC', 3600)
  await ensureV2MarketColumns(dbUrl)
  const deployment = await resolveDeploymentV2(network)
  // Per-market params come from the PG draft row's mirror columns
  // (betting_cutoff / platform_fee_rate), written by the
  // dataprovider when it drafted the market — NEVER from env here (spec §6).
  const { rows } = await pgExec(
    dbUrl,
    `SELECT id, metadata_hash, oracle_participant_id,
            EXTRACT(EPOCH FROM close_time)::bigint AS close_unix,
            betting_cutoff, platform_fee_rate
       FROM markets
      WHERE (onchain_tx_id IS NULL
             OR onchain_contract_version IS DISTINCT FROM 'v2'
             OR onchain_contract_address IS DISTINCT FROM $2)
        AND status IN ('draft', 'open')
        AND betting_cutoff IS NOT NULL
        AND platform_fee_rate IS NOT NULL
        AND close_time > now() + (betting_cutoff + $3::bigint) * interval '1 second'
        AND oracle_participant_id !~* '^(0x)?0+$'
        AND category = $4
      ORDER BY close_time ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit, deployment.contractAddress, minLeadSec, category],
  )
  if (rows.length === 0) {
    console.log('[publish-v2] no draft markets to publish.')
    return { selected: 0, succeeded: 0 }
  }
  console.log(
    `[publish-v2:${category}] publishing up to ${rows.length} market(s) on-chain ` +
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
    console.log(`[publish-v2] wallet session ${sessionNumber}/${sessionCount}: ${chunk.length} market(s)`)

    if (
      options.preemptForSettlement &&
      await hasPrioritySettlementWork(dbUrl, deployment.contractAddress, category)
    ) {
      preempted = true
      console.log('[publish-v2] yielding before wallet start: funded settlement/refund work is waiting.')
      break
    }

    const { deployed, walletCtx } = await connectKeeperV2(network)
    try {
      for (const row of chunk) {
        // A proof/call already in flight cannot be cancelled safely. Check only
        // at transaction boundaries and let the outer scheduler settle first.
        if (
          options.preemptForSettlement &&
          await hasPrioritySettlementWork(dbUrl, deployment.contractAddress, category)
        ) {
          preempted = true
          console.log('[publish-v2] yielding at transaction boundary: funded settlement/refund work is waiting.')
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

          const walletCheckpoint = await captureWalletTransactionCheckpoint(walletCtx.wallet)
          const result = await withKeeperTransactionTimeout(
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
          const r = result as any
          const txId: string = r?.public?.txId ?? r?.txId ?? r?.finalizedTxData?.txId ?? ''
          // callTx is blocking and returns only after Indexer finalization. From
          // this point on, any local DB/barrier failure must destroy the session:
          // proceeding would build the next proof from an unconfirmed wallet view.
          confirmedOnChain = true
          await pgExec(
            dbUrl,
            `UPDATE markets SET status='open', onchain_tx_id=$2,
                    onchain_contract_version='v2', onchain_contract_address=$3,
                    onchain_status='open', onchain_yes_pool='0', onchain_no_pool='0',
                    onchain_outcome=NULL, synced_at=now(), updated_at=now()
              WHERE id=$1 AND status IN ('draft', 'open')`,
            [row.id, txId || 'onchain', deployment.contractAddress],
          )
          recordedInDatabase = true
          ok++
          console.log(`  ✓ ${row.id.slice(0, 12)}… published (tx ${txId ? txId.slice(0, 12) + '…' : '?'})`)

          // callTx returns only after the Indexer has finalized the transaction,
          // but the wallet's DUST stream and pending service can still lag that
          // observation. Never build the next proof until both have caught up.
          try {
            await withKeeperTransactionTimeout(
              `post-transaction wallet sync ${row.id.slice(0, 12)}`,
              () => waitForWalletTransactionSettlement(
                walletCtx.wallet,
                txId,
                walletCheckpoint,
              ),
            )
            await walletCtx.saveState()
          } catch (error) {
            throw new KeeperContextBrokenError(
              `post-transaction wallet sync ${row.id.slice(0, 12)}`,
              error,
            )
          }
        } catch (err) {
          const msg = errorMessage(err)
          if (confirmedOnChain) {
            console.error(
              `  ✗ ${row.id.slice(0, 12)}… is on-chain, but post-confirmation handling failed; ` +
                `${recordedInDatabase ? 'the market remains marked open' : 'the database will reconcile it on retry'} ` +
                `and this wallet session will be destroyed: ${msg}`,
            )
            if (err instanceof KeeperContextBrokenError) throw err
            throw new KeeperContextBrokenError(
              `post-confirmation handling ${row.id.slice(0, 12)}`,
              err,
            )
          } else if (/Market already exists/i.test(msg)) {
            await pgExec(
              dbUrl,
              `UPDATE markets SET status='open', onchain_tx_id='onchain',
                      onchain_contract_version='v2', onchain_contract_address=$2,
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
            abortBatchIfWalletUnavailable(`publish-v2 ${row.id.slice(0, 12)}`, err)
          }
        }
      }
    } finally {
      // Preserve the latest DUST/shielded progress so the next session performs
      // only a short incremental sync, not a full wallet replay.
      try {
        await walletCtx.saveState()
      } catch (error) {
        console.warn(`[publish-v2] wallet cache save failed: ${errorMessage(error)}`)
      }
      await stopWalletSafely(walletCtx.wallet, `publish-v2 session ${sessionNumber}`)
    }
    if (preempted) break
  }
  console.log(
    `[publish-v2] done. ${ok}/${rows.length} published` +
      `${preempted ? '; yielded to funded settlement/refund work.' : '.'}`,
  )
  return { selected: rows.length, succeeded: ok, preempted }
}

async function main() {
  configureKeeperCategory(process.argv[3])
  loadEnvFiles()
  await publishDraftsV2(resolveNetwork(process.argv[2]))
}

// Run as a CLI unless imported by the scheduler (run-v2.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
