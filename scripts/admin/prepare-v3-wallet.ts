// Complete the expensive wallet replay in a dedicated process, promote the
// result to `.last-good`, then exit so V8 can release all replay-time memory
// before the V3 contract and proving assets are loaded by the deploy process.
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  configureNetwork,
  createWallet,
  ensureDust,
  errorMessage,
  isWalletReplaySegmentBoundary,
  isWalletSyncRecoveryExhausted,
  preserveWalletCheckpoint,
  requiredDeployerWalletSeedOrMnemonic,
  WalletSyncRecoveryExhaustedError,
  WalletSyncStalledError,
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
  const seed = requiredDeployerWalletSeedOrMnemonic();
  for (;;) {
    const walletCtx = await createWallet(seed, network, config, {
      cachePolicy: 'prefer-checkpoint',
      ignoreConfiguredMnemonic: true,
    });
    let walletStopped = false;

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
      // serializeState races live sync updates in wallet-sdk 4.x. Stop all
      // streams first so the tree and cursor form one coherent checkpoint.
      await walletCtx.wallet.stop();
      walletStopped = true;
      await walletCtx.saveState();
      console.log(`V3 wallet preparation complete; fully-synced snapshot saved. DUST balance: ${dust.toString()}`);
      return;
    } catch (error) {
      if (error instanceof WalletSyncStalledError) {
        if (error.disconnectedStreams.length > 0) {
          console.warn(
            `Wallet transport remained disconnected (${error.disconnectedStreams.join(', ')}); ` +
              'restarting from the same checkpoint without quarantining it.',
          );
          continue;
        }
        // A non-linear commitment-tree replay means this process is permanently
        // poisoned. Quarantine the checkpoint instead of serializing it again,
        // stop all streams, then recreate the wallet from last-good or cold state.
        const recovery = await walletCtx.recoverFromSyncStall(error);
        if (recovery.exhausted) {
          throw new WalletSyncRecoveryExhaustedError(recovery.attempt, error.dustAppliedIndex);
        }
        console.warn(
          `Wallet sync checkpoint quarantined (${recovery.recoveryMode} recovery); ` +
            'restarting wallet preparation automatically.',
        );
      } else {
        // Preserve genuine forward progress for transport/time-limit failures.
        // Never save a stalled/non-linear tree because that would overwrite the
        // only resumable cache with the same corrupt cursor/tree combination.
        const segmentBoundary = isWalletReplaySegmentBoundary(error);
        if (segmentBoundary) {
          console.log(`Wallet replay segment complete: ${errorMessage(error)}`);
        } else {
          console.error(`Wallet preparation interrupted: ${errorMessage(error)}`);
        }
        await walletCtx.wallet.stop();
        walletStopped = true;
        const saved = await walletCtx.saveCheckpoint();
        if (segmentBoundary && !saved) {
          throw new Error(
            `Wallet reached a replay segment boundary but no safe checkpoint was written; ` +
              `refusing a zero-progress restart loop. Original error: ${errorMessage(error)}`,
            { cause: error },
          );
        }
        throw error;
      }
    } finally {
      if (!walletStopped) await walletCtx.wallet.stop();
    }
  }
}

const REPLAY_SEGMENT_EXIT = 75;
const REPLAY_TRANSPORT_RETRY_EXIT = 76;

async function runChild(): Promise<void> {
  try {
    await main();
  } catch (error) {
    const segmentBoundary = isWalletReplaySegmentBoundary(error);
    if (!segmentBoundary) console.error(errorMessage(error));
    process.exitCode = segmentBoundary
      ? REPLAY_SEGMENT_EXIT
      : isWalletSyncRecoveryExhausted(error)
        ? 78
        : 1;
  }
}

function runSupervisor(): void {
  const script = fileURLToPath(import.meta.url);
  const network = process.argv[2] || 'preprod';
  let segment = 0;
  for (;;) {
    segment += 1;
    console.log(`[wallet-prepare] starting replay segment ${segment} in a fresh process.`);
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', script, network],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DAREU_WALLET_PREPARE_CHILD: '1',
          DAREU_WALLET_SEGMENTED_REPLAY: '1',
        },
        stdio: 'inherit',
      },
    );
    if (child.error) {
      console.error(`[wallet-prepare] could not start replay child: ${child.error.message}`);
      process.exitCode = 1;
      return;
    }
    if (child.status === REPLAY_SEGMENT_EXIT) {
      console.warn('[wallet-prepare] replay segment checkpointed at a safe cursor/time/memory boundary; restarting with a clean V8 heap.');
      continue;
    }
    if (child.status === REPLAY_TRANSPORT_RETRY_EXIT) {
      console.warn('[wallet-prepare] wallet transport failed; restarting from the unchanged checkpoint.');
      continue;
    }
    process.exitCode = child.status ?? 1;
    return;
  }
}

if (process.env.DAREU_WALLET_PREPARE_CHILD === '1') {
  process.on('unhandledRejection', (reason) => {
    console.error(`Wallet SDK transport rejected outside the sync promise: ${errorMessage(reason)}`);
    process.exit(REPLAY_TRANSPORT_RETRY_EXIT);
  });
  void runChild();
} else {
  runSupervisor();
}
