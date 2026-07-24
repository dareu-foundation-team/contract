// Read-only V2 keeper wallet diagnostic. Starts and fully syncs the shielded,
// unshielded, and DUST services, then lists sNIGHT coins. No transaction or DB write.
//
//   npm run keeper:v2:wallet -- preprod crypto
import { toHex } from '@midnight-ntwrk/midnight-js-utils'
import { loadEnvFiles, resolveNetwork } from '../shared/chain.js'
import { connectKeeperV2 } from '../shared/chain-v2.js'
import { currentWalletState } from '../shared/midnight.js'
import { configureKeeperCategory } from './scope-v2.js'

const normalize = (value: string) => value.toLowerCase().replace(/^0x/, '')

async function main(): Promise<void> {
  const category = configureKeeperCategory(process.argv[3])
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const ctx = await connectKeeperV2(network)
  try {
    const state = await currentWalletState(ctx.walletCtx.wallet)
    const wanted = normalize(ctx.deployment.snightColorHex)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coins = (state.shielded.availableCoins as any[]).filter(
      (entry) => normalize(String(entry.coin.type)) === wanted,
    )
    const total = coins.reduce((sum, entry) => sum + BigInt(entry.coin.value), 0n)
    console.log('Keeper V2 wallet diagnostic passed.')
    console.log(`  category:     ${category}`)
    console.log(`  asset:        ${ctx.deployment.symbol}`)
    console.log(`  sNIGHT color: ${ctx.deployment.snightColorHex}`)
    console.log(`  coin count:   ${coins.length}`)
    console.log(`  total:        ${total.toString()}`)
    for (const entry of coins) {
      console.log(`  coin: value=${String(entry.coin.value)} nonce=${normalize(String(entry.coin.nonce || toHex(entry.coin.nonce)))}`)
    }
  } finally {
    await ctx.walletCtx.saveState()
    await ctx.walletCtx.wallet.stop()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
