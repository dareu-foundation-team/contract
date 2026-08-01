import * as fs from 'node:fs'
import * as path from 'node:path'
import WebSocket from 'ws'
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { toHex } from '@midnight-ntwrk/midnight-js-utils'

import {
  Contract,
  ledger as ledgerV2,
  type Ledger as LedgerV2,
  type Witnesses,
} from '../../src/managed/dareu-v2/contract/index.js'
import { ledger as ledgerRegistry } from '../../src/managed/dareu-registry/contract/index.js'
import {
  configureNetwork,
  contractRoot,
  createProviders,
  createWallet,
  requiredWalletSeedOrMnemonic,
  waitForSyncedState,
} from './midnight.js'
import { optionalEnv, parseHexBytes, pgExec, requiredEnv } from './chain.js'
import { type SupportedNetwork } from './network.js'
import { DIRECT_PROTOCOL_VERSION } from './protocol.js'

// Active market deployment/connection layer. It uses the hot operator key while
// the owner stays cold, and enables shielded balancing for sNIGHT bet circuits.

export const zkConfigPathV2 = path.resolve(contractRoot, 'src', 'managed', 'dareu-v2')

export function ensureCompiledContractV2() {
  const indexPath = path.join(zkConfigPathV2, 'contract', 'index.js')
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Compiled dareu-v2 contract not found at ${indexPath}. Run "npm run build:v2" first.`)
  }
}

export type DeploymentV2 = {
  contractAddress: string
  privateStateId: string
  /** rawTokenType(token_domain, contractAddress) recorded by deploy-v2.ts — the
   *  color the wallet sees on sNIGHT coins. */
  snightColorHex: string
}

export type ResolvedDeploymentV2 = DeploymentV2 & {
  registryAddress: string
  symbol: string
  underlyingColorHex: string
  decimals: number
}

export function readDeploymentV2(network: SupportedNetwork): DeploymentV2 {
  const deploymentPath = path.join(contractRoot, 'deployments', `${network}-v2.json`)
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No v2 deployment record at ${deploymentPath}. Run "npm run deploy:v2:${network}" first.`)
  }
  const record = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, unknown>
  if (record.protocolVersion !== DIRECT_PROTOCOL_VERSION) {
    throw new Error(
      `${deploymentPath} is not a ${DIRECT_PROTOCOL_VERSION} deployment. ` +
        `Deploy a fresh direct-resolution contract before running the Keeper.`,
    )
  }
  const snightColorHex = typeof record.snightColorHex === 'string' ? record.snightColorHex : ''
  if (!snightColorHex) {
    throw new Error(`${deploymentPath} has no snightColorHex — redeploy with the current deploy-v2.ts.`)
  }
  return {
    contractAddress: String(record.contractAddress),
    privateStateId: typeof record.privateStateId === 'string' ? record.privateStateId : `dareu-v2-${network}`,
    snightColorHex,
  }
}

function readRegistryAddress(network: SupportedNetwork): string {
  const fromEnv = optionalEnv('DAREU_REGISTRY_ADDRESS')
  if (fromEnv) return fromEnv

  const deploymentPath = path.join(contractRoot, 'deployments', `${network}-registry.json`)
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      `DAREU_REGISTRY_ADDRESS is not set and no registry deployment exists at ${deploymentPath}.`,
    )
  }
  const record = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, unknown>
  if (typeof record.contractAddress !== 'string' || !record.contractAddress) {
    throw new Error(`${deploymentPath} has no contractAddress.`)
  }
  return record.contractAddress
}

function decodePaddedSymbol(bytes: Uint8Array): string {
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end -= 1
  return new TextDecoder().decode(bytes.subarray(0, end))
}

const resolvedDeploymentCache = new Map<SupportedNetwork, Promise<ResolvedDeploymentV2>>()

/** Add the V2 mirror namespace columns without requiring a separate migration run. */
export async function ensureV2MarketColumns(dbUrl: string): Promise<void> {
  await pgExec(dbUrl, 'ALTER TABLE markets ADD COLUMN IF NOT EXISTS onchain_contract_version text', [])
  await pgExec(dbUrl, 'ALTER TABLE markets ADD COLUMN IF NOT EXISTS onchain_contract_address text', [])
}

/**
 * Resolve the keeper's asset instance from the on-chain registry. The local v2
 * deployment file is retained only for private-state metadata and as a drift
 * check; the registry is the authoritative source for the market address,
 * sNIGHT color, decimals, and enabled flag.
 */
export function resolveDeploymentV2(network: SupportedNetwork): Promise<ResolvedDeploymentV2> {
  const cached = resolvedDeploymentCache.get(network)
  if (cached) return cached

  const resolving = (async () => {
    globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket
    const config = configureNetwork(network)
    const local = readDeploymentV2(network)
    const registryAddress = readRegistryAddress(network)
    const underlyingColor = optionalEnv('DAREU_KEEPER_ASSET_UNDERLYING_HEX')
      ? parseHexBytes(requiredEnv('DAREU_KEEPER_ASSET_UNDERLYING_HEX'), 32, 'DAREU_KEEPER_ASSET_UNDERLYING_HEX')
      : new Uint8Array(32)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider = indexerPublicDataProvider(config.indexer, config.indexerWS, WebSocket as any)
    const state = await provider.queryContractState(registryAddress)
    if (!state) {
      throw new Error(
        `Registry ${registryAddress} is not available from the ${network} indexer yet.`,
      )
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = ledgerRegistry((state as any).data)
    if (!registry.assets.member(underlyingColor)) {
      throw new Error(
        `Registry ${registryAddress} has no asset for underlying color ${toHex(underlyingColor)}.`,
      )
    }
    const asset = registry.assets.lookup(underlyingColor)
    const contractAddress = toHex(asset.market_address)
    const snightColorHex = toHex(asset.snight_color)
    const symbol = decodePaddedSymbol(asset.symbol)
    if (!asset.enabled) {
      throw new Error(`Registry asset ${symbol || toHex(underlyingColor)} is disabled; keeper will not submit transactions.`)
    }

    if (local.contractAddress.toLowerCase().replace(/^0x/, '') !== contractAddress) {
      throw new Error(
        `Registry/deployment drift: registry points ${symbol} to ${contractAddress}, ` +
          `but deployments/${network}-v2.json contains ${local.contractAddress}.`,
      )
    }
    if (local.snightColorHex.toLowerCase().replace(/^0x/, '') !== snightColorHex) {
      throw new Error(
        `Registry/deployment drift: registry sNIGHT color is ${snightColorHex}, ` +
          `but deployments/${network}-v2.json contains ${local.snightColorHex}.`,
      )
    }

    return {
      ...local,
      contractAddress,
      snightColorHex,
      registryAddress,
      symbol,
      underlyingColorHex: toHex(underlyingColor),
      decimals: Number(asset.decimals),
    }
  })()

  resolvedDeploymentCache.set(network, resolving)
  resolving.catch(() => resolvedDeploymentCache.delete(network))
  return resolving
}

export function createCompiledDareuV2Contract(localSecretKey: Uint8Array) {
  const witnesses: Witnesses<Record<string, never>> = {
    local_secret_key: ({ privateState }) => [privateState, localSecretKey],
  }
  return CompiledContract.make('dareu-v2', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPathV2),
  )
}

/** The keeper's caller key for v2. Prefers the hot OPERATOR key (D8: the keeper
 *  server should never hold the owner key); falls back to the owner key with a
 *  warning so pre-rotation environments keep working. */
export function keeperCallerSecretKeyV2(): { key: Uint8Array; role: 'operator' | 'owner' } {
  const operator = optionalEnv('DAREU_OPERATOR_SECRET_KEY')
  if (operator) return { key: parseHexBytes(operator, 32, 'DAREU_OPERATOR_SECRET_KEY'), role: 'operator' }
  console.warn(
    '[keeper-v2] DAREU_OPERATOR_SECRET_KEY not set — falling back to DAREU_OWNER_SECRET_KEY. ' +
      'Set an operator key so the keeper server never holds the cold owner key (design D8).',
  )
  return { key: parseHexBytes(requiredEnv('DAREU_OWNER_SECRET_KEY'), 32, 'DAREU_OWNER_SECRET_KEY'), role: 'owner' }
}

export type KeeperV2Context = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deployed: any
  walletCtx: Awaited<ReturnType<typeof createWallet>>
  deployment: ResolvedDeploymentV2
  callerRole: 'operator' | 'owner'
}

/**
 * Connect to the deployed dareu-v2 contract for keeper writes. Mirrors
 * chain.ts#connectKeeper, with the v2 zk assets and 'all' token-kind balancing
 * (`place_bet` spends an sNIGHT coin; `deposit` spends unshielded NIGHT).
 */
export async function connectKeeperV2(network: SupportedNetwork): Promise<KeeperV2Context> {
  ensureCompiledContractV2()
  const config = configureNetwork(network)
  const walletSeed = requiredWalletSeedOrMnemonic()
  const privateStoragePassword = requiredEnv('MIDNIGHT_PRIVATE_STATE_PASSWORD')
  const { key, role } = keeperCallerSecretKeyV2()
  const deployment = await resolveDeploymentV2(network)

  const walletCtx = await createWallet(walletSeed, network, config)
  // V2 consumes sNIGHT coins. Waiting only for DUST leaves shielded.availableCoins
  // empty even after a successful deposit, causing repeated bond deposits.
  await waitForSyncedState(walletCtx.wallet)
  await walletCtx.saveState()

  const providers = await createProviders(walletCtx, config, privateStoragePassword, {
    zkConfigPath: zkConfigPathV2,
    // `deposit` and `resolve_market` identify the direct-resolution V2 artifact.
    // cannot by themselves detect that the wrong managed-contract directory was
    // selected. Preflight every circuit this shared connection may submit.
    expectedCircuitIds: ['deposit', 'resolve_market', 'cancel_market'],
    tokenKindsToBalance: 'all',
  })
  const compiledContract = createCompiledDareuV2Contract(key)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deployed = await findDeployedContract(providers as any, {
    compiledContract,
    contractAddress: deployment.contractAddress,
    privateStateId: deployment.privateStateId,
    initialPrivateState: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return { deployed, walletCtx, deployment, callerRole: role }
}

/** Read-only v2 ledger snapshot from the indexer (no wallet). */
export async function readV2Ledger(network: SupportedNetwork): Promise<LedgerV2 | null> {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket
  const config = configureNetwork(network)
  const { contractAddress } = await resolveDeploymentV2(network)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = indexerPublicDataProvider(config.indexer, config.indexerWS, WebSocket as any)
  const state = await provider.queryContractState(contractAddress)
  if (!state) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ledgerV2((state as any).data)
}
