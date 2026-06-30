// Keeper SERVICE: optimistic-oracle loops (propose / finalize / cancel / stuck-cancel).
//
// Bridges the off-chain outcome computation (dataprovider/runResolve writes
// markets.outcome + status='ready_to_propose'|'manual_review'|'cancel_requested')
// to the on-chain optimistic oracle, and drives every market to a terminal PG
// state so users can claim/refund. Holds the owner key + needs the proof server.
//
//   npm run keeper:autopropose -- preprod
//
// 🔴 Concurrency/idempotency (spec §4 preamble):
//   - every PG status write is conditional (`WHERE status = <expected>`);
//   - batch selects use `FOR UPDATE SKIP LOCKED` so two keepers / retries don't
//     double-submit the same on-chain tx;
//   - resolutions writes use `ON CONFLICT (market_id) DO UPDATE`;
//   - on-chain state is mirrored (sync) before these loops in run.ts, and the
//     `COALESCE(onchain_status,...)` guards skip rows already advanced on-chain.
import { Outcome } from '../../src/managed/dareu/contract/index.js'
import {
  connectKeeper,
  loadEnvFiles,
  optionalEnv,
  parseHexBytes,
  pgExec,
  pgTx,
  requiredEnv,
  resolveNetwork,
} from '../shared/chain.js'

function txIdOf(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = result as any
  return r?.public?.txId ?? r?.txId ?? r?.finalizedTxData?.txId ?? ''
}

// ===== 4C. propose loop =====
// ready_to_propose markets (real winner guaranteed upstream: zero-winner was
// flipped to cancel_requested before propose) → propose_resolution on-chain →
// sync three places (markets.status, onchain_status, upsert resolutions).
export async function autoProposeResolutions(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const limit = Number(optionalEnv('RESOLVE_LIMIT') ?? 20)
  const nowSec = BigInt(Math.floor(Date.now() / 1000))

  const { rows } = await pgExec(
    dbUrl,
    `SELECT id, outcome, challenge_window,
            EXTRACT(EPOCH FROM close_time)::bigint AS close_unix
       FROM markets
      WHERE status = 'ready_to_propose'
        AND onchain_tx_id IS NOT NULL
        AND COALESCE(onchain_status, 'open') = 'open'
        AND outcome IN ('yes', 'no')
        AND challenge_window IS NOT NULL
      ORDER BY close_time ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  )
  if (rows.length === 0) {
    console.log('[propose] no ready_to_propose markets.')
    return
  }
  console.log(`[propose] proposing ${rows.length} outcome(s) on-chain…`)

  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    for (const row of rows as Array<{
      id: string
      outcome: 'yes' | 'no'
      challenge_window: string | number
      close_unix: string
    }>) {
      try {
        const challengeSec = BigInt(row.challenge_window)
        // propose happens after close, so this is ≈ now + window; max() keeps it
        // ≥ close + window and guards local-clock / boundary issues.
        const base = nowSec > BigInt(row.close_unix) ? nowSec : BigInt(row.close_unix)
        const deadline = base + challengeSec
        const outcome = row.outcome === 'yes' ? Outcome.YES : Outcome.NO
        // keeper does NOT recompute outcome — trusts markets.outcome from runResolve.
        await deployed.callTx.propose_resolution(parseHexBytes(row.id, 32, 'market_id'), outcome, deadline)

        // Sync three places in one transaction (markets + onchain_status + resolutions).
        const deadlineIso = new Date(Number(deadline) * 1000).toISOString()
        await pgTx(dbUrl, async (c) => {
          await c.query(
            `UPDATE markets SET status='proposed', onchain_status='proposed', updated_at=now()
              WHERE id=$1 AND status='ready_to_propose'`,
            [row.id],
          )
          await c.query(
            `INSERT INTO resolutions
               (market_id, proposer, proposed_outcome, propose_deadline, bond, settlement_detail, status)
             SELECT id, 'keeper', outcome, $2::timestamptz, 0, settlement_detail, 'proposed'
               FROM markets WHERE id=$1
             ON CONFLICT (market_id) DO UPDATE SET
               proposer='keeper', proposed_outcome=EXCLUDED.proposed_outcome,
               propose_deadline=EXCLUDED.propose_deadline,
               settlement_detail=EXCLUDED.settlement_detail,
               status='proposed', updated_at=now()`,
            [row.id, deadlineIso],
          )
        })
        console.log(`  ✓ ${row.id.slice(0, 12)}… proposed ${row.outcome.toUpperCase()} (deadline ${deadlineIso})`)
      } catch (err) {
        console.error(`  ✗ ${row.id.slice(0, 12)}… propose failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  } finally {
    await walletCtx.wallet.stop()
  }
}

// ===== 4C-2. finalize loop =====
// proposed resolutions whose challenge window elapsed (and NOT disputed) →
// finalize_proposal on-chain → markets/resolutions='resolved' + onchain_status.
export async function finalizeProposals(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const limit = Number(optionalEnv('FINALIZE_LIMIT') ?? 20)

  const { rows } = await pgExec(
    dbUrl,
    `SELECT m.id
       FROM resolutions r
       JOIN markets m ON m.id = r.market_id
      WHERE r.status = 'proposed'
        AND r.propose_deadline < now()
        AND m.status = 'proposed'
        AND m.onchain_tx_id IS NOT NULL
        AND COALESCE(m.onchain_status, 'proposed') = 'proposed'
      ORDER BY r.propose_deadline ASC
      LIMIT $1
      FOR UPDATE OF r SKIP LOCKED`,
    [limit],
  )
  if (rows.length === 0) {
    console.log('[finalize] no proposals past challenge window.')
    return
  }
  console.log(`[finalize] finalizing ${rows.length} proposal(s) on-chain…`)

  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    for (const row of rows as Array<{ id: string }>) {
      try {
        await deployed.callTx.finalize_proposal(parseHexBytes(row.id, 32, 'market_id'))
        await pgTx(dbUrl, async (c) => {
          await c.query(
            `UPDATE markets SET status='resolved', onchain_status='resolved', updated_at=now()
              WHERE id=$1 AND status='proposed'`,
            [row.id],
          )
          await c.query(
            `UPDATE resolutions SET status='resolved', updated_at=now()
              WHERE market_id=$1 AND status='proposed'`,
            [row.id],
          )
        })
        console.log(`  ✓ ${row.id.slice(0, 12)}… finalized → resolved`)
      } catch (err) {
        console.error(`  ✗ ${row.id.slice(0, 12)}… finalize failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  } finally {
    await walletCtx.wallet.stop()
  }
}

// ===== 4C-3. cancel loop =====
// cancel_requested markets still OPEN on-chain → cancel_market → cancelled.
export async function cancelRequested(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const limit = Number(optionalEnv('CANCEL_LIMIT') ?? 20)

  const { rows } = await pgExec(
    dbUrl,
    `SELECT id
       FROM markets
      WHERE status = 'cancel_requested'
        AND onchain_tx_id IS NOT NULL
        AND COALESCE(onchain_status, 'open') = 'open'
      ORDER BY updated_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  )
  if (rows.length === 0) {
    console.log('[cancel] no cancel_requested markets to cancel.')
    return
  }
  console.log(`[cancel] cancelling ${rows.length} market(s) on-chain…`)

  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    for (const row of rows as Array<{ id: string }>) {
      try {
        await deployed.callTx.cancel_market(parseHexBytes(row.id, 32, 'market_id'))
        await pgExec(
          dbUrl,
          `UPDATE markets SET status='cancelled', onchain_status='cancelled', updated_at=now()
            WHERE id=$1 AND status='cancel_requested'`,
          [row.id],
        )
        console.log(`  ✓ ${row.id.slice(0, 12)}… cancelled`)
      } catch (err) {
        console.error(`  ✗ ${row.id.slice(0, 12)}… cancel failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  } finally {
    await walletCtx.wallet.stop()
  }
}

// ===== 4C-4. stuck-cancel after grace =====
// proposed/disputed markets stuck past propose_deadline + challenge_window grace
// (can't finalize / arbitration deadlocked) → cancel_market → cancelled.
export async function cancelStuck(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const limit = Number(optionalEnv('STUCK_CANCEL_LIMIT') ?? 20)

  const { rows } = await pgExec(
    dbUrl,
    `SELECT m.id
       FROM markets m
       JOIN resolutions r ON r.market_id = m.id
      WHERE m.status IN ('proposed', 'disputed')
        AND r.status IN ('proposed', 'disputed')
        AND m.onchain_tx_id IS NOT NULL
        AND m.challenge_window IS NOT NULL
        AND COALESCE(m.onchain_status, m.status) IN ('proposed', 'disputed')
        AND now() > r.propose_deadline + (m.challenge_window || ' seconds')::interval
      ORDER BY r.propose_deadline ASC
      LIMIT $1
      FOR UPDATE OF m SKIP LOCKED`,
    [limit],
  )
  if (rows.length === 0) {
    console.log('[stuck-cancel] no stuck proposed/disputed markets.')
    return
  }
  console.log(`[stuck-cancel] cancelling ${rows.length} stuck market(s) on-chain…`)

  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    for (const row of rows as Array<{ id: string }>) {
      try {
        await deployed.callTx.cancel_market(parseHexBytes(row.id, 32, 'market_id'))
        await pgTx(dbUrl, async (c) => {
          await c.query(
            `UPDATE markets SET status='cancelled', onchain_status='cancelled', updated_at=now()
              WHERE id=$1 AND status IN ('proposed', 'disputed')`,
            [row.id],
          )
          await c.query(
            `UPDATE resolutions SET status='cancelled', updated_at=now()
              WHERE market_id=$1 AND status IN ('proposed', 'disputed')`,
            [row.id],
          )
        })
        console.log(`  ✓ ${row.id.slice(0, 12)}… stuck → cancelled`)
      } catch (err) {
        console.error(`  ✗ ${row.id.slice(0, 12)}… stuck-cancel failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  } finally {
    await walletCtx.wallet.stop()
  }
}

async function main() {
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  // Run all optimistic-oracle loops once (run.ts schedules them on a cycle).
  await autoProposeResolutions(network)
  await finalizeProposals(network)
  await cancelRequested(network)
  await cancelStuck(network)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
