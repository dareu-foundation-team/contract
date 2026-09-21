import * as fs from 'node:fs';
import * as path from 'node:path';

import { deployContract, submitInsertVerifierKeyTx } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { unshieldedToken, rawTokenType } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import {
  configureNetwork,
  captureWalletTransactionCheckpoint,
  contractRoot,
  createProviders,
  createWallet,
  ensureDust,
  errorMessage,
  requiredDeployerWalletSeedOrMnemonic,
  waitForUnshieldedSyncedState,
  waitForSyncedState,
  waitForWalletTransactionSettlement,
  WalletSyncStalledError,
} from '../shared/midnight.js';
import { resolveNetwork } from '../shared/network.js';
import { resolveContractMaintenanceAuthority } from '../shared/chain.js';
import { DIRECT_PROTOCOL_VERSION } from '../shared/protocol.js';
import { Contract, pureCircuits, type Witnesses } from '../../src/managed/dareu-v3/contract/index.js';
import {
  V3BootstrapContract,
  V3_DEFERRED_CIRCUITS,
  type V3DeferredCircuit,
} from './v3-staged-deployment.js';

// DareU V3 per-asset deploy. The resulting address and sNIGHT color are written to
// deployments/<network>-v3.json; register the instance in dareu-registry before any
// keeper or client treats it as active. A redeploy replaces the local deployment
// record but never mutates an existing on-chain instance.

const deploymentDir = path.join(contractRoot, 'deployments');
const envFiles = ['.env', '.env.local'];
const zkConfigPathV3 = path.resolve(contractRoot, 'src', 'managed', 'dareu-v3');

type V3BootstrapRecord = {
  status: 'installing-circuits' | 'complete';
  deployment: Record<string, unknown>;
  pendingCircuits: V3DeferredCircuit[];
  installedCircuits: V3DeferredCircuit[];
  updatedAt: string;
};

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

// Pad a UTF-8 string to 32 bytes, matching the Compact stdlib's `pad(32, "...")`
// (left-aligned, zero-padded) used for domain separators like token_domain.
function pad32Utf8(value: string, label: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > 32) {
    throw new Error(`${label} is too long: "${value}" is ${encoded.length} bytes, max 32.`);
  }
  const out = new Uint8Array(32);
  out.set(encoded);
  return out;
}

function bigintJson(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function logMemory(stage: string) {
  const memory = process.memoryUsage();
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  console.log(`[memory:${stage}] rss=${mb(memory.rss)}MB heapUsed=${mb(memory.heapUsed)}MB heapTotal=${mb(memory.heapTotal)}MB`);
}

function ensureCompiledV3Contract() {
  const contractIndex = path.join(zkConfigPathV3, 'contract', 'index.js');
  const keyDir = path.join(zkConfigPathV3, 'keys');
  const zkirDir = path.join(zkConfigPathV3, 'zkir');

  if (!fs.existsSync(contractIndex) || !fs.existsSync(keyDir) || !fs.existsSync(zkirDir)) {
    throw new Error('DareU v3 contract is not compiled. Run: npm run build:v3');
  }
  const contract = new Contract({ local_secret_key: ({ privateState }: any) => [privateState, new Uint8Array(32)] } as any);
  for (const circuitId of Object.keys(contract.provableCircuits)) {
    for (const asset of [`keys/${circuitId}.prover`, `keys/${circuitId}.verifier`, `zkir/${circuitId}.bzkir`]) {
      if (!fs.existsSync(path.join(zkConfigPathV3, asset))) {
        throw new Error(`V3 circuit asset missing: ${asset}. Run: npm run build:v3`);
      }
    }
  }
}

// v3's ONLY witness is local_secret_key — same shape as v1, but bound to the
// deploy-time OWNER key (cold key). The demo deploy never uses the operator's
// secret key here; deploy only needs the owner's key + the operator's PUBLIC
// participant_id (see constructor arg operator_id below).
function createCompiledDareuV3Contract(ownerSecretKey: Uint8Array) {
  const witnesses: Witnesses<Record<string, never>> = {
    local_secret_key: ({ privateState }) => [privateState, ownerSecretKey],
  };

  return CompiledContract.make('dareu-v3', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPathV3),
  );
}

function createBootstrapDareuV3Contract(ownerSecretKey: Uint8Array) {
  const witnesses: Witnesses<Record<string, never>> = {
    local_secret_key: ({ privateState }) => [privateState, ownerSecretKey],
  };

  return CompiledContract.make('dareu-v3-bootstrap', V3BootstrapContract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPathV3),
  );
}

function writeJsonAtomic(file: string, value: unknown) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, bigintJson, 2)}\n`);
  fs.renameSync(temporary, file);
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
  ensureCompiledV3Contract();

  const network = resolveNetwork(process.argv[2]);
  setNetworkId(network);
  const config = configureNetwork(network);
  const walletSeed = requiredDeployerWalletSeedOrMnemonic();
  const privateStoragePassword = requiredEnv('MIDNIGHT_PRIVATE_STATE_PASSWORD');

  // Owner secret key (cold key) — never persisted, only its participant_id is
  // recorded on disk. Reuses the same env var name as v1 for operational continuity.
  const ownerSecretKey = parseHexBytes(requiredEnv('DAREU_OWNER_SECRET_KEY'), 32, 'DAREU_OWNER_SECRET_KEY');
  const ownerParticipantId = pureCircuits.participant_id(ownerSecretKey);

  // Operator (hot key) is explicit. Direct-resolution deployments never fall
  // back to loading or authorizing the cold owner key for routine keeper work.
  const operatorSecretKey = parseHexBytes(
    requiredEnv('DAREU_OPERATOR_SECRET_KEY'),
    32,
    'DAREU_OPERATOR_SECRET_KEY',
  );
  const operatorParticipantId = pureCircuits.participant_id(operatorSecretKey);

  // underlying: the vault's base asset color. Zero bytes = native NIGHT
  // (nativeToken()'s raw color happens to be the all-zero RawTokenType on Midnight;
  // the contract only compares this value byte-for-byte, so all-zero is what v3's
  // constructor doc means by "zeros = native NIGHT" — see contract/docs/README.md).
  const underlying = parseOptionalHexBytes(process.env.DAREU_V3_UNDERLYING_HEX, 32, 'DAREU_V3_UNDERLYING_HEX')
    ?? new Uint8Array(32);

  // token_domain: sNIGHT's domain separator, pad(32, "...") semantics.
  const tokenDomainStr = process.env.DAREU_V3_TOKEN_DOMAIN?.trim() || 'dareu:snight:v1';
  const domain = pad32Utf8(tokenDomainStr, 'DAREU_V3_TOKEN_DOMAIN');

  const privateStateId = process.env.DAREU_V3_PRIVATE_STATE_ID?.trim() || `dareu-v3-${network}`;

  console.log(`Deploying DareU v3 (demo) contract to Midnight ${network}.`);
  console.log(`Indexer: ${config.indexer}`);
  console.log(`Node: ${config.node}`);
  console.log(`Node WS: ${config.nodeWS}`);
  console.log(`Proof server: ${config.proofServer}`);
  console.log(`token_domain: "${tokenDomainStr}" (${toHex(domain)})`);
  console.log(`underlying: ${toHex(underlying)} (all-zero = native NIGHT)`);
  console.log(`owner participant_id: ${toHex(ownerParticipantId)}`);
  console.log(`operator participant_id: ${toHex(operatorParticipantId)}`);
  const cma = resolveContractMaintenanceAuthority();
  await ensureProofServer(config.proofServer);

  // Deployment intentionally refuses a cold replay. Run the dedicated wallet
  // preparation command first so replay memory is released before this process.
  const walletCtx = await createWallet(walletSeed, network, config, {
    cachePolicy: 'require-last-good',
    ignoreConfiguredMnemonic: true,
  });

  let promoteWalletAfterStop = false;
  try {
    logMemory('wallet-restored');
    await waitForSyncedState(walletCtx.wallet, 0n);
    promoteWalletAfterStop = true;
    const funding = await ensureFunding(walletCtx, config);
    const dustBalance = await ensureDust(walletCtx, config);
    logMemory('wallet-ready');
    const providers = await createProviders(walletCtx, config, privateStoragePassword, {
      zkConfigPath: zkConfigPathV3,
      expectedCircuitIds: ['deposit', 'place_bet', 'pay_smart_darer_subscription', 'settle_market_action', ...V3_DEFERRED_CIRCUITS],
      tokenKindsToBalance: 'all',
    });
    const compiledContract = createCompiledDareuV3Contract(ownerSecretKey);
    const bootstrapCompiledContract = createBootstrapDareuV3Contract(ownerSecretKey);
    logMemory('v3-contract-loaded');

    fs.mkdirSync(deploymentDir, { recursive: true });
    const deploymentPath = path.join(deploymentDir, `${network}-v3.json`);
    const bootstrapPath = path.join(deploymentDir, `${network}-v3.bootstrap.json`);
    let bootstrapRecord: V3BootstrapRecord;

    if (fs.existsSync(bootstrapPath)) {
      bootstrapRecord = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8')) as V3BootstrapRecord;
      if (bootstrapRecord.status === 'complete') {
        throw new Error(`V3 staged deployment is already complete. See ${deploymentPath}.`);
      }
      console.log(`Resuming staged V3 deployment from ${bootstrapPath}.`);
    } else {
      console.log(
        `Submitting bootstrap deploy transaction with ${Object.keys(new V3BootstrapContract({ local_secret_key: ({ privateState }: any) => [privateState, ownerSecretKey] } as any).provableCircuits).length} circuits; ` +
          `${V3_DEFERRED_CIRCUITS.length} circuits will be installed separately.`,
      );
      const deployCheckpoint = await captureWalletTransactionCheckpoint(walletCtx.wallet);
      const deployed = await deployContract(providers as any, {
        compiledContract: bootstrapCompiledContract,
        args: [ownerSecretKey, underlying, domain, operatorParticipantId],
        privateStateId,
        initialPrivateState: {},
        signingKey: cma.signingKey,
      } as any);
      await waitForWalletTransactionSettlement(
        walletCtx.wallet,
        String(deployed.deployTxData.public.txId),
        deployCheckpoint,
      );

      const contractAddress = String(deployed.deployTxData.public.contractAddress);
      const snightColorHex = rawTokenType(domain, contractAddress);
      const deployment = {
        contractName: 'dareu-v3',
        protocolVersion: DIRECT_PROTOCOL_VERSION,
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
          underlyingHex: toHex(underlying),
          tokenDomain: tokenDomainStr,
          tokenDomainHex: toHex(domain),
          ownerParticipantIdHex: toHex(ownerParticipantId),
          operatorParticipantIdHex: toHex(operatorParticipantId),
        },
        snightColorHex,
        maintenanceAuthorityHex: cma.verifyingKeyHex ?? null,
        maintenanceAuthority: cma.deterministic ? 'deterministic-cma-secret' : 'random-ephemeral-local',
        deploymentMode: 'staged-circuit-installation',
      };
      bootstrapRecord = {
        status: 'installing-circuits',
        deployment,
        pendingCircuits: [...V3_DEFERRED_CIRCUITS],
        installedCircuits: [],
        updatedAt: new Date().toISOString(),
      };
      writeJsonAtomic(bootstrapPath, bootstrapRecord);
      console.log(`Bootstrap contract deployed at ${contractAddress}. Recovery record: ${bootstrapPath}`);
    }

    const contractAddress = String(bootstrapRecord.deployment.contractAddress);
    for (const circuitId of V3_DEFERRED_CIRCUITS) {
      const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
      if (!contractState) throw new Error(`Bootstrap contract ${contractAddress} is not visible in the Indexer.`);
      if (contractState.operation(circuitId)) {
        console.log(`Circuit ${circuitId} is already installed; skipping.`);
      } else {
        console.log(`Installing V3 circuit ${circuitId} (${bootstrapRecord.installedCircuits.length + 1}/${V3_DEFERRED_CIRCUITS.length})...`);
        const checkpoint = await captureWalletTransactionCheckpoint(walletCtx.wallet);
        const verifierKey = await providers.zkConfigProvider.getVerifierKey(circuitId);
        const result = await submitInsertVerifierKeyTx(
          providers as any,
          compiledContract as any,
          contractAddress as any,
          circuitId as any,
          verifierKey,
        );
        await waitForWalletTransactionSettlement(walletCtx.wallet, String(result.txId), checkpoint);
      }

      if (!bootstrapRecord.installedCircuits.includes(circuitId)) {
        bootstrapRecord.installedCircuits.push(circuitId);
      }
      bootstrapRecord.pendingCircuits = bootstrapRecord.pendingCircuits.filter((id) => id !== circuitId);
      bootstrapRecord.updatedAt = new Date().toISOString();
      writeJsonAtomic(bootstrapPath, bootstrapRecord);
    }

    const finalState = await providers.publicDataProvider.queryContractState(contractAddress);
    if (!finalState) throw new Error(`Deployed contract ${contractAddress} disappeared from the Indexer.`);
    const missingCircuits = V3_DEFERRED_CIRCUITS.filter((id) => !finalState.operation(id));
    if (missingCircuits.length > 0) {
      throw new Error(`V3 deployment remains incomplete; missing circuits: ${missingCircuits.join(', ')}`);
    }

    bootstrapRecord.status = 'complete';
    bootstrapRecord.pendingCircuits = [];
    bootstrapRecord.updatedAt = new Date().toISOString();
    writeJsonAtomic(bootstrapPath, bootstrapRecord);
    const deployment = bootstrapRecord.deployment;
    writeJsonAtomic(deploymentPath, deployment);

    // JS-side equivalent of the in-circuit `tokenType(token_domain, kernel.self())`
    // (see dareu-v3.compact's snight_color()). rawTokenType(domainSep, contract) is
    // midnight-js-protocol's ledger primitive for this exact derivation — lets the operator
    // (and the webapp demo) recognize the sNIGHT color in a wallet balance list
    // without needing to call into the contract.
    const snightColorHex = String(deployment.snightColorHex);

    console.log('DareU v3 (demo) contract deployed.');
    console.log(`Contract address: ${contractAddress}`);
    console.log(`sNIGHT color (rawTokenType): ${snightColorHex}`);
    console.log(
      cma.deterministic
        ? `Contract maintenance authority: deterministic (${cma.verifyingKeyHex})`
        : 'Contract maintenance authority: RANDOM ephemeral local key — contract is UNUPGRADEABLE if the private-state store is lost. Set DAREU_CMA_SECRET_HEX next time.',
    );
    console.log(`Deployment record: ${deploymentPath}`);
    console.log('Owner/operator secret keys were read from env; only participant_ids are recorded on disk.');
    console.log('Next: npm run market:v3:create -- preprod   (creates one demo market for the wallet-support checklist)');
  } catch (error) {
    promoteWalletAfterStop = false;
    if (error instanceof WalletSyncStalledError) {
      const recovery = await walletCtx.recoverFromSyncStall(error);
      throw new Error(
        `The prepared wallet snapshot is not safe to deploy from and was quarantined ` +
          `(recovery=${recovery.recoveryMode}, attempt=${recovery.attempt}). ` +
          `Run "npm run wallet:v3:prepare:${network}" again before retrying deployment.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await walletCtx.wallet.stop();
    if (promoteWalletAfterStop) await walletCtx.saveState();
  }
}

main().catch(async (error) => {
  console.error('Deploy failed:', errorMessage(error));
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
