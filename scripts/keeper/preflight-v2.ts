// Read-only V2 keeper preflight: registry discovery + deployment drift checks +
// V2 ledger decode. Does not open a wallet, prove, submit, or write Postgres.
//
//   npm run keeper:v2:preflight -- preprod
import { loadEnvFiles, resolveNetwork } from '../shared/chain.js'
import { readV2Ledger, resolveDeploymentV2 } from '../shared/chain-v2.js'

async function main(): Promise<void> {
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const deployment = await resolveDeploymentV2(network)
  const led = await readV2Ledger(network)
  if (!led) {
    throw new Error(`V2 contract ${deployment.contractAddress} is not available from the ${network} indexer.`)
  }

  console.log('Keeper V2 preflight passed.')
  console.log(`  network:          ${network}`)
  console.log(`  registry:         ${deployment.registryAddress}`)
  console.log(`  asset:            ${deployment.symbol}`)
  console.log(`  underlying color: ${deployment.underlyingColorHex}`)
  console.log(`  market address:   ${deployment.contractAddress}`)
  console.log(`  sNIGHT color:     ${deployment.snightColorHex}`)
  console.log(`  decimals:         ${deployment.decimals}`)
  console.log(`  markets on-chain: ${led.markets.size().toString()}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
