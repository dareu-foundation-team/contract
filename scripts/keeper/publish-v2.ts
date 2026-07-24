// Keeper SERVICE: publish drafted markets on-chain — v2 contract.
//
// Identical Postgres contract and circuit signature to publish.ts (v1 and v2
// create_market take the same seven args); only the connection layer differs:
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
  abortBatchIfContextBroken,
  errorMessage,
  keeperBatchLimit,
  stopWalletSafely,
  withKeeperTransactionTimeout,
} from './reliability.js'
import { configureKeeperCategory, requiredKeeperCategory } from './scope-v2.js'

export async function publishDraftsV2(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const category = requiredKeeperCategory()
  // Total work per keeper cycle is intentionally large so a backlog drains
  // continuously. The wallet is rotated every `sessionSize` transactions below,
  // which avoids one websocket/UTXO context living for hundreds of proofs.
  const limit = keeperBatchLimit('PUBLISH_LIMIT', 500, 'KEEPER_MAX_PUBLISH_LIMIT', 1000)
  const sessionSize = keeperBatchLimit('PUBLISH_SESSION_SIZE', 20)
  const minLeadSec = keeperBatchLimit('PUBLISH_MIN_LEAD_SEC', 120, 'PUBLISH_MAX_MIN_LEAD_SEC', 3600)
  await ensureV2MarketColumns(dbUrl)
  const deployment = await resolveDeploymentV2(network)
  // 🔴 Per-market params come from the PG draft row's mirror columns
  // (challenge_window / betting_cutoff / platform_fee_rate), written by the
  // dataprovider when it drafted the market — NEVER from env here (spec §6).
  const { rows } = await pgExec(
    dbUrl,
    `SELECT id, metadata_hash, oracle_participant_id,
            EXTRACT(EPOCH FROM close_time)::bigint AS close_unix,
            challenge_window, betting_cutoff, platform_fee_rate
       FROM markets
      WHERE (onchain_tx_id IS NULL
             OR onchain_contract_version IS DISTINCT FROM 'v2'
             OR onchain_contract_address IS DISTINCT FROM $2)
        AND status IN ('draft', 'open')
        AND challenge_window IS NOT NULL
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
    return
  }
  console.log(
    `[publish-v2:${category}] publishing up to ${rows.length} market(s) on-chain ` +
      `(wallet session ${sessionSize}, minimum lead ${minLeadSec}s)…`,
  )

  let ok = 0
  type PublishRow = {
    id: string
    metadata_hash: string
    oracle_participant_id: string
    close_unix: string
    challenge_window: string | number
    betting_cutoff: string | number
    platform_fee_rate: string | number
  }
  const publishRows = rows as PublishRow[]

  for (let offset = 0; offset < publishRows.length; offset += sessionSize) {
    const chunk = publishRows.slice(offset, offset + sessionSize)
    const sessionNumber = Math.floor(offset / sessionSize) + 1
    const sessionCount = Math.ceil(publishRows.length / sessionSize)
    console.log(`[publish-v2] wallet session ${sessionNumber}/${sessionCount}: ${chunk.length} market(s)`)

    const { deployed, walletCtx } = await connectKeeperV2(network)
    try {
      for (const row of chunk) {
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

          const result = await withKeeperTransactionTimeout(
            `create_market ${row.id.slice(0, 12)}`,
            () => deployed.callTx.create_market(
              parseHexBytes(row.id, 32, 'market_id'),
              parseHexBytes(row.metadata_hash, 32, 'metadata_hash'),
              parseHexBytes(row.oracle_participant_id, 32, 'oracle'),
              BigInt(row.close_unix),
              BigInt(row.challenge_window),
              BigInt(row.platform_fee_rate),
              BigInt(row.betting_cutoff),
            ),
          )
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = result as any
          const txId: string = r?.public?.txId ?? r?.txId ?? r?.finalizedTxData?.txId ?? ''
          await pgExec(
            dbUrl,
            `UPDATE markets SET status='open', onchain_tx_id=$2,
                    onchain_contract_version='v2', onchain_contract_address=$3,
                    onchain_status='open', onchain_yes_pool='0', onchain_no_pool='0',
                    onchain_outcome=NULL, synced_at=now(), updated_at=now()
              WHERE id=$1 AND status IN ('draft', 'open')`,
            [row.id, txId || 'onchain', deployment.contractAddress],
          )
          ok++
          console.log(`  ✓ ${row.id.slice(0, 12)}… published (tx ${txId ? txId.slice(0, 12) + '…' : '?'})`)
        } catch (err) {
          const msg = errorMessage(err)
          if (/Market already exists/i.test(msg)) {
            await pgExec(
              dbUrl,
              `UPDATE markets SET status='open', onchain_tx_id='onchain',
                      onchain_contract_version='v2', onchain_contract_address=$2,
                      updated_at=now() WHERE id=$1`,
              [row.id, deployment.contractAddress],
            )
            console.log(`  • ${row.id.slice(0, 12)}… already on-chain — marked`)
          } else {
            console.error(`  ✗ ${row.id.slice(0, 12)}… failed (left as draft): ${msg}`)
            // A transport failure invalidates the wallet's view of DUST/UTXOs.
            // Abort this session instead of poisoning every remaining row.
            abortBatchIfContextBroken(`publish-v2 ${row.id.slice(0, 12)}`, err)
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
  }
  console.log(`[publish-v2] done. ${ok}/${rows.length} published.`)
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
