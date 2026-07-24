// Read-only V2 keeper preflight: registry discovery + deployment drift checks +
// V2 ledger decode + local operator authorization. Does not open a wallet, prove,
// submit, or write Postgres.
//
//   npm run keeper:v2:preflight -- preprod crypto
import { pureCircuits } from '../../src/managed/dareu-v2/contract/index.js'
import { loadEnvFiles, optionalEnv, parseHexBytes, requiredEnv, resolveNetwork } from '../shared/chain.js'
import { readV2Ledger, resolveDeploymentV2 } from '../shared/chain-v2.js'
import { configureKeeperCategory } from './scope-v2.js'

async function main(): Promise<void> {
  const category = configureKeeperCategory(process.argv[3])
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const deployment = await resolveDeploymentV2(network)
  const led = await readV2Ledger(network)
  if (!led) {
    throw new Error(`V2 contract ${deployment.contractAddress} is not available from the ${network} indexer.`)
  }

  const operatorSecret = optionalEnv('DAREU_OPERATOR_SECRET_KEY')
  const callerRole = operatorSecret ? 'operator' : 'owner'
  const callerSecret = operatorSecret ?? requiredEnv('DAREU_OWNER_SECRET_KEY')
  const expectedParticipant = pureCircuits.participant_id(
    parseHexBytes(callerSecret, 32, callerRole === 'operator' ? 'DAREU_OPERATOR_SECRET_KEY' : 'DAREU_OWNER_SECRET_KEY'),
  )
  const actualParticipant = callerRole === 'operator' ? led.operator : led.owner
  const expectedHex = Buffer.from(expectedParticipant).toString('hex')
  const actualHex = Buffer.from(actualParticipant).toString('hex')
  if (expectedHex !== actualHex) {
    throw new Error(
      `Configured ${callerRole} secret is not authorized by V2 contract ${deployment.contractAddress}. ` +
        `Expected participant ${expectedHex}, on-chain ${callerRole} is ${actualHex}.`,
    )
  }

  console.log('Keeper V2 preflight passed.')
  console.log(`  category:         ${category}`)
  console.log(`  network:          ${network}`)
  console.log(`  registry:         ${deployment.registryAddress}`)
  console.log(`  asset:            ${deployment.symbol}`)
  console.log(`  underlying color: ${deployment.underlyingColorHex}`)
  console.log(`  market address:   ${deployment.contractAddress}`)
  console.log(`  sNIGHT color:     ${deployment.snightColorHex}`)
  console.log(`  decimals:         ${deployment.decimals}`)
  console.log(`  markets on-chain: ${led.markets.size().toString()}`)
  console.log(`  caller role:      ${callerRole} (authorized)`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
