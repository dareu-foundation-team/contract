// Keeper SERVICE: publish drafted markets on-chain — v2 contract.
//
// Identical Postgres contract and circuit signature to publish.ts (v1 and v2
// create_market take the same seven args); only the connection layer differs:
// dareu-v2 assets + the hot OPERATOR key (create_market authorizes owner OR
// operator — D8 keeps the owner key off the keeper server).
//
//   npm run keeper:v2:publish -- preprod
import {
  loadEnvFiles,
  optionalEnv,
  parseHexBytes,
  pgExec,
  requiredEnv,
  resolveNetwork,
} from '../shared/chain.js'
import { connectKeeperV2, ensureV2MarketColumns, resolveDeploymentV2 } from '../shared/chain-v2.js'

export async function publishDraftsV2(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const limit = Number(optionalEnv('PUBLISH_LIMIT') ?? 20)
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
        AND close_time > now()
        AND challenge_window IS NOT NULL
        AND betting_cutoff IS NOT NULL
        AND platform_fee_rate IS NOT NULL
        AND oracle_participant_id !~* '^(0x)?0+$'
      ORDER BY close_time ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit, deployment.contractAddress],
  )
  if (rows.length === 0) {
    console.log('[publish-v2] no draft markets to publish.')
    return
  }
  console.log(`[publish-v2] publishing ${rows.length} market(s) on-chain…`)

  const { deployed, walletCtx } = await connectKeeperV2(network)
  let ok = 0
  try {
    for (const row of rows as Array<{
      id: string
      metadata_hash: string
      oracle_participant_id: string
      close_unix: string
      challenge_window: string | number
      betting_cutoff: string | number
      platform_fee_rate: string | number
    }>) {
      try {
        const result = await deployed.callTx.create_market(
          parseHexBytes(row.id, 32, 'market_id'),
          parseHexBytes(row.metadata_hash, 32, 'metadata_hash'),
          parseHexBytes(row.oracle_participant_id, 32, 'oracle'),
          BigInt(row.close_unix),
          BigInt(row.challenge_window),
          BigInt(row.platform_fee_rate),
          BigInt(row.betting_cutoff),
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
        const msg = err instanceof Error ? err.message : String(err)
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
        }
      }
    }
  } finally {
    await walletCtx.wallet.stop()
  }
  console.log(`[publish-v2] done. ${ok}/${rows.length} published.`)
}

async function main() {
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
