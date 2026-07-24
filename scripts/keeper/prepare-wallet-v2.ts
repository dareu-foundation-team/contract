// Prepare one category Keeper wallet for transaction submission.
//
// Unlike wallet-v2.ts, this command MAY submit a NIGHT UTXO registration
// transaction when the wallet has no UTXO registered for DUST generation.
//
//   npm run keeper:v2:prepare-wallet -- preprod crypto
import { loadEnvFiles, resolveNetwork } from '../shared/chain.js'
import {
  configureNetwork,
  createWallet,
  ensureDust,
  requiredWalletSeedOrMnemonic,
} from '../shared/midnight.js'
import { errorMessage, stopWalletSafely } from './reliability.js'
import { configureKeeperCategory } from './scope-v2.js'

async function main(): Promise<void> {
  const category = configureKeeperCategory(process.argv[3])
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const config = configureNetwork(network)
  const walletCtx = await createWallet(requiredWalletSeedOrMnemonic(), network, config)

  try {
    const address = String(walletCtx.unshieldedKeystore.getBech32Address())
    console.log(`[keeper-wallet:${category}] address: ${address}`)
    const dust = await ensureDust(walletCtx, config)
    await walletCtx.saveState()
    console.log(`[keeper-wallet:${category}] ready; DUST balance: ${dust.toString()}`)
  } finally {
    await stopWalletSafely(walletCtx.wallet, `prepare-wallet-v2 ${category}`)
  }
}

main().catch((error) => {
  console.error(errorMessage(error))
  process.exit(1)
})
