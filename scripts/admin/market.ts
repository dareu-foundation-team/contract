import { Outcome } from '../../src/managed/dareu/contract/index.js'
import { prepareMarket } from '../shared/market-metadata.js'
import {
  connectKeeper,
  loadEnvFiles,
  optionalEnv,
  parseHexBytes,
  pgExec,
  readDeployment,
  requiredEnv,
  resolveNetwork,
} from '../shared/chain.js'

// LOCAL admin CLI (run manually): one-off privileged writes against the deployed
// contract. The automated keeper SERVICE (publish/sync/autopropose) lives in
// scripts/keeper/ and runs on a server — keep the two separate.
//   npm run market:create     -- preprod   (reads MARKET_* env for metadata)
//   npm run market:resolve    -- preprod   (MARKET_ID + MARKET_OUTCOME=YES|NO)
//   npm run market:cancel     -- preprod   (MARKET_ID)
//   npm run treasury:withdraw -- preprod   (TREASURY_AMOUNT)

function logTx(label: string, result: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = result as any
  const txId = r?.public?.txId ?? r?.txId ?? r?.finalizedTxData?.txId ?? '(unknown)'
  console.log(`${label} submitted. txId: ${txId}`)
}

async function createMarket(network: ReturnType<typeof resolveNetwork>) {
  const prepared = prepareMarket({
    title: requiredEnv('MARKET_TITLE'),
    closeTime: requiredEnv('MARKET_CLOSE_TIME'), // ISO 8601 or unix ms
    oracleParticipantId: requiredEnv('MARKET_ORACLE'),
    description: optionalEnv('MARKET_DESCRIPTION') ?? null,
    category: optionalEnv('MARKET_CATEGORY') ?? null,
    imageUrl: optionalEnv('MARKET_IMAGE_URL') ?? null,
    resolutionSource: optionalEnv('MARKET_RESOLUTION_SOURCE') ?? null,
    externalId: optionalEnv('MARKET_EXTERNAL_ID') ?? null,
    network,
  })
  const m = prepared.metadata

  // 1) Upsert off-chain metadata first (idempotent). Orphan metadata for a market
  //    that never makes it on-chain is harmless — the UI only shows markets that
  //    also exist on-chain (it joins by id with the indexer).
  await pgExec(
    requiredEnv('DATABASE_URL'),
    `INSERT INTO markets
      (id, network, metadata_hash, title, description, category, close_time,
       oracle_participant_id, image_url, resolution_source, status, metadata, created_by_wallet)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open', $11::jsonb, $12)
     ON CONFLICT (id) DO UPDATE SET
       metadata_hash = EXCLUDED.metadata_hash, title = EXCLUDED.title, description = EXCLUDED.description,
       category = EXCLUDED.category, close_time = EXCLUDED.close_time,
       oracle_participant_id = EXCLUDED.oracle_participant_id, image_url = EXCLUDED.image_url,
       resolution_source = EXCLUDED.resolution_source, metadata = EXCLUDED.metadata, updated_at = now()`,
    [
      prepared.marketId, network, prepared.metadataHash, m.title, m.description, m.category,
      m.closeTime, m.oracleParticipantId, m.imageUrl, m.resolutionSource,
      JSON.stringify(m), optionalEnv('MARKET_CREATED_BY') ?? null,
    ],
  )
  console.log(`Metadata stored. marketId: ${prepared.marketId}`)

  // 2) Submit create_market on-chain.
  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    const result = await deployed.callTx.create_market(
      parseHexBytes(prepared.contractCall.args.market_id, 32, 'market_id'),
      parseHexBytes(prepared.contractCall.args.metadata_hash, 32, 'metadata_hash'),
      parseHexBytes(prepared.contractCall.args.oracle, 32, 'oracle'),
      BigInt(prepared.contractCall.args.close_time),
    )
    logTx('create_market', result)

    // 3) Record the on-chain tx id so the webapp knows this market is live on-chain
    //    (it gates betting on onchain_tx_id IS NOT NULL). Off-chain-only metadata
    //    rows stay NULL and the UI greys out betting for them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = result as any
    const txId: string = r?.public?.txId ?? r?.txId ?? r?.finalizedTxData?.txId ?? ''
    if (txId) {
      await pgExec(
        requiredEnv('DATABASE_URL'),
        `UPDATE markets SET onchain_tx_id = $2, updated_at = now() WHERE id = $1`,
        [prepared.marketId, txId],
      )
      console.log(`Marked on-chain. marketId: ${prepared.marketId} onchain_tx_id: ${txId}`)
    }
  } finally {
    await walletCtx.wallet.stop()
  }
}

function parseOutcome(): Outcome {
  const o = requiredEnv('MARKET_OUTCOME').toUpperCase()
  if (o !== 'YES' && o !== 'NO') throw new Error('MARKET_OUTCOME must be YES or NO')
  return o === 'YES' ? Outcome.YES : Outcome.NO
}

// ===== Optimistic oracle (replaces the old trusted resolve) =====

// Propose an outcome after close, posting the resolution bond. MARKET_DEADLINE is
// the challenge end (unix seconds); the contract enforces it >= close + window.
async function proposeResolution(network: ReturnType<typeof resolveNetwork>) {
  const marketIdHex = requiredEnv('MARKET_ID')
  const marketId = parseHexBytes(marketIdHex, 32, 'MARKET_ID')
  const outcome = parseOutcome()
  const deadline = BigInt(requiredEnv('MARKET_DEADLINE'))

  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    logTx('propose_resolution', await deployed.callTx.propose_resolution(marketId, outcome, deadline))
    await markStatus(network, marketIdHex, 'proposed')
  } finally {
    await walletCtx.wallet.stop()
  }
}

// Dispute a pending proposal during its challenge window (posts a counter-bond).
async function disputeResolution(network: ReturnType<typeof resolveNetwork>) {
  const marketIdHex = requiredEnv('MARKET_ID')
  const marketId = parseHexBytes(marketIdHex, 32, 'MARKET_ID')

  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    logTx('dispute_resolution', await deployed.callTx.dispute_resolution(marketId))
    await markStatus(network, marketIdHex, 'disputed')
  } finally {
    await walletCtx.wallet.stop()
  }
}

// Finalize an undisputed proposal once its challenge window has elapsed.
async function finalizeProposal(network: ReturnType<typeof resolveNetwork>) {
  const marketIdHex = requiredEnv('MARKET_ID')
  const marketId = parseHexBytes(marketIdHex, 32, 'MARKET_ID')

  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    logTx('finalize_proposal', await deployed.callTx.finalize_proposal(marketId))
    await markStatus(network, marketIdHex, 'resolved')
  } finally {
    await walletCtx.wallet.stop()
  }
}

// Arbiter vote on a disputed market (caller must be an enrolled arbiter).
async function voteDispute(network: ReturnType<typeof resolveNetwork>) {
  const marketId = parseHexBytes(requiredEnv('MARKET_ID'), 32, 'MARKET_ID')
  const outcome = parseOutcome()

  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    logTx('vote_dispute', await deployed.callTx.vote_dispute(marketId, outcome))
  } finally {
    await walletCtx.wallet.stop()
  }
}

// Owner: enroll/disable a dispute arbiter (ARBITER_ID = 32-byte participant id).
async function setArbiter(network: ReturnType<typeof resolveNetwork>) {
  const arbiter = parseHexBytes(requiredEnv('ARBITER_ID'), 32, 'ARBITER_ID')
  const enabled = (optionalEnv('ARBITER_ENABLED') ?? 'true') !== 'false'

  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    logTx('set_arbiter', await deployed.callTx.set_arbiter(arbiter, enabled))
  } finally {
    await walletCtx.wallet.stop()
  }
}

async function cancelMarket(network: ReturnType<typeof resolveNetwork>) {
  const marketIdHex = requiredEnv('MARKET_ID')
  const marketId = parseHexBytes(marketIdHex, 32, 'MARKET_ID')

  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    logTx('cancel_market', await deployed.callTx.cancel_market(marketId))
    await markStatus(network, marketIdHex, 'cancelled')
  } finally {
    await walletCtx.wallet.stop()
  }
}

async function withdrawTreasury(network: ReturnType<typeof resolveNetwork>) {
  const amount = BigInt(requiredEnv('TREASURY_AMOUNT'))
  const { deployed, walletCtx } = await connectKeeper(network)
  try {
    // payoutAddress is the owner's unshielded address. CONFIRM the UserAddress
    // encoding expected by the circuit against the live ledger types.
    const payoutAddress = String(walletCtx.unshieldedKeystore.getBech32Address())
    logTx('withdraw_treasury', await deployed.callTx.withdraw_treasury(amount, payoutAddress))
  } finally {
    await walletCtx.wallet.stop()
  }
}

/** Best-effort status hint in Postgres (on-chain remains the source of truth). */
async function markStatus(network: ReturnType<typeof resolveNetwork>, marketIdHex: string, status: string) {
  const url = optionalEnv('DATABASE_URL')
  if (!url) return
  const id = marketIdHex.replace(/^0x/i, '').toLowerCase()
  readDeployment(network) // ensure network is valid context
  await pgExec(url, `UPDATE markets SET status = $1, updated_at = now() WHERE id = $2`, [status, id])
}

async function main() {
  loadEnvFiles()
  const command = process.argv[2]
  const network = resolveNetwork(process.argv[3])

  switch (command) {
    case 'create':
      return createMarket(network)
    case 'propose':
      return proposeResolution(network)
    case 'dispute':
      return disputeResolution(network)
    case 'finalize':
      return finalizeProposal(network)
    case 'vote':
      return voteDispute(network)
    case 'arbiter':
      return setArbiter(network)
    case 'cancel':
      return cancelMarket(network)
    case 'withdraw':
      return withdrawTreasury(network)
    default:
      throw new Error(`Unknown command "${command}". Use create | propose | dispute | finalize | vote | arbiter | cancel | withdraw.`)
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
