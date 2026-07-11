import * as fs from 'node:fs';
import * as path from 'node:path';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { unshieldedToken, rawTokenType } from '@midnight-ntwrk/midnight-js-protocol/ledger';
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
import { resolveContractMaintenanceAuthority } from '../shared/chain.js';
import { Contract, pureCircuits, type Witnesses } from '../../src/managed/dareu-v2/contract/index.js';

// DareU V2 per-asset deploy. The resulting address and sNIGHT color are written to
// deployments/<network>-v2.json; register the instance in dareu-registry before any
// keeper or client treats it as active. A redeploy replaces the local deployment
// record but never mutates an existing on-chain instance.

const deploymentDir = path.join(contractRoot, 'deployments');
const envFiles = ['.env', '.env.local'];
// v2 has its own compiled output + zk assets (separate from v1's src/managed/dareu).
const zkConfigPathV2 = path.resolve(contractRoot, 'src', 'managed', 'dareu-v2');

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

function parseBigIntEnv(name: string, fallback: bigint) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function bigintJson(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function ensureCompiledV2Contract() {
  const contractIndex = path.join(zkConfigPathV2, 'contract', 'index.js');
  const keyDir = path.join(zkConfigPathV2, 'keys');
  const zkirDir = path.join(zkConfigPathV2, 'zkir');

  if (!fs.existsSync(contractIndex) || !fs.existsSync(keyDir) || !fs.existsSync(zkirDir)) {
    throw new Error('DareU v2 contract is not compiled. Run: npm run build:v2');
  }
}

// v2's ONLY witness is local_secret_key — same shape as v1, but bound to the
// deploy-time OWNER key (cold key). The demo deploy never uses the operator's
// secret key here; deploy only needs the owner's key + the operator's PUBLIC
// participant_id (see constructor arg operator_id below).
function createCompiledDareuV2Contract(ownerSecretKey: Uint8Array) {
  const witnesses: Witnesses<Record<string, never>> = {
    local_secret_key: ({ privateState }) => [privateState, ownerSecretKey],
  };

  return CompiledContract.make('dareu-v2', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPathV2),
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
  ensureCompiledV2Contract();

  const network = resolveNetwork(process.argv[2]);
  setNetworkId(network);
  const config = configureNetwork(network);
  const walletSeed = requiredWalletSeedOrMnemonic();
  const privateStoragePassword = requiredEnv('MIDNIGHT_PRIVATE_STATE_PASSWORD');

  // Owner secret key (cold key) — never persisted, only its participant_id is
  // recorded on disk. Reuses the same env var name as v1 for operational continuity.
  const ownerSecretKey = parseHexBytes(requiredEnv('DAREU_OWNER_SECRET_KEY'), 32, 'DAREU_OWNER_SECRET_KEY');
  const ownerParticipantId = pureCircuits.participant_id(ownerSecretKey);

  // Operator (hot key): constructor wants only its PUBLIC participant_id, derived
  // here from an optional secret key. Absent -> all-zero sentinel -> contract
  // defaults operator = owner (fine for a throwaway demo / single-key deploy).
  const operatorSecretKey = parseOptionalHexBytes(
    process.env.DAREU_OPERATOR_SECRET_KEY,
    32,
    'DAREU_OPERATOR_SECRET_KEY',
  );
  const operatorParticipantId = operatorSecretKey
    ? pureCircuits.participant_id(operatorSecretKey)
    : new Uint8Array(32); // all-zero sentinel -> constructor defaults to owner

  // underlying: the vault's base asset color. Zero bytes = native NIGHT
  // (nativeToken()'s raw color happens to be the all-zero RawTokenType on Midnight;
  // the contract only compares this value byte-for-byte, so all-zero is what v2's
  // constructor doc means by "zeros = native NIGHT" — see contract/docs/README.md).
  const underlying = parseOptionalHexBytes(process.env.DAREU_V2_UNDERLYING_HEX, 32, 'DAREU_V2_UNDERLYING_HEX')
    ?? new Uint8Array(32);

  // token_domain: sNIGHT's domain separator, pad(32, "...") semantics.
  const tokenDomainStr = process.env.DAREU_V2_TOKEN_DOMAIN?.trim() || 'dareu:snight:v1';
  const domain = pad32Utf8(tokenDomainStr, 'DAREU_V2_TOKEN_DOMAIN');

  const initBond = parseBigIntEnv('DAREU_V2_BOND', 1_000_000n);
  const initThreshold = parseBigIntEnv('DAREU_V2_THRESHOLD', 1n);

  const privateStateId = process.env.DAREU_V2_PRIVATE_STATE_ID?.trim() || `dareu-v2-${network}`;

  console.log(`Deploying DareU v2 (demo) contract to Midnight ${network}.`);
  console.log(`Indexer: ${config.indexer}`);
  console.log(`Node: ${config.node}`);
  console.log(`Node WS: ${config.nodeWS}`);
  console.log(`Proof server: ${config.proofServer}`);
  console.log(`token_domain: "${tokenDomainStr}" (${toHex(domain)})`);
  console.log(`underlying: ${toHex(underlying)} (all-zero = native NIGHT)`);
  console.log(`init_bond: ${initBond.toString()}  init_threshold: ${initThreshold.toString()}`);
  console.log(`owner participant_id: ${toHex(ownerParticipantId)}`);
  console.log(
    operatorSecretKey
      ? `operator participant_id: ${toHex(operatorParticipantId)}`
      : 'operator: not provided -> defaults to owner (DAREU_OPERATOR_SECRET_KEY not set)',
  );
  const cma = resolveContractMaintenanceAuthority();
  await ensureProofServer(config.proofServer);

  const walletCtx = await createWallet(walletSeed, network, config);

  try {
    const funding = await ensureFunding(walletCtx, config);
    const dustBalance = await ensureDust(walletCtx, config);
    await walletCtx.saveState();
    const providers = await createProviders(walletCtx, config, privateStoragePassword, {
      zkConfigPath: zkConfigPathV2,
      expectedCircuitIds: ['deposit'],
      tokenKindsToBalance: 'all',
    });
    const compiledContract = createCompiledDareuV2Contract(ownerSecretKey);

    console.log('Submitting deploy transaction...');
    const deployed = await deployContract(providers as any, {
      compiledContract,
      args: [ownerSecretKey, underlying, domain, initBond, initThreshold, operatorParticipantId],
      privateStateId,
      initialPrivateState: {},
      signingKey: cma.signingKey,
    } as any);

    const contractAddress = String(deployed.deployTxData.public.contractAddress);
    // JS-side equivalent of the in-circuit `tokenType(token_domain, kernel.self())`
    // (see dareu-v2.compact's snight_color()). rawTokenType(domainSep, contract) is
    // midnight-js-protocol's ledger primitive for this exact derivation — lets the operator
    // (and the webapp demo) recognize the sNIGHT color in a wallet balance list
    // without needing to call into the contract.
    const snightColorHex = rawTokenType(domain, contractAddress);

    const deployment = {
      contractName: 'dareu-v2',
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
        initBond,
        initThreshold,
        ownerParticipantIdHex: toHex(ownerParticipantId),
        operatorParticipantIdHex: toHex(operatorParticipantId),
        operatorDefaultedToOwner: !operatorSecretKey,
      },
      snightColorHex,
      maintenanceAuthorityHex: cma.verifyingKeyHex ?? null,
      maintenanceAuthority: cma.deterministic ? 'deterministic-cma-secret' : 'random-ephemeral-local',
    };

    fs.mkdirSync(deploymentDir, { recursive: true });
    const deploymentPath = path.join(deploymentDir, `${network}-v2.json`);
    fs.writeFileSync(deploymentPath, `${JSON.stringify(deployment, bigintJson, 2)}\n`);

    console.log('DareU v2 (demo) contract deployed.');
    console.log(`Contract address: ${contractAddress}`);
    console.log(`sNIGHT color (rawTokenType): ${snightColorHex}`);
    console.log(
      cma.deterministic
        ? `Contract maintenance authority: deterministic (${cma.verifyingKeyHex})`
        : 'Contract maintenance authority: RANDOM ephemeral local key — contract is UNUPGRADEABLE if the private-state store is lost. Set DAREU_CMA_SECRET_HEX next time.',
    );
    console.log(`Deployment record: ${deploymentPath}`);
    console.log('Owner/operator secret keys were read from env; only participant_ids are recorded on disk.');
    console.log('Next: npm run market:v2:create -- preprod   (creates one demo market for the wallet-support checklist)');
  } finally {
    await walletCtx.wallet.stop();
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
