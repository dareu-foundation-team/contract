// Prepare one category Keeper wallet for transaction submission.
//
// Unlike wallet-v2.ts, this command MAY submit a NIGHT UTXO registration
// transaction when the wallet has no UTXO registered for DUST generation.
//
//   npm run keeper:v2:prepare-wallet -- preprod crypto
import { runKeeperWalletPreparation } from './prepare-wallet-shared.js'

runKeeperWalletPreparation('v2')
