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
  captureWalletTransactionCheckpoint,
  requiredDeployerWalletSeedOrMnemonic,
  waitForDustSyncedState,
  waitForWalletTransactionSettlement,
} from '../shared/midnight.js';
import { resolveNetwork, type SupportedNetwork } from '../shared/network.js';
import { loadEnvFiles, optionalEnv, parseHexBytes, requiredEnv } from '../shared/chain.js';
import { DIRECT_PROTOCOL_VERSION } from '../shared/protocol.js';
import {
  Contract,
  ledger as registryLedger,
  type Witnesses,
} from '../../src/managed/dareu-registry/contract/index.js';

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
//   DAREU_ASSET_CONTRACT_VERSION    "v2" (default) or "v3"; reads the matching
//                                   verified deployments/<network>-<version>.json
//   DAREU_ASSET_MARKET_ADDRESS      intentionally rejected; use a deployment record
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
  if (fromEnv && suffix === 'v2') {
    throw new Error(
      `${envVar} is no longer accepted. Register assets only from a verified ${DIRECT_PROTOCOL_VERSION} deployment record.`,
    );
  }

  const deploymentPath = path.join(contractRoot, 'deployments', `${network}-${suffix}.json`);
  if (fromEnv && suffix === 'registry') {
    const normalizedEnv = fromEnv.replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedEnv)) {
      throw new Error(`${envVar} must be a 32-byte contract address (64 hex characters).`);
    }
    // When a verified Registry deployment exists locally, an override must name
    // that same contract. This catches the common and dangerous mistake of
    // passing the newly deployed market address as DAREU_REGISTRY_ADDRESS.
    if (fs.existsSync(deploymentPath)) {
      const record = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, unknown>;
      const recorded = String(record.contractAddress ?? '').replace(/^0x/i, '').toLowerCase();
      if (recorded && normalizedEnv !== recorded) {
        throw new Error(
          `${envVar}=${normalizedEnv} does not match the verified ${network} Registry ` +
            `address ${recorded} in ${deploymentPath}. The Registry address is not the V3 market ` +
            `address; omit ${envVar} to use the deployment record.`,
        );
      }
    }
    return normalizedEnv;
  }

  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      suffix === 'v2'
        ? `No direct-resolution deployment record exists at ${deploymentPath}. Run the V2 deploy script first.`
        : `${envVar} is not set and no deployment record exists at ${deploymentPath}. ` +
            `Set ${envVar} explicitly or run the matching deploy script first.`,
    );
  }
  const record = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, unknown>;
  if (suffix === 'v2' && record.protocolVersion !== DIRECT_PROTOCOL_VERSION) {
    throw new Error(
      `${deploymentPath} is not a ${DIRECT_PROTOCOL_VERSION} deployment. Deploy a fresh direct-resolution contract.`,
    );
  }
  const address = record.contractAddress;
  if (typeof address !== 'string' || !address) {
    throw new Error(`Deployment record ${deploymentPath} has no contractAddress.`);
  }
  return address;
}

function readAssetDeployment(network: SupportedNetwork, underlyingColor: Uint8Array, domain: Uint8Array) {
  const version = (optionalEnv('DAREU_ASSET_CONTRACT_VERSION') ?? 'v2').toLowerCase();
  if (version !== 'v2' && version !== 'v3') {
    throw new Error('DAREU_ASSET_CONTRACT_VERSION must be v2 or v3.');
  }
  if (optionalEnv('DAREU_ASSET_MARKET_ADDRESS')) {
    throw new Error('DAREU_ASSET_MARKET_ADDRESS is not accepted. Select v2/v3 using DAREU_ASSET_CONTRACT_VERSION.');
  }

  const deploymentPath = path.join(contractRoot, 'deployments', `${network}-${version}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No ${version.toUpperCase()} deployment record at ${deploymentPath}.`);
  }
  const record = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, unknown>;
  const address = String(record.contractAddress ?? '');
  const constructor = record['constructor'] as Record<string, unknown> | undefined;
  if (record.network !== network || record.contractName !== `dareu-${version}` ||
      record.protocolVersion !== DIRECT_PROTOCOL_VERSION || !/^[0-9a-f]{64}$/i.test(address)) {
    throw new Error(`Invalid ${version.toUpperCase()} deployment record: ${deploymentPath}`);
  }
  if (constructor?.underlyingHex !== toHex(underlyingColor) || constructor?.tokenDomainHex !== toHex(domain)) {
    throw new Error(`Asset underlying/token domain does not match ${deploymentPath}.`);
  }
  const derivedColor = rawTokenType(domain, address);
  if (record.snightColorHex !== derivedColor) {
    throw new Error(`sNIGHT color in ${deploymentPath} does not match the contract address and token domain.`);
  }
  if (version === 'v3') {
    const bootstrapPath = path.join(contractRoot, 'deployments', `${network}-v3.bootstrap.json`);
    if (!fs.existsSync(bootstrapPath)) throw new Error(`V3 completion record missing: ${bootstrapPath}`);
    const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8')) as Record<string, unknown>;
    const bootstrapDeployment = bootstrap.deployment as Record<string, unknown> | undefined;
    if (bootstrap.status !== 'complete' || bootstrapDeployment?.contractAddress !== address ||
        !Array.isArray(bootstrap.pendingCircuits) || bootstrap.pendingCircuits.length !== 0) {
      throw new Error(`V3 circuit installation is not complete in ${bootstrapPath}.`);
    }
  }
  return { version, address, derivedColor };
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

async function connectRegistry(
  network: SupportedNetwork,
  ownerSecretKey: Uint8Array,
  registryAddress: string,
) {
  const config = configureNetwork(network);
  const walletSeed = requiredDeployerWalletSeedOrMnemonic();
  const privateStoragePassword = requiredEnv('MIDNIGHT_PRIVATE_STATE_PASSWORD');
  const privateStateId = readRegistryPrivateStateId(network);

  const walletCtx = await createWallet(walletSeed, network, config, {
    ignoreConfiguredMnemonic: true,
  });
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

  return { deployed, walletCtx, providers, registryAddress };
}

type ExpectedRegistryAsset = {
  symbol: Uint8Array;
  underlyingColor: Uint8Array;
  marketAddress: Uint8Array;
  snightColor: Uint8Array;
  decimals: bigint;
  enabled: boolean;
};

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return toHex(left) === toHex(right);
}

async function registryContainsExpectedAsset(
  providers: Awaited<ReturnType<typeof createProviders>>,
  registryAddress: string,
  expected: ExpectedRegistryAsset,
): Promise<boolean> {
  const state = await providers.publicDataProvider.queryContractState(registryAddress);
  if (!state) return false;
  const current = registryLedger((state as any).data);
  if (!current.assets.member(expected.underlyingColor)) return false;
  const asset = current.assets.lookup(expected.underlyingColor);
  return sameBytes(asset.symbol, expected.symbol) &&
    sameBytes(asset.underlying_color, expected.underlyingColor) &&
    sameBytes(asset.market_address, expected.marketAddress) &&
    sameBytes(asset.snight_color, expected.snightColor) &&
    asset.decimals === expected.decimals &&
    asset.enabled === expected.enabled;
}

async function waitForRegistryReconciliation(
  providers: Awaited<ReturnType<typeof createProviders>>,
  registryAddress: string,
  expected: ExpectedRegistryAsset,
): Promise<boolean> {
  const configured = Number(process.env.MIDNIGHT_REGISTRY_RECONCILE_TIMEOUT_MS ?? 90_000);
  const timeoutMs = Number.isFinite(configured) && configured >= 0 ? configured : 90_000;
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      if (await registryContainsExpectedAsset(providers, registryAddress, expected)) return true;
    } catch {
      // RPC submission can disconnect while the HTTP Indexer is also catching up.
      // Preserve the original submission error and retry reconciliation briefly.
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } while (true);
  return false;
}

function transactionId(result: unknown): string {
  const value = result as any;
  return String(value?.public?.txId ?? value?.txId ?? value?.finalizedTxData?.txId ?? '');
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

  const tokenDomainStr = optionalEnv('DAREU_ASSET_TOKEN_DOMAIN') ?? 'dareu:snight:v1';
  const domain = pad32Utf8(tokenDomainStr, 'DAREU_ASSET_TOKEN_DOMAIN');
  const assetDeployment = readAssetDeployment(network, underlyingColor, domain);
  const marketAddressHex = assetDeployment.address;
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
    const derivedHex = assetDeployment.derivedColor;
    snightColor = parseHexBytes(derivedHex, 32, 'derived snight_color');
    derivedSnight = true;
    console.log(`Derived snight_color from token_domain "${tokenDomainStr}" + market_address: ${derivedHex}`);
  }
  if (toHex(snightColor) !== assetDeployment.derivedColor) {
    throw new Error(`DAREU_ASSET_SNIGHT_COLOR does not match the verified ${assetDeployment.version.toUpperCase()} deployment.`);
  }

  const enabledStr = (optionalEnv('DAREU_ASSET_ENABLED') ?? 'true').toLowerCase();
  const enabled = enabledStr === 'true' || enabledStr === '1';
  const registryAddress = readDeploymentAddress(network, 'registry', 'DAREU_REGISTRY_ADDRESS');
  if (registryAddress.toLowerCase() === marketAddressHex.toLowerCase()) {
    throw new Error(
      `DAREU_REGISTRY_ADDRESS points to the V3 market contract ${marketAddressHex}. ` +
        'Use the DareU Registry contract address instead.',
    );
  }

  console.log(`Registering asset "${symbolStr}" from ${assetDeployment.version.toUpperCase()} into the registry on ${network}.`);
  if (assetDeployment.version === 'v3') {
    console.log('WARNING: NIGHT is keyed by underlying color; this updates any existing V2 NIGHT registry record to V3.');
  }
  console.log(`  underlying_color: ${toHex(underlyingColor)} ${underlyingHex ? '' : '(all-zero = native NIGHT)'}`);
  console.log(`  market_address:   ${toHex(marketAddress)}`);
  console.log(`  snight_color:     ${toHex(snightColor)} ${derivedSnight ? '(derived)' : '(from env)'}`);
  console.log(`  decimals:         ${decimals.toString()}`);
  console.log(`  enabled:          ${enabled}`);

  const { deployed, walletCtx, providers } = await connectRegistry(network, ownerSecretKey, registryAddress);
  const expected = { symbol, underlyingColor, marketAddress, snightColor, decimals, enabled };
  try {
    if (await registryContainsExpectedAsset(providers, registryAddress, expected)) {
      console.log('Registry already contains the requested V3 asset record; no transaction is needed.');
      return;
    }
    const checkpoint = await captureWalletTransactionCheckpoint(walletCtx.wallet);
    let result: unknown;
    try {
      result = await deployed.callTx.register_asset(symbol, underlyingColor, marketAddress, snightColor, decimals, enabled);
    } catch (error) {
      console.warn(
        'Registry submission transport failed; checking the indexed Registry state before deciding whether the transaction failed.',
      );
      if (await waitForRegistryReconciliation(providers, registryAddress, expected)) {
        console.log('Registry already contains the requested V3 asset record; treating the disconnected submission as successful.');
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Registry submission disconnected and no matching indexed record appeared within the reconciliation window. ` +
          `It is safe to rerun registry:add because register_asset is idempotent for the underlying color. Cause: ${message}`,
        { cause: error },
      );
    }
    await waitForWalletTransactionSettlement(walletCtx.wallet, transactionId(result), checkpoint);
    await walletCtx.saveState();
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
  const registryAddress = readDeploymentAddress(network, 'registry', 'DAREU_REGISTRY_ADDRESS');

  console.log(`Setting enabled=${enabled} for underlying_color ${toHex(underlyingColor)} on ${network}.`);

  const { deployed, walletCtx } = await connectRegistry(network, ownerSecretKey, registryAddress);
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
