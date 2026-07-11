import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import {
  configureNetwork,
  contractRoot,
  createProviders,
  createWallet,
  requiredWalletSeedOrMnemonic,
  waitForDustSyncedState,
} from '../shared/midnight.js';
import { resolveNetwork } from '../shared/network.js';
import { Contract, pureCircuits, type Witnesses } from '../../src/managed/dareu-v2/contract/index.js';

// Minimal admin CLI for the v2 THROWAWAY demo instance: creates ONE demo market so
// the webapp's /debug/v2-demo page has something to place_bet / claim_settled
// against for checklist item V6. No Postgres — this demo never touches the
// production `markets` table; market metadata lives only on-chain + in the printed
// deployment record.
//
//   npm run market:v2:create -- preprod   (reads DAREU_V2_MARKET_* env, or uses
//                                           built-in defaults for a quick demo)
//
// Auth: create_market requires owner OR operator. Prefers DAREU_OPERATOR_SECRET_KEY
// (the least-privilege hot key, matching how the real keeper would call this) and
// falls back to DAREU_OWNER_SECRET_KEY if no operator key is configured.

const zkConfigPathV2 = path.resolve(contractRoot, 'src', 'managed', 'dareu-v2');
const envFiles = ['.env', '.env.local'];

function loadEnvFiles() {
  for (const filename of envFiles) {
    const envPath = path.join(contractRoot, filename);
    if (!fs.existsSync(envPath)) continue;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const sep = trimmed.indexOf('=');
      if (sep === -1) continue;
      const key = trimmed.slice(0, sep).trim();
      const value = trimmed.slice(sep + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new Error(`${name} is required. Add it to contract/.env.local or export it.`);
  return value;
}

function parseHexBytes(value: string, expectedLength: number, label: string): Uint8Array {
  const bytes = fromHex(value.trim().replace(/^0x/i, ''));
  if (bytes.length !== expectedLength) {
    throw new Error(`${label} must be ${expectedLength} bytes (${expectedLength * 2} hex chars).`);
  }
  return new Uint8Array(bytes);
}

function readDeploymentV2(network: string): { contractAddress: string; privateStateId: string } {
  const deploymentPath = path.join(contractRoot, 'deployments', `${network}-v2.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No v2 deployment record at ${deploymentPath}. Run "npm run deploy:v2:${network}" first.`);
  }
  const record = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, unknown>;
  return {
    contractAddress: String(record.contractAddress),
    privateStateId: typeof record.privateStateId === 'string' ? record.privateStateId : `dareu-v2-${network}`,
  };
}

function createCompiledDareuV2Contract(localSecretKey: Uint8Array) {
  const witnesses: Witnesses<Record<string, never>> = {
    local_secret_key: ({ privateState }) => [privateState, localSecretKey],
  };

  return CompiledContract.make('dareu-v2', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPathV2),
  );
}

async function connectDemoV2(
  network: ReturnType<typeof resolveNetwork>,
  callerSecretKey: Uint8Array,
  expectedCircuitId: 'create_market' | 'cancel_market',
) {
  const config = configureNetwork(network);
  const walletSeed = requiredWalletSeedOrMnemonic();
  const privateStoragePassword = requiredEnv('MIDNIGHT_PRIVATE_STATE_PASSWORD');
  const { contractAddress, privateStateId } = readDeploymentV2(network);

  const walletCtx = await createWallet(walletSeed, network, config);
  await waitForDustSyncedState(walletCtx.wallet);
  await walletCtx.saveState();

  const providers = await createProviders(walletCtx, config, privateStoragePassword, {
    zkConfigPath: zkConfigPathV2,
    // `deposit` is v2-only, so this also catches an accidental fallback to the v1
    // asset directory even though create_market/cancel_market exist in both.
    expectedCircuitIds: ['deposit', expectedCircuitId],
    tokenKindsToBalance: 'all',
  });
  const compiledContract = createCompiledDareuV2Contract(callerSecretKey);

  const deployed = await findDeployedContract(providers as any, {
    compiledContract,
    contractAddress,
    privateStateId,
    initialPrivateState: {},
  } as any);

  return { deployed, walletCtx };
}

function callerSecretKey(): { key: Uint8Array; role: 'operator' | 'owner' } {
  const operator = optionalEnv('DAREU_OPERATOR_SECRET_KEY');
  if (operator) return { key: parseHexBytes(operator, 32, 'DAREU_OPERATOR_SECRET_KEY'), role: 'operator' };
  return { key: parseHexBytes(requiredEnv('DAREU_OWNER_SECRET_KEY'), 32, 'DAREU_OWNER_SECRET_KEY'), role: 'owner' };
}

function logTx(label: string, result: unknown) {
  const r = result as any;
  const txId = r?.public?.txId ?? r?.txId ?? r?.finalizedTxData?.txId ?? '(unknown)';
  console.log(`${label} submitted. txId: ${txId}`);
}

async function createDemoMarket(network: ReturnType<typeof resolveNetwork>) {
  const { key, role } = callerSecretKey();
  console.log(`Creating demo market as ${role}...`);

  const marketIdSeed = optionalEnv('DAREU_V2_MARKET_ID_SEED') ?? randomBytes(16).toString('hex');
  const marketId = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dareu-v2-demo-market:${marketIdSeed}`)),
  );
  const metadataHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dareu-v2 wallet-support demo market')),
  );

  // Oracle: reuse the caller's own participant_id so the same demo key can also
  // cancel/oracle-resolve this market by hand if needed (throwaway convenience —
  // do NOT do this in production).
  const oracleParticipantId = pureCircuits.participant_id(key);

  const closeTime = BigInt(
    optionalEnv('DAREU_V2_MARKET_CLOSE_TIME') ?? String(Math.floor(Date.now() / 1000) + 3600), // +1h
  );
  const challengeWindow = BigInt(optionalEnv('DAREU_V2_MARKET_CHALLENGE_WINDOW') ?? '60'); // min allowed
  const platformFeeRate = BigInt(optionalEnv('DAREU_V2_MARKET_FEE_BPS') ?? '100'); // 1%
  const bettingCutoff = BigInt(optionalEnv('DAREU_V2_MARKET_BETTING_CUTOFF') ?? '60'); // min allowed

  console.log(`market_id: ${toHex(marketId)}`);
  console.log(`close_time: ${closeTime.toString()} (${new Date(Number(closeTime) * 1000).toISOString()})`);

  const { deployed, walletCtx } = await connectDemoV2(network, key, 'create_market');
  try {
    const result = await deployed.callTx.create_market(
      marketId,
      metadataHash,
      oracleParticipantId,
      closeTime,
      challengeWindow,
      platformFeeRate,
      bettingCutoff,
    );
    logTx('create_market', result);
    console.log('\nDemo market id (hex, paste into the /debug/v2-demo page):');
    console.log(toHex(marketId));
  } finally {
    await walletCtx.wallet.stop();
  }
}

async function cancelDemoMarket(network: ReturnType<typeof resolveNetwork>) {
  const { key } = callerSecretKey();
  const marketId = parseHexBytes(requiredEnv('DAREU_V2_MARKET_ID'), 32, 'DAREU_V2_MARKET_ID');

  const { deployed, walletCtx } = await connectDemoV2(network, key, 'cancel_market');
  try {
    const result = await deployed.callTx.cancel_market(marketId);
    logTx('cancel_market', result);
  } finally {
    await walletCtx.wallet.stop();
  }
}

async function main() {
  loadEnvFiles();
  const command = process.argv[2];
  const network = resolveNetwork(process.argv[3]);
  setNetworkId(network);

  if (command === 'create') return createDemoMarket(network);
  if (command === 'cancel') return cancelDemoMarket(network);

  throw new Error('Usage: tsx scripts/admin/market-v2.ts <create|cancel> <network>');
}

main().catch((error) => {
  console.error('market-v2 failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
