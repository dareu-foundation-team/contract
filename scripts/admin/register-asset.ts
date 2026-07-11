import * as fs from 'node:fs';
import * as path from 'node:path';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { rawTokenType } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import {
  configureNetwork,
  contractRoot,
  createProviders,
  createWallet,
  requiredWalletSeedOrMnemonic,
  waitForDustSyncedState,
} from '../shared/midnight.js';
import { resolveNetwork, type SupportedNetwork } from '../shared/network.js';
import { loadEnvFiles, optionalEnv, parseHexBytes, requiredEnv } from '../shared/chain.js';
import { Contract, type Witnesses } from '../../src/managed/dareu-registry/contract/index.js';

// Asset registry maintenance CLI — adds/updates or disables one asset record in the
// deployed dareu-registry. See contract/docs/README.md "Multi-asset registry" for
// the full add-asset runbook:
//   1. Deploy the registry ONCE:            npm run deploy:registry:preprod
//   2. Deploy a per-asset dareu-v2 instance: npm run deploy:v2:preprod
//   3. Register that instance:              npm run registry:add -- preprod
//
//   npm run registry:add -- <network>       (register_asset: insert or update)
//   npm run registry:disable -- <network>   (set_asset_enabled: enabled=false)
//
// Env (all read from contract/.env.local unless already exported):
//   DAREU_ASSET_SYMBOL              short display symbol, e.g. "NIGHT" (<=32 bytes ascii)
//   DAREU_ASSET_UNDERLYING_HEX      32-byte hex; unset/all-zero = native NIGHT
//   DAREU_ASSET_MARKET_ADDRESS      the deployed dareu-v2 instance's ContractAddress hex;
//                                   falls back to deployments/<network>-v2.json
//   DAREU_ASSET_DECIMALS            wrapped-token decimals (Uint<8>)
//   DAREU_ASSET_SNIGHT_COLOR        32-byte hex; if unset, derived as
//                                   rawTokenType(token_domain, market_address) — needs
//                                   DAREU_ASSET_TOKEN_DOMAIN (default "dareu:snight:v1",
//                                   matching deploy-v2.ts's DAREU_V2_TOKEN_DOMAIN default)
//   DAREU_ASSET_ENABLED             "true"/"false", default "true"
//   DAREU_REGISTRY_ADDRESS          the registry's ContractAddress hex; falls back to
//                                   deployments/<network>-registry.json
//   DAREU_REGISTRY_OWNER_SECRET_KEY or DAREU_OWNER_SECRET_KEY  (registry owner, cold key)

const zkConfigPathRegistry = path.resolve(contractRoot, 'src', 'managed', 'dareu-registry');

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

// pad(32, "...") semantics for a UTF-8 string, matching the Compact stdlib's `pad`
// used for symbol / token_domain — mirrors deploy-v2.ts's pad32Utf8.
function pad32Utf8(value: string, label: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > 32) {
    throw new Error(`${label} is too long: "${value}" is ${encoded.length} bytes, max 32.`);
  }
  const out = new Uint8Array(32);
  out.set(encoded);
  return out;
}

function readDeploymentAddress(network: SupportedNetwork, suffix: 'v2' | 'registry', envVar: string): string {
  const fromEnv = optionalEnv(envVar);
  if (fromEnv) return fromEnv;

  const deploymentPath = path.join(contractRoot, 'deployments', `${network}-${suffix}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      `${envVar} is not set and no deployment record exists at ${deploymentPath}. ` +
        `Set ${envVar} explicitly or run the matching deploy script first.`,
    );
  }
  const record = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, unknown>;
  const address = record.contractAddress;
  if (typeof address !== 'string' || !address) {
    throw new Error(`Deployment record ${deploymentPath} has no contractAddress.`);
  }
  return address;
}

function readRegistryPrivateStateId(network: SupportedNetwork): string {
  const fromEnv = optionalEnv('DAREU_REGISTRY_PRIVATE_STATE_ID');
  if (fromEnv) return fromEnv;

  const deploymentPath = path.join(contractRoot, 'deployments', `${network}-registry.json`);
  if (fs.existsSync(deploymentPath)) {
    const record = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, unknown>;
    if (typeof record.privateStateId === 'string' && record.privateStateId) return record.privateStateId;
  }
  return `dareu-registry-${network}`;
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

async function connectRegistry(network: SupportedNetwork, ownerSecretKey: Uint8Array) {
  const config = configureNetwork(network);
  const walletSeed = requiredWalletSeedOrMnemonic();
  const privateStoragePassword = requiredEnv('MIDNIGHT_PRIVATE_STATE_PASSWORD');
  const registryAddress = readDeploymentAddress(network, 'registry', 'DAREU_REGISTRY_ADDRESS');
  const privateStateId = readRegistryPrivateStateId(network);

  const walletCtx = await createWallet(walletSeed, network, config);
  await waitForDustSyncedState(walletCtx.wallet);
  await walletCtx.saveState();

  const providers = await createProviders(walletCtx, config, privateStoragePassword, {
    zkConfigPath: zkConfigPathRegistry,
    expectedCircuitIds: ['register_asset', 'set_asset_enabled'],
  });
  const compiledContract = createCompiledRegistryContract(ownerSecretKey);

  const deployed = await findDeployedContract(providers as any, {
    compiledContract,
    contractAddress: registryAddress,
    privateStateId,
    initialPrivateState: {},
  } as any);

  return { deployed, walletCtx, registryAddress };
}

function ownerSecretKeyFromEnv(): Uint8Array {
  return parseHexBytes(
    optionalEnv('DAREU_REGISTRY_OWNER_SECRET_KEY') ?? requiredEnv('DAREU_OWNER_SECRET_KEY'),
    32,
    'DAREU_REGISTRY_OWNER_SECRET_KEY or DAREU_OWNER_SECRET_KEY',
  );
}

function logTx(label: string, result: unknown) {
  const r = result as any;
  const txId = r?.public?.txId ?? r?.txId ?? r?.finalizedTxData?.txId ?? '(unknown)';
  console.log(`${label} submitted. txId: ${txId}`);
}

async function addAsset(network: SupportedNetwork) {
  const ownerSecretKey = ownerSecretKeyFromEnv();

  const symbolStr = requiredEnv('DAREU_ASSET_SYMBOL');
  const symbol = pad32Utf8(symbolStr, 'DAREU_ASSET_SYMBOL');

  // Zero bytes = native NIGHT, matching deploy-v2.ts's DAREU_V2_UNDERLYING_HEX convention.
  const underlyingHex = optionalEnv('DAREU_ASSET_UNDERLYING_HEX');
  const underlyingColor = underlyingHex ? parseHexBytes(underlyingHex, 32, 'DAREU_ASSET_UNDERLYING_HEX') : new Uint8Array(32);

  const marketAddressHex = readDeploymentAddress(network, 'v2', 'DAREU_ASSET_MARKET_ADDRESS');
  const marketAddress = parseHexBytes(marketAddressHex.replace(/^0x/i, ''), 32, 'DAREU_ASSET_MARKET_ADDRESS');

  const decimals = BigInt(requiredEnv('DAREU_ASSET_DECIMALS'));
  // AssetInfo.decimals is Uint<64> (widened from Uint<8> to dodge the 0.31 ZKIR
  // downcast rework). A sane upper bound still guards typos — no real token exceeds
  // ~36 decimals; keep well under the Uint<64> ceiling.
  if (decimals < 0n || decimals > 255n) {
    throw new Error('DAREU_ASSET_DECIMALS out of range (expected 0-255).');
  }

  // Derive sNIGHT color if not provided explicitly: rawTokenType(domain, market_address)
  // is the JS-side equivalent of dareu-v2.compact's snight_color() circuit
  // (tokenType(token_domain, kernel.self())) — the same derivation deploy-v2.ts prints
  // as "snightColorHex" after deploying a market instance.
  const snightColorHex = optionalEnv('DAREU_ASSET_SNIGHT_COLOR');
  let snightColor: Uint8Array;
  let derivedSnight = false;
  if (snightColorHex) {
    snightColor = parseHexBytes(snightColorHex, 32, 'DAREU_ASSET_SNIGHT_COLOR');
  } else {
    const tokenDomainStr = optionalEnv('DAREU_ASSET_TOKEN_DOMAIN') ?? 'dareu:snight:v1';
    const domain = pad32Utf8(tokenDomainStr, 'DAREU_ASSET_TOKEN_DOMAIN');
    const derivedHex = rawTokenType(domain, marketAddressHex);
    snightColor = parseHexBytes(derivedHex, 32, 'derived snight_color');
    derivedSnight = true;
    console.log(`Derived snight_color from token_domain "${tokenDomainStr}" + market_address: ${derivedHex}`);
  }

  const enabledStr = (optionalEnv('DAREU_ASSET_ENABLED') ?? 'true').toLowerCase();
  const enabled = enabledStr === 'true' || enabledStr === '1';

  console.log(`Registering asset "${symbolStr}" into the registry on ${network}.`);
  console.log(`  underlying_color: ${toHex(underlyingColor)} ${underlyingHex ? '' : '(all-zero = native NIGHT)'}`);
  console.log(`  market_address:   ${toHex(marketAddress)}`);
  console.log(`  snight_color:     ${toHex(snightColor)} ${derivedSnight ? '(derived)' : '(from env)'}`);
  console.log(`  decimals:         ${decimals.toString()}`);
  console.log(`  enabled:          ${enabled}`);

  const { deployed, walletCtx, registryAddress } = await connectRegistry(network, ownerSecretKey);
  try {
    const result = await deployed.callTx.register_asset(symbol, underlyingColor, marketAddress, snightColor, decimals, enabled);
    logTx('register_asset', result);
    console.log(`Registry address: ${registryAddress}`);
    console.log('Registered record:');
    console.log(
      JSON.stringify(
        {
          symbol: symbolStr,
          underlyingColorHex: toHex(underlyingColor),
          marketAddressHex: toHex(marketAddress),
          snightColorHex: toHex(snightColor),
          decimals: decimals.toString(),
          enabled,
        },
        null,
        2,
      ),
    );
  } finally {
    await walletCtx.wallet.stop();
  }
}

async function disableAsset(network: SupportedNetwork) {
  const ownerSecretKey = ownerSecretKeyFromEnv();
  const underlyingHex = optionalEnv('DAREU_ASSET_UNDERLYING_HEX');
  const underlyingColor = underlyingHex ? parseHexBytes(underlyingHex, 32, 'DAREU_ASSET_UNDERLYING_HEX') : new Uint8Array(32);
  const enabledStr = (optionalEnv('DAREU_ASSET_ENABLED') ?? 'false').toLowerCase();
  const enabled = enabledStr === 'true' || enabledStr === '1';

  console.log(`Setting enabled=${enabled} for underlying_color ${toHex(underlyingColor)} on ${network}.`);

  const { deployed, walletCtx, registryAddress } = await connectRegistry(network, ownerSecretKey);
  try {
    const result = await deployed.callTx.set_asset_enabled(underlyingColor, enabled);
    logTx('set_asset_enabled', result);
    console.log(`Registry address: ${registryAddress}`);
    console.log(`Asset ${toHex(underlyingColor)} enabled: ${enabled}`);
  } finally {
    await walletCtx.wallet.stop();
  }
}

async function main() {
  loadEnvFiles();
  ensureCompiledRegistryContract();

  const command = process.argv[2];
  const network = resolveNetwork(process.argv[3]);
  setNetworkId(network);

  if (command === 'add') return addAsset(network);
  if (command === 'disable') return disableAsset(network);

  throw new Error('Usage: tsx scripts/admin/register-asset.ts <add|disable> <network>');
}

main().catch((error) => {
  console.error('register-asset failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
