// Keeper SERVICE: v2 optimistic-oracle loops (propose / finalize / cancel /
// stuck-cancel) against the dareu-v2 contract.
//
// Same Postgres contract as the v1 loops in autopropose.ts (the DataProvider's
// runResolve is chain-version agnostic: it only writes markets.outcome +
// status='ready_to_propose'|'manual_review'|'cancel_requested'). What differs is
// the on-chain side (spec: README-DareU-V2 §10):
//   - propose_resolution escrows an sNIGHT bond coin (received + burned on-chain,
//     re-minted to our refund pk on finalize) — see ensureSnightBondCoin;
//   - the keeper signs with the hot OPERATOR key, not the owner key (D8);
//   - finalize_proposal is permissionless and refunds the proposer bond.
//
// 🔴 Concurrency/idempotency: identical to v1 — conditional PG writes,
// FOR UPDATE SKIP LOCKED batches, ON CONFLICT upserts, sync-first in run-v2.ts.
import { Outcome } from '../../src/managed/dareu-v2/contract/index.js'
import {
  loadEnvFiles,
  optionalEnv,
  parseHexBytes,
  pgExec,
  pgTx,
  requiredEnv,
  resolveNetwork,
} from '../shared/chain.js'
import {
  connectKeeperV2,
  ensureV2MarketColumns,
  ensureSnightBondCoin,
  keeperCoinPublicKey,
  readV2Ledger,
  resolveDeploymentV2,
  type KeeperV2Context,
} from '../shared/chain-v2.js'

// The contract accepts an anchor less than one hour ahead of the applying block.
// Fifteen minutes leaves room for proof generation / submission without letting a
// caller create an unbounded proposal deadline.  This is deliberately recomputed
// only after the bond coin is ready, immediately before callTx.
const PROPOSAL_DEADLINE_BUFFER_SEC = 15n * 60n

// ===== propose loop =====
// ready_to_propose markets → escrow an sNIGHT bond + propose_resolution on-chain →
// sync three places (markets.status, onchain_status, upsert resolutions).
export async function autoProposeResolutionsV2(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const limit = Number(optionalEnv('RESOLVE_LIMIT') ?? 20)
  await ensureV2MarketColumns(dbUrl)
  const deployment = await resolveDeploymentV2(network)

  const { rows } = await pgExec(
    dbUrl,
    `SELECT id, outcome, challenge_window
       FROM markets
      WHERE status = 'ready_to_propose'
        AND onchain_tx_id IS NOT NULL
        AND onchain_contract_version = 'v2'
        AND onchain_contract_address = $2
        AND COALESCE(onchain_status, 'open') = 'open'
        AND outcome IN ('yes', 'no')
        AND challenge_window IS NOT NULL
      ORDER BY close_time ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit, deployment.contractAddress],
  )
  if (rows.length === 0) {
    console.log('[propose-v2] no ready_to_propose markets.')
    return
  }

  // resolution_bond is deploy-time immutable (no setters in the contract), so one
  // indexer read per batch is authoritative for every market in it.
  const led = await readV2Ledger(network)
  if (!led) {
    console.log('[propose-v2] v2 contract state not on the indexer yet — skipping.')
    return
  }
  const bond = led.resolution_bond
  console.log(`[propose-v2] proposing ${rows.length} outcome(s) on-chain (bond ${bond} sNIGHT each)…`)

  const ctx: KeeperV2Context = await connectKeeperV2(network)
  const refundPk = await keeperCoinPublicKey(ctx.walletCtx)
  const usedNonces = new Set<string>()
  try {
    for (const row of rows as Array<{
      id: string
      outcome: 'yes' | 'no'
      challenge_window: string | number
    }>) {
      try {
        const challengeSec = BigInt(row.challenge_window)
        const outcome = row.outcome === 'yes' ? Outcome.YES : Outcome.NO

        // Bond first: if we can't fund it, fail THIS market before any tx.
        const bondCoin = await ensureSnightBondCoin(ctx, bond, usedNonces)

        // Bond preparation may itself submit/sync wallet transactions.  Computing
        // this before ensureSnightBondCoin can consume most or all of the challenge
        // window while that work runs.  Re-anchor to the current wall clock here;
        // the contract then verifies this anchor against the actual applying block.
        const proposalNowSec = BigInt(Math.floor(Date.now() / 1000))
        const deadline = proposalNowSec + challengeSec + PROPOSAL_DEADLINE_BUFFER_SEC

        // keeper does NOT recompute outcome — trusts markets.outcome from runResolve.
        await ctx.deployed.callTx.propose_resolution(
          parseHexBytes(row.id, 32, 'market_id'),
          outcome,
          deadline,
          bondCoin,
          refundPk,
        )

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
             SELECT id, 'keeper', outcome, $2::timestamptz, $3, settlement_detail, 'proposed'
               FROM markets WHERE id=$1
             ON CONFLICT (market_id) DO UPDATE SET
               proposer='keeper', proposed_outcome=EXCLUDED.proposed_outcome,
               propose_deadline=EXCLUDED.propose_deadline,
               bond=EXCLUDED.bond,
               settlement_detail=EXCLUDED.settlement_detail,
               status='proposed', updated_at=now()`,
            [row.id, deadlineIso, bond.toString()],
          )
        })
        console.log(`  ✓ ${row.id.slice(0, 12)}… proposed ${row.outcome.toUpperCase()} (deadline ${deadlineIso})`)
      } catch (err) {
        console.error(`  ✗ ${row.id.slice(0, 12)}… propose failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  } finally {
    await ctx.walletCtx.wallet.stop()
  }
}

// ===== finalize loop =====
// proposed resolutions whose challenge window elapsed (and NOT disputed) →
// finalize_proposal on-chain (permissionless; re-mints our bond to refundPk) →
// markets/resolutions='resolved' + onchain_status.
export async function finalizeProposalsV2(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const limit = Number(optionalEnv('FINALIZE_LIMIT') ?? 20)
  await ensureV2MarketColumns(dbUrl)
  const deployment = await resolveDeploymentV2(network)

  const { rows } = await pgExec(
    dbUrl,
    `SELECT m.id
       FROM resolutions r
       JOIN markets m ON m.id = r.market_id
      WHERE r.status = 'proposed'
        AND r.propose_deadline < now()
        AND m.status = 'proposed'
        AND m.onchain_tx_id IS NOT NULL
        AND m.onchain_contract_version = 'v2'
        AND m.onchain_contract_address = $2
        AND COALESCE(m.onchain_status, 'proposed') = 'proposed'
      ORDER BY r.propose_deadline ASC
      LIMIT $1
      FOR UPDATE OF r SKIP LOCKED`,
    [limit, deployment.contractAddress],
  )
  if (rows.length === 0) {
    console.log('[finalize-v2] no proposals past challenge window.')
    return
  }
  console.log(`[finalize-v2] finalizing ${rows.length} proposal(s) on-chain…`)

  const { deployed, walletCtx } = await connectKeeperV2(network)
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

// ===== cancel loop =====
// cancel_requested markets still OPEN on-chain → cancel_market (operator is
// authorized for OPEN cancels) → cancelled.
export async function cancelRequestedV2(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const limit = Number(optionalEnv('CANCEL_LIMIT') ?? 20)
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
      ORDER BY updated_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit, deployment.contractAddress],
  )
  if (rows.length === 0) {
    console.log('[cancel-v2] no cancel_requested markets to cancel.')
    return
  }
  console.log(`[cancel-v2] cancelling ${rows.length} market(s) on-chain…`)

  const { deployed, walletCtx } = await connectKeeperV2(network)
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

// ===== stuck-cancel after grace =====
// proposed/disputed markets stuck past propose_deadline + challenge_window grace
// (arbitration deadlocked) → cancel_market → cancelled. On-chain this also
// re-mints the proposer's (and any disputer's) bond back to their refund pks.
export async function cancelStuckV2(network: ReturnType<typeof resolveNetwork>) {
  const dbUrl = requiredEnv('DATABASE_URL')
  const limit = Number(optionalEnv('STUCK_CANCEL_LIMIT') ?? 20)
  await ensureV2MarketColumns(dbUrl)
  const deployment = await resolveDeploymentV2(network)

  const { rows } = await pgExec(
    dbUrl,
    `SELECT m.id
       FROM markets m
       JOIN resolutions r ON r.market_id = m.id
      WHERE m.status IN ('proposed', 'disputed')
        AND r.status IN ('proposed', 'disputed')
        AND m.onchain_tx_id IS NOT NULL
        AND m.onchain_contract_version = 'v2'
        AND m.onchain_contract_address = $2
        AND m.challenge_window IS NOT NULL
        AND COALESCE(m.onchain_status, m.status) IN ('proposed', 'disputed')
        AND now() > r.propose_deadline + (m.challenge_window || ' seconds')::interval
      ORDER BY r.propose_deadline ASC
      LIMIT $1
      FOR UPDATE OF m SKIP LOCKED`,
    [limit, deployment.contractAddress],
  )
  if (rows.length === 0) {
    console.log('[stuck-cancel-v2] no stuck proposed/disputed markets.')
    return
  }
  console.log(`[stuck-cancel-v2] cancelling ${rows.length} stuck market(s) on-chain…`)

  const { deployed, walletCtx } = await connectKeeperV2(network)
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
  // Run all optimistic-oracle loops once (run-v2.ts schedules them on a cycle).
  await autoProposeResolutionsV2(network)
  await finalizeProposalsV2(network)
  await cancelRequestedV2(network)
  await cancelStuckV2(network)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
