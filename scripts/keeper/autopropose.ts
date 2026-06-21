// Keeper SERVICE (M6): batch-propose computed outcomes on-chain.
//
// Bridges the off-chain outcome computation (dataprovider/runResolve writes
// markets.outcome for objective markets) to the on-chain optimistic oracle. Scans
// closed, on-chain, still-OPEN markets with a computed outcome and proposes it.
// Finalize stays manual (`market finalize`) until the challenge window is mirrored.
//
//   npm run keeper:autopropose -- preprod
import { Outcome } from '../../src/managed/dareu/contract/index.js'
import {
  connectKeeper,
  loadEnvFiles,
  optionalEnv,
  parseHexBytes,
  pgExec,
  requiredEnv,
  resolveNetwork,
} from '../shared/chain.js'

export async function autoProposeResolutions(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const challengeSec = BigInt(optionalEnv('RESOLVE_CHALLENGE_SEC') ?? '3600')
  const limit = Number(optionalEnv('RESOLVE_LIMIT') ?? 20)
  const nowSec = BigInt(Math.floor(Date.now() / 1000))

  const { rows } = await pgExec(
    dbUrl,
    `SELECT id, outcome, EXTRACT(EPOCH FROM close_time)::bigint AS close_unix
       FROM markets
      WHERE onchain_tx_id IS NOT NULL
        AND close_time < now()
        AND outcome IN ('yes', 'no')
        AND COALESCE(onchain_status, 'open') = 'open'
      ORDER BY close_time ASC
      LIMIT $1`,
    [limit],
  )
  if (rows.length === 0) {
    console.log('No closed on-chain markets with a computed outcome to propose.')
    return
  }
  console.log(`Proposing ${rows.length} outcome(s) on-chain…`)

  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    for (const row of rows as Array<{ id: string; outcome: 'yes' | 'no'; close_unix: string }>) {
      try {
        // deadline must be >= close + challenge_window AND in the future.
        let deadline = BigInt(row.close_unix) + challengeSec
        if (deadline <= nowSec + 60n) deadline = nowSec + challengeSec
        const outcome = row.outcome === 'yes' ? Outcome.YES : Outcome.NO
        await deployed.callTx.propose_resolution(parseHexBytes(row.id, 32, 'market_id'), outcome, deadline)
        await pgExec(dbUrl, `UPDATE markets SET status='proposed', updated_at=now() WHERE id=$1`, [row.id])
        console.log(`  ✓ ${row.id.slice(0, 12)}… proposed ${row.outcome.toUpperCase()}`)
      } catch (err) {
        console.error(`  ✗ ${row.id.slice(0, 12)}… propose failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  } finally {
    await walletCtx.wallet.stop()
  }
}

async function main() {
  loadEnvFiles()
  await autoProposeResolutions(resolveNetwork(process.argv[2]))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
