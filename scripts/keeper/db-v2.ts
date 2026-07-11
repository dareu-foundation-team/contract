// Read-only report of the Postgres V2 contract namespace.
//
//   npm run keeper:v2:db -- preprod
import { loadEnvFiles, pgExec, requiredEnv, resolveNetwork } from '../shared/chain.js'
import { ensureV2MarketColumns, resolveDeploymentV2 } from '../shared/chain-v2.js'

async function main(): Promise<void> {
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const dbUrl = requiredEnv('DATABASE_URL')
  await ensureV2MarketColumns(dbUrl)
  const deployment = await resolveDeploymentV2(network)
  const { rows } = await pgExec(
    dbUrl,
    `SELECT
       count(*) FILTER (
         WHERE onchain_tx_id IS NOT NULL
           AND (onchain_contract_version IS DISTINCT FROM 'v2'
                OR onchain_contract_address IS DISTINCT FROM $1)
       ) AS legacy_rows,
       count(*) FILTER (
         WHERE onchain_contract_version = 'v2' AND onchain_contract_address = $1
       ) AS v2_rows,
       count(*) FILTER (
         WHERE close_time > now() AND status IN ('draft', 'open')
           AND (onchain_contract_version IS DISTINCT FROM 'v2'
                OR onchain_contract_address IS DISTINCT FROM $1)
       ) AS republishable,
       count(*) FILTER (
         WHERE status = 'cancel_requested'
           AND onchain_contract_version = 'v2' AND onchain_contract_address = $1
       ) AS v2_cancel_requested
     FROM markets`,
    [deployment.contractAddress],
  )
  console.log('Keeper V2 DB namespace report:')
  console.log(rows[0])
  const current = await pgExec(
    dbUrl,
    `SELECT id, status, onchain_status, onchain_tx_id, close_time
       FROM markets
      WHERE onchain_contract_version = 'v2' AND onchain_contract_address = $1
      ORDER BY close_time ASC
      LIMIT 20`,
    [deployment.contractAddress],
  )
  console.log('Current V2 rows:')
  console.log(current.rows)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
