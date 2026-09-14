// Complete the expensive wallet replay in a dedicated process, promote the
// result to `.last-good`, then exit so V8 can release all replay-time memory
// before the V3 contract and proving assets are loaded by the deploy process.
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';

import {
  configureNetwork,
  createWallet,
  ensureDust,
  errorMessage,
  preserveWalletCheckpoint,
  requiredWalletSeedOrMnemonic,
  waitForSyncedState,
  waitForUnshieldedSyncedState,
} from '../shared/midnight.js';
import { loadEnvFiles } from '../shared/chain.js';
import { resolveNetwork } from '../shared/network.js';

function logMemory(stage: string) {
  const memory = process.memoryUsage();
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  console.log(`[memory:${stage}] rss=${mb(memory.rss)}MB heapUsed=${mb(memory.heapUsed)}MB heapTotal=${mb(memory.heapTotal)}MB`);
}

async function main() {
  loadEnvFiles();
  const network = resolveNetwork(process.argv[2]);
  const config = configureNetwork(network);
  const preservedCheckpoint = preserveWalletCheckpoint(network);
  if (preservedCheckpoint) {
    console.log(`Preserved pre-warm-up wallet checkpoint: ${preservedCheckpoint}`);
  }
  const walletCtx = await createWallet(requiredWalletSeedOrMnemonic(), network, config, {
    cachePolicy: 'prefer-checkpoint',
  });

  try {
    logMemory('wallet-started');
    // Surface shielded/DUST failures before entering the potentially long DUST
    // generation wait. Previously only unshielded sync was awaited here, so a
    // failed shielded stream was ignored for an hour.
    await waitForSyncedState(walletCtx.wallet);
    const unshielded = await waitForUnshieldedSyncedState(walletCtx.wallet);
    const balance = unshielded.balances[unshieldedToken().raw] ?? 0n;
    const address = String(walletCtx.unshieldedKeystore.getBech32Address());
    console.log(`Wallet address: ${address}`);
    console.log(`Unshielded tNight balance: ${balance.toString()}`);
    if (balance <= 0n) {
      throw new Error(`Wallet has no tNight. Request test funds from ${config.faucet} and rerun this command.`);
    }

    const dust = await ensureDust(walletCtx, config);
    // A deploy may balance with any token kind. Promote only a snapshot where
    // shielded, unshielded and DUST have all reached the current Indexer tip.
    await waitForSyncedState(walletCtx.wallet, 0n);
    logMemory('fully-synced');
    await walletCtx.saveState();
    console.log(`V3 wallet preparation complete; fully-synced snapshot saved. DUST balance: ${dust.toString()}`);
  } catch (error) {
    // Preserve any forward progress made during this run. Atomic cache writes
    // leave the pre-warm-up backup untouched if serialization itself fails.
    await walletCtx.saveCheckpoint();
    throw error;
  } finally {
    await walletCtx.wallet.stop();
  }
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
