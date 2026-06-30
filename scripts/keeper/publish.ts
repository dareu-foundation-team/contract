// Keeper SERVICE (M2): publish drafted markets on-chain.
//
// Reads markets the DataProvider drafted in Postgres and publishes the ones not yet
// on-chain via the already-deployed `create_market` circuit. On success the row is
// flipped to status='open' + onchain_tx_id (what the webapp gates betting on).
// Holds the owner key + needs the proof server — runs on a server, NOT locally.
//
//   npm run keeper:publish -- preprod
import {
  connectKeeper,
  loadEnvFiles,
  optionalEnv,
  parseHexBytes,
  pgExec,
  requiredEnv,
  resolveNetwork,
} from '../shared/chain.js'

export async function publishDrafts(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const limit = Number(optionalEnv('PUBLISH_LIMIT') ?? 20)
  // 🔴 Per-market params come from the PG draft row's mirror columns
  // (challenge_window / betting_cutoff / platform_fee_rate), written by the
  // dataprovider when it drafted the market — NEVER from env here (spec §6:
  // env is only read by the dataprovider's buildRow and admin/market.ts).
  // WHERE forces them IS NOT NULL so we never publish a half-drafted market.
  const { rows } = await pgExec(
    dbUrl,
    `SELECT id, metadata_hash, oracle_participant_id,
            EXTRACT(EPOCH FROM close_time)::bigint AS close_unix,
            challenge_window, betting_cutoff, platform_fee_rate
       FROM markets
      WHERE onchain_tx_id IS NULL
        AND status IN ('draft', 'open')
        AND close_time > now()
        AND challenge_window IS NOT NULL
        AND betting_cutoff IS NOT NULL
        AND platform_fee_rate IS NOT NULL
        -- Skip empty/all-zero oracle markets: create_market rejects them with
        -- "Oracle cannot be empty" (legacy seeds drafted before INGEST_ORACLE_HEX).
        AND oracle_participant_id !~* '^(0x)?0+$'
      ORDER BY close_time ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  )
  if (rows.length === 0) {
    console.log('No draft markets to publish.')
    return
  }
  console.log(`Publishing ${rows.length} market(s) on-chain…`)

  const { deployed, walletCtx } = await connectKeeper(network)
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
        // Per-market operational config: read from the draft row's mirror columns.
        const challengeWindow = BigInt(row.challenge_window)
        const bettingCutoff = BigInt(row.betting_cutoff)
        const platformFeeBps = BigInt(row.platform_fee_rate)
        const result = await deployed.callTx.create_market(
          parseHexBytes(row.id, 32, 'market_id'),
          parseHexBytes(row.metadata_hash, 32, 'metadata_hash'),
          parseHexBytes(row.oracle_participant_id, 32, 'oracle'),
          BigInt(row.close_unix),
          challengeWindow,
          platformFeeBps,
          bettingCutoff,
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = result as any
        const txId: string = r?.public?.txId ?? r?.txId ?? r?.finalizedTxData?.txId ?? ''
        await pgExec(
          dbUrl,
          `UPDATE markets SET status='open', onchain_tx_id=$2, updated_at=now()
            WHERE id=$1 AND status IN ('draft', 'open')`,
          [row.id, txId || 'onchain'],
        )
        ok++
        console.log(`  ✓ ${row.id.slice(0, 12)}… published (tx ${txId ? txId.slice(0, 12) + '…' : '?'})`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/Market already exists/i.test(msg)) {
          await pgExec(
            dbUrl,
            `UPDATE markets SET status='open', onchain_tx_id=COALESCE(onchain_tx_id, 'onchain'), updated_at=now() WHERE id=$1`,
            [row.id],
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
  console.log(`Done. ${ok}/${rows.length} published.`)
}

async function main() {
  loadEnvFiles()
  await publishDrafts(resolveNetwork(process.argv[2]))
}

// Run as a CLI unless imported by the scheduler (run.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
