import * as fs from 'node:fs';
import * as path from 'node:path';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import {
  configureNetwork,
  contractRoot,
  createProviders,
  createWallet,
  ensureDust,
  errorMessage,
  requiredWalletSeedOrMnemonic,
  waitForUnshieldedSyncedState,
} from '../shared/midnight.js';
import { resolveNetwork } from '../shared/network.js';
import { loadEnvFiles, optionalEnv, parseHexBytes, requiredEnv, resolveContractMaintenanceAuthority } from '../shared/chain.js';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { Contract, pureCircuits, type Witnesses } from '../../src/managed/dareu-registry/contract/index.js';

// DareU asset REGISTRY deploy — ONE deployment per network, independent of any
// per-asset dareu-v2 market instance. See contract/docs/README.md "Multi-asset
// registry" for the full runbook. This deploys the registry contract itself and
// records its address at contract/deployments/<network>-registry.json; individual
// assets are then added with `npm run registry:add -- <network>`
// (scripts/admin/register-asset.ts).
//
// Mirrors deploy-v2.ts's wallet/env bootstrap (env loading, wallet funding/DUST
// checks, deployment record shape) so both deploy flows behave consistently.

const deploymentDir = path.join(contractRoot, 'deployments');
const zkConfigPathRegistry = path.resolve(contractRoot, 'src', 'managed', 'dareu-registry');

function bigintJson(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function ensureCompiledRegistryContract() {
  const contractIndex = path.join(zkConfigPathRegistry, 'contract', 'index.js');
  const keyDir = path.join(zkConfigPathRegistry, 'keys');
  const zkirDir = path.join(zkConfigPathRegistry, 'zkir');

  if (!fs.existsSync(contractIndex) || !fs.existsSync(keyDir) || !fs.existsSync(zkirDir)) {
    throw new Error(
      'DareU registry contract is not compiled. Run: npm run build:registry',
    );
  }
}

function createCompiledRegistryContract(ownerSecretKey: Uint8Array) {
  const witnesses: Witnesses<Record<string, never>> = {
    local_secret_key: ({ privateState }) => [privateState, ownerSecretKey],
  };

  return CompiledContract.make('dareu-registry', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPathRegistry),
  );
}

async function ensureProofServer(proofServerUrl: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(proofServerUrl, { signal: controller.signal });
    console.log(`Proof server reachable: ${proofServerUrl} (${response.status})`);
  } catch {
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

async function main() {
  loadEnvFiles();
  ensureCompiledRegistryContract();

  const network = resolveNetwork(process.argv[2]);
  setNetworkId(network);
  const config = configureNetwork(network);
  const walletSeed = requiredWalletSeedOrMnemonic();
  const privateStoragePassword = requiredEnv('MIDNIGHT_PRIVATE_STATE_PASSWORD');

  // Owner secret key (cold key) — same key/domain-tag family as dareu-v2's owner.
  // A deployer MAY reuse the same DAREU_OWNER_SECRET_KEY as the market instances'
  // owner so one cold key governs both the registry and every market, or set a
  // dedicated DAREU_REGISTRY_OWNER_SECRET_KEY to separate the two. See
  // contract/docs/README.md "Multi-asset registry" for the tradeoff.
  const ownerSecretKey = parseHexBytes(
    optionalEnv('DAREU_REGISTRY_OWNER_SECRET_KEY') ?? requiredEnv('DAREU_OWNER_SECRET_KEY'),
    32,
    'DAREU_REGISTRY_OWNER_SECRET_KEY or DAREU_OWNER_SECRET_KEY',
  );
  const ownerParticipantId = pureCircuits.participant_id(ownerSecretKey);

  const privateStateId = optionalEnv('DAREU_REGISTRY_PRIVATE_STATE_ID') ?? `dareu-registry-${network}`;

  console.log(`Deploying DareU asset registry to Midnight ${network}.`);
  console.log(`Indexer: ${config.indexer}`);
  console.log(`Node: ${config.node}`);
  console.log(`Node WS: ${config.nodeWS}`);
  console.log(`Proof server: ${config.proofServer}`);
  console.log(`owner participant_id: ${toHex(ownerParticipantId)}`);
  const cma = resolveContractMaintenanceAuthority();
  await ensureProofServer(config.proofServer);

  const walletCtx = await createWallet(walletSeed, network, config);

  try {
    const funding = await ensureFunding(walletCtx, config);
    // BUG FIX: this deploy previously skipped the DUST sync barrier, so it built
    // its transaction against a stale/pruned DUST Merkle root and the node
    // rejected it with `1010 Custom error: 170 = InvalidDustSpendProof`. ensureDust
    // registers any unregistered tNight UTXOs for DUST generation and BLOCKS until
    // the DUST wallet reports synced + a positive balance — mirrors deploy-v2.ts,
    // which already had this step and deploys successfully.
    const dustBalance = await ensureDust(walletCtx, config);
    await walletCtx.saveState();
    const providers = await createProviders(walletCtx, config, privateStoragePassword, {
      zkConfigPath: zkConfigPathRegistry,
      expectedCircuitIds: ['register_asset'],
    });
    const compiledContract = createCompiledRegistryContract(ownerSecretKey);

    console.log('Submitting deploy transaction...');
    const deployed = await deployContract(providers as any, {
      compiledContract,
      args: [ownerSecretKey],
      privateStateId,
      initialPrivateState: {},
      signingKey: cma.signingKey,
    } as any);

    const contractAddress = String(deployed.deployTxData.public.contractAddress);

    const deployment = {
      contractName: 'dareu-registry',
      network,
      contractAddress,
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
        ownerParticipantIdHex: toHex(ownerParticipantId),
      },
      maintenanceAuthorityHex: cma.verifyingKeyHex ?? null,
      maintenanceAuthority: cma.deterministic ? 'deterministic-cma-secret' : 'random-ephemeral-local',
    };

    fs.mkdirSync(deploymentDir, { recursive: true });
    const deploymentPath = path.join(deploymentDir, `${network}-registry.json`);
    fs.writeFileSync(deploymentPath, `${JSON.stringify(deployment, bigintJson, 2)}\n`);

    console.log('DareU asset registry deployed.');
    console.log(`Contract address: ${contractAddress}`);
    console.log(
      cma.deterministic
        ? `Contract maintenance authority: deterministic (${cma.verifyingKeyHex})`
        : 'Contract maintenance authority: RANDOM ephemeral local key — contract is UNUPGRADEABLE if the private-state store is lost. Set DAREU_CMA_SECRET_HEX next time.',
    );
    console.log(`Deployment record: ${deploymentPath}`);
    console.log('Owner secret key was read from env; only its participant_id is recorded on disk.');
    console.log('Next: deploy a per-asset dareu-v2 instance, then npm run registry:add -- preprod');
  } finally {
    await walletCtx.wallet.stop();
  }
}

main().catch(async (error) => {
  console.error('Registry deploy failed:', errorMessage(error));
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
