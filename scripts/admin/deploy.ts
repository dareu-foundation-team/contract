import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';

import {
  configureNetwork,
  contractRoot,
  createCompiledDareuContract,
  createProviders,
  createWallet,
  currentWalletState,
  ensureCompiledContract,
  requiredWalletSeedOrMnemonic,
  submitTransactionOnce,
  syncAllowedGap,
  waitForUnshieldedSyncedState,
} from '../shared/midnight.js';
import { resolveNetwork } from '../shared/network.js';

const deploymentDir = path.join(contractRoot, 'deployments');
const envFiles = ['.env', '.env.local'];

function parsePositiveIntEnv(name: string, fallback: number) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadEnvFiles() {
  for (const filename of envFiles) {
    const envPath = path.join(contractRoot, filename);
    if (!fs.existsSync(envPath)) continue;

    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      const value = rawValue.replace(/^['"]|['"]$/g, '');

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. Add it to contract/.env.local or export it in your shell.`);
  }

  return value;
}

function parseHexBytes(value: string, expectedLength: number, label: string) {
  const normalized = value.trim().replace(/^0x/i, '');
  const bytes = fromHex(normalized);

  if (bytes.length !== expectedLength) {
    throw new Error(`${label} must be ${expectedLength} bytes (${expectedLength * 2} hex chars).`);
  }

  return new Uint8Array(bytes);
}

function parseOptionalHexBytes(value: string | undefined, expectedLength: number, label: string) {
  if (!value?.trim()) return undefined;
  return parseHexBytes(value, expectedLength, label);
}

function parseBps(name: string, fallback: bigint) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;

  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 10_000n) {
    throw new Error(`${name} must be between 0 and 10000 basis points.`);
  }

  return parsed;
}

function bigintJson(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function errorMessage(error: unknown, depth = 0): string {
  if (depth > 4) return '';

  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeMessage = cause ? errorMessage(cause, depth + 1) : '';
    return causeMessage ? `${error.message}: ${causeMessage}` : error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const maybeMessage = (error as { message?: unknown }).message;
    const maybeCause = (error as { cause?: unknown }).cause;
    const message = typeof maybeMessage === 'string' ? maybeMessage : JSON.stringify(error);
    const causeMessage = maybeCause ? errorMessage(maybeCause, depth + 1) : '';
    return causeMessage ? `${message}: ${causeMessage}` : message;
  }

  return String(error);
}

function progressValue(progress: unknown, key: string) {
  const value = (progress as Record<string, unknown> | undefined)?.[key];
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value === undefined ? '?' : String(value);
}

function dustGenerationProgress(state: Awaited<ReturnType<typeof currentWalletState>>) {
  const allowedGap = syncAllowedGap();
  const progress = state.dust.state.progress;
  const synced = progress.isCompleteWithin(allowedGap);
  const dust = state.dust.balance(new Date());

  return [
    `connected=${progressValue(progress, 'isConnected')}`,
    `applied=${progressValue(progress, 'appliedIndex')}`,
    `walletHigh=${progressValue(progress, 'highestRelevantWalletIndex')}`,
    `chainHigh=${progressValue(progress, 'highestIndex')}`,
    `syncedWithinGap=${synced ? 'true' : 'false'}`,
    `dust=${dust.toString()}`,
  ].join(' ');
}

function dustGenerationTimeoutError(timeoutMs: number) {
  return new Error(
    `Timed out while waiting for DUST generation after ${timeoutMs}ms. ` +
      'If dust is still 0, keep the wallet funded and rerun deploy later.',
  );
}

async function ensureProofServer(proofServerUrl: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(proofServerUrl, { signal: controller.signal });
    console.log(`Proof server reachable: ${proofServerUrl} (${response.status})`);
  } catch (error) {
    throw new Error(
      `Proof server is not reachable at ${proofServerUrl}. Start it with: npm --workspace @dareu/contract run start-proof-server`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function ensureFunding(walletCtx: Awaited<ReturnType<typeof createWallet>>, config: ReturnType<typeof configureNetwork>) {
  const state = await waitForUnshieldedSyncedState(walletCtx.wallet);
  const address = String(walletCtx.unshieldedKeystore.getBech32Address());
  const balance = state.balances[unshieldedToken().raw] ?? 0n;

  console.log(`Wallet address: ${address}`);
  console.log(`Unshielded tNight balance: ${balance.toString()}`);

  if (balance <= 0n) {
    throw new Error(`Wallet has no tNight. Request test funds from ${config.faucet} and rerun the deploy command.`);
  }

  return { address, balance };
}

async function ensureDust(walletCtx: Awaited<ReturnType<typeof createWallet>>, config: ReturnType<typeof configureNetwork>) {
  await waitForUnshieldedSyncedState(walletCtx.wallet);

  let state = await currentWalletState(walletCtx.wallet);
  const nightUtxos = state.unshielded.availableCoins.filter((coin: any) => !coin.meta?.registeredForDustGeneration);

  if (nightUtxos.length > 0) {
    console.log(`Registering ${nightUtxos.length} available tNight UTXO(s) for DUST generation...`);
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      nightUtxos,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (payload) => walletCtx.unshieldedKeystore.signData(payload),
    );
    const finalizedRegistrationTx = await walletCtx.wallet.finalizeRecipe(recipe);
    try {
      const txHash = await submitTransactionOnce(finalizedRegistrationTx, config);
      console.log(`DUST registration transaction submitted: ${txHash}`);
    } catch (error) {
      await walletCtx.wallet.revert(finalizedRegistrationTx);
      throw new Error(`DUST registration transaction submission failed: ${errorMessage(error)}`);
    }
  } else {
    console.log('No unregistered tNight UTXOs found. Checking existing DUST generation state...');
  }

  console.log('Waiting for DUST generation...');
  state = await RxFirstDust(walletCtx);
  const dust = state.dust.balance(new Date());
  console.log(`DUST balance: ${dust.toString()}`);

  return dust;
}

async function RxFirstDust(walletCtx: Awaited<ReturnType<typeof createWallet>>) {
  const Rx = await import('rxjs');
  const timeoutMs = parsePositiveIntEnv('MIDNIGHT_DUST_GENERATION_TIMEOUT_MS', 60 * 60 * 1000);

  return Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(
      Rx.auditTime(5000),
      Rx.tap((state) => {
        console.log(`DUST generation progress: ${dustGenerationProgress(state)}`);
      }),
      Rx.filter((state) => state.dust.state.progress.isCompleteWithin(syncAllowedGap())),
      Rx.filter((state) => state.dust.balance(new Date()) > 0n),
      Rx.timeout({
        first: timeoutMs,
        with: () => Rx.throwError(() => dustGenerationTimeoutError(timeoutMs)),
      }),
    ),
  );
}

async function main() {
  loadEnvFiles();
  ensureCompiledContract();

  const network = resolveNetwork(process.argv[2]);

  const config = configureNetwork(network);
  const walletSeed = requiredWalletSeedOrMnemonic();
  const privateStoragePassword = requiredEnv('MIDNIGHT_PRIVATE_STATE_PASSWORD');
  const ownerSecretKey = parseOptionalHexBytes(process.env.DAREU_OWNER_SECRET_KEY, 32, 'DAREU_OWNER_SECRET_KEY')
    ?? randomBytes(32);
  const ownerSecretWasGenerated = !process.env.DAREU_OWNER_SECRET_KEY?.trim();
  const paymentToken = parseOptionalHexBytes(process.env.DAREU_PAYMENT_TOKEN_HEX, 32, 'DAREU_PAYMENT_TOKEN_HEX')
    ?? parseHexBytes(unshieldedToken().raw, 32, 'default unshielded token');
  const leaderCommissionBps = parseBps('DAREU_LEADER_COMMISSION_BPS', 1000n);
  const platformFeeBps = parseBps('DAREU_PLATFORM_FEE_BPS', 200n);
  const privateStateId = process.env.DAREU_PRIVATE_STATE_ID?.trim() || `dareu-${network}`;

  console.log(`Deploying DareU contract to Midnight ${network}.`);
  console.log(`Indexer: ${config.indexer}`);
  console.log(`Node: ${config.node}`);
  console.log(`Node WS: ${config.nodeWS}`);
  console.log(`Proof server: ${config.proofServer}`);
  await ensureProofServer(config.proofServer);

  const walletCtx = await createWallet(walletSeed, network, config);

  try {
    const funding = await ensureFunding(walletCtx, config);
    const dustBalance = await ensureDust(walletCtx, config);
    // Cache the synced wallet state so the next run resyncs incrementally.
    await walletCtx.saveState();
    const providers = await createProviders(walletCtx, config, privateStoragePassword);
    const compiledContract = createCompiledDareuContract(ownerSecretKey);

    console.log('Submitting deploy transaction...');
    const deployed = await deployContract(providers as any, {
      compiledContract,
      args: [ownerSecretKey, paymentToken, leaderCommissionBps, platformFeeBps],
      privateStateId,
      initialPrivateState: {},
    } as any);

    const deployment = {
      contractName: 'dareu',
      network,
      contractAddress: String(deployed.deployTxData.public.contractAddress),
      txId: String(deployed.deployTxData.public.txId),
      txHash: String(deployed.deployTxData.public.txHash),
      blockHash: String(deployed.deployTxData.public.blockHash),
      blockHeight: deployed.deployTxData.public.blockHeight,
      blockTimestamp: deployed.deployTxData.public.blockTimestamp,
      privateStateId,
      deployedAt: new Date().toISOString(),
      endpoints: config,
      walletAddress: funding.address,
      walletBalance: funding.balance,
      dustBalance,
      constructor: {
        paymentTokenHex: toHex(paymentToken),
        leaderCommissionBps,
        platformFeeBps,
        ownerSecretKeyHex: toHex(ownerSecretKey),
        ownerSecretWasGenerated,
      },
    };

    fs.mkdirSync(deploymentDir, { recursive: true });
    const deploymentPath = path.join(deploymentDir, `${network}.json`);
    fs.writeFileSync(deploymentPath, `${JSON.stringify(deployment, bigintJson, 2)}\n`);

    console.log('DareU contract deployed.');
    console.log(`Contract address: ${deployment.contractAddress}`);
    console.log(`Deployment record: ${deploymentPath}`);
    if (ownerSecretWasGenerated) {
      console.log('DAREU_OWNER_SECRET_KEY was generated and saved in the deployment record. Keep that file private.');
    }
  } finally {
    await walletCtx.wallet.stop();
  }
}

main().catch(async (error) => {
  console.error('Deploy failed:', errorMessage(error));
  // Cryptic node errors (e.g. "Error: 170" = InvalidTransaction::Custom(170)) hide the
  // real reason in nested `cause` fields. Dump the full structured error + cause chain.
  const util = await import('node:util');
  const show = (label: string, value: unknown) =>
    console.error(`\n----- ${label} -----\n` + util.inspect(value, { depth: 12, colors: false, breakLength: 140 }));
  show('full error', error);
  let cause: unknown = (error as { cause?: unknown })?.cause;
  for (let i = 0; cause && i < 12; i++) {
    show(`cause[${i}]`, cause);
    cause = (cause as { cause?: unknown })?.cause;
  }
  process.exit(1);
});
