import * as fs from 'node:fs'
import * as path from 'node:path'
import { ContractState } from '@midnight-ntwrk/compact-runtime'
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts'
import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-utils'

import {
  Contract,
  ledger as ledgerV3,
  type Ledger as LedgerV3,
  type Witnesses,
} from '../../src/managed/dareu-v3/contract/index.js'
import { ledger as ledgerRegistry } from '../../src/managed/dareu-registry/contract/index.js'
import {
  configureNetwork,
  contractRoot,
  currentWalletState,
  createProviders,
  createWallet,
  requiredWalletSeedOrMnemonic,
  WalletSyncRecoveryExhaustedError,
  WalletSyncStalledError,
  waitForSyncedState,
} from './midnight.js'
import { optionalEnv, parseHexBytes, pgExec, requiredEnv } from './chain.js'
import { type SupportedNetwork } from './network.js'
import { DIRECT_PROTOCOL_VERSION } from './protocol.js'
import {
  KeeperDustUnavailableError,
  errorMessage,
  stopWalletSafely,
} from '../keeper/reliability.js'

// Active market deployment/connection layer. It uses the hot operator key while
// the owner stays cold, and enables shielded balancing for sNIGHT bet circuits.

export const zkConfigPathV3 = path.resolve(contractRoot, 'src', 'managed', 'dareu-v3')

export function ensureCompiledContractV3() {
  const indexPath = path.join(zkConfigPathV3, 'contract', 'index.js')
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Compiled dareu-v3 contract not found at ${indexPath}. Run "npm run build:v3" first.`)
  }
}

export type DeploymentV3 = {
  contractAddress: string
  privateStateId: string
  /** rawTokenType(token_domain, contractAddress) recorded by deploy-v3.ts — the
   *  color the wallet sees on sNIGHT coins. */
  snightColorHex: string
}

export type ResolvedDeploymentV3 = DeploymentV3 & {
  registryAddress: string
  symbol: string
  underlyingColorHex: string
  decimals: number
}

export function readDeploymentV3(network: SupportedNetwork): DeploymentV3 {
  const deploymentPath = path.join(contractRoot, 'deployments', `${network}-v3.json`)
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No v3 deployment record at ${deploymentPath}. Run "npm run deploy:v3:${network}" first.`)
  }
  const record = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, unknown>
  if (record.contractName !== 'dareu-v3') {
    throw new Error(`${deploymentPath} is not a dareu-v3 deployment.`)
  }
  if (record.protocolVersion !== DIRECT_PROTOCOL_VERSION) {
    throw new Error(
      `${deploymentPath} is not a ${DIRECT_PROTOCOL_VERSION} deployment. ` +
        `Deploy a fresh direct-resolution contract before running the Keeper.`,
    )
  }
  const snightColorHex = typeof record.snightColorHex === 'string' ? record.snightColorHex : ''
  if (!snightColorHex) {
    throw new Error(`${deploymentPath} has no snightColorHex — redeploy with the current deploy-v3.ts.`)
  }
  return {
    contractAddress: String(record.contractAddress),
    privateStateId: typeof record.privateStateId === 'string' ? record.privateStateId : `dareu-v3-${network}`,
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

const resolvedDeploymentCache = new Map<SupportedNetwork, Promise<ResolvedDeploymentV3>>()

/**
 * Hosted preview/preprod indexers reject the SDK's latest-state request when it
 * serializes an explicit `offset: null`. Send the latest-state GraphQL query
 * directly, omitting offset entirely, then deserialize the Compact state.
 */
async function queryLatestContractState(indexerUrl: string, contractAddress: string): Promise<ContractState | null> {
  const response = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query LatestContractState($address: HexEncoded!) {
        contractAction(address: $address) { state }
      }`,
      variables: { address: contractAddress },
    }),
  })
  if (!response.ok) throw new Error(`Indexer HTTP ${response.status} while reading ${contractAddress}`)
  const payload = await response.json() as {
    data?: { contractAction?: { state?: string } | null }
    errors?: Array<{ message?: string }>
  }
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message ?? 'Unknown Indexer error').join('; '))
  }
  const stateHex = payload.data?.contractAction?.state
  return stateHex ? ContractState.deserialize(fromHex(stateHex.replace(/^0x/i, ''))) : null
}

/** Add the V3 mirror namespace columns without requiring a separate migration run. */
export async function ensureV3MarketColumns(dbUrl: string): Promise<void> {
  await pgExec(dbUrl, 'ALTER TABLE markets ADD COLUMN IF NOT EXISTS onchain_contract_version text', [])
  await pgExec(dbUrl, 'ALTER TABLE markets ADD COLUMN IF NOT EXISTS onchain_contract_address text', [])
  await pgExec(dbUrl, 'ALTER TABLE markets ADD COLUMN IF NOT EXISTS onchain_observed_at timestamptz', [])
}

/**
 * Resolve the keeper's asset instance from the on-chain registry. The local v3
 * deployment file is retained only for private-state metadata and as a drift
 * check; the registry is the authoritative source for the market address,
 * sNIGHT color, decimals, and enabled flag.
 */
export function resolveDeploymentV3(network: SupportedNetwork): Promise<ResolvedDeploymentV3> {
  const cached = resolvedDeploymentCache.get(network)
  if (cached) return cached

  const resolving = (async () => {
    const config = configureNetwork(network)
    const local = readDeploymentV3(network)
    const registryAddress = readRegistryAddress(network)
    const underlyingColor = optionalEnv('DAREU_KEEPER_ASSET_UNDERLYING_HEX')
      ? parseHexBytes(requiredEnv('DAREU_KEEPER_ASSET_UNDERLYING_HEX'), 32, 'DAREU_KEEPER_ASSET_UNDERLYING_HEX')
      : new Uint8Array(32)

    const state = await queryLatestContractState(config.indexer, registryAddress)
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
          `but deployments/${network}-v3.json contains ${local.contractAddress}.`,
      )
    }
    if (local.snightColorHex.toLowerCase().replace(/^0x/, '') !== snightColorHex) {
      throw new Error(
        `Registry/deployment drift: registry sNIGHT color is ${snightColorHex}, ` +
          `but deployments/${network}-v3.json contains ${local.snightColorHex}.`,
      )
    }

    const manifestPath = path.join(contractRoot, 'deployments', `${network}-v3.json`)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      constructor?: { underlyingHex?: string }
    }
    if (manifest.constructor?.underlyingHex?.toLowerCase().replace(/^0x/, '') !== toHex(underlyingColor)) {
      throw new Error(`Registry/deployment drift: V3 underlying color differs from ${manifestPath}.`)
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

export function createCompiledDareuV3Contract(localSecretKey: Uint8Array) {
  const witnesses: Witnesses<Record<string, never>> = {
    local_secret_key: ({ privateState }) => [privateState, localSecretKey],
  }
  return CompiledContract.make('dareu-v3', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPathV3),
  )
}

/** The keeper's caller key for v3. Prefers the hot OPERATOR key (D8: the keeper
 *  server should never hold the owner key); falls back to the owner key with a
 *  warning so pre-rotation environments keep working. */
export function keeperCallerSecretKeyV3(): { key: Uint8Array; role: 'operator' | 'owner' } {
  const operator = optionalEnv('DAREU_OPERATOR_SECRET_KEY')
  if (operator) return { key: parseHexBytes(operator, 32, 'DAREU_OPERATOR_SECRET_KEY'), role: 'operator' }
  console.warn(
    '[keeper-v3] DAREU_OPERATOR_SECRET_KEY not set — falling back to DAREU_OWNER_SECRET_KEY. ' +
      'Set an operator key so the keeper server never holds the cold owner key (design D8).',
  )
  return { key: parseHexBytes(requiredEnv('DAREU_OWNER_SECRET_KEY'), 32, 'DAREU_OWNER_SECRET_KEY'), role: 'owner' }
}

export type KeeperV3Context = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deployed: any
  walletCtx: Awaited<ReturnType<typeof createWallet>>
  deployment: ResolvedDeploymentV3
  callerRole: 'operator' | 'owner'
}

/**
 * Connect to the deployed dareu-v3 contract for keeper writes. Mirrors
 * chain.ts#connectKeeper, with the v3 zk assets and 'all' token-kind balancing
 * (`place_bet` spends an sNIGHT coin; `deposit` spends unshielded NIGHT).
 */
export async function connectKeeperV3(network: SupportedNetwork): Promise<KeeperV3Context> {
  ensureCompiledContractV3()
  const config = configureNetwork(network)
  const walletSeed = requiredWalletSeedOrMnemonic()
  const privateStoragePassword = requiredEnv('MIDNIGHT_PRIVATE_STATE_PASSWORD')
  const { key, role } = keeperCallerSecretKeyV3()
  const deployment = await resolveDeploymentV3(network)

  const walletCtx = await createWallet(walletSeed, network, config, { cachePolicy: 'require-last-good' })
  try {
    // V3 consumes sNIGHT coins. Waiting only for DUST leaves shielded.availableCoins
    // empty even after a successful deposit, causing repeated bond deposits.
    await waitForSyncedState(walletCtx.wallet)
    // Exact sync is the trust boundary for last-known-good. Promote it before
    // checking DUST availability so an otherwise healthy, temporarily unfunded
    // wallet still retains a safe recovery point.
    await walletCtx.saveState()
    const walletState = await currentWalletState(walletCtx.wallet)
    const dustBalance = walletState.dust.balance(new Date())
    console.log(
      `[keeper-v3] DUST spendable=${dustBalance.toString()} ` +
        `(available coins=${walletState.dust.availableCoins.length}, ` +
        `pending coins=${walletState.dust.pendingCoins.length})`,
    )
    if (dustBalance <= 0n || walletState.dust.availableCoins.length === 0) {
      const unshieldedAddress = String(walletCtx.unshieldedKeystore.getBech32Address())
      const nightUtxos = walletState.unshielded.availableCoins
      const unregisteredNightUtxos = nightUtxos.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (coin: any) => !coin.meta?.registeredForDustGeneration,
      )
      console.warn(
        `[keeper-v3] wallet=${unshieldedAddress}; NIGHT UTXOs=${nightUtxos.length} ` +
          `(unregistered for DUST=${unregisteredNightUtxos.length})`,
      )
      throw new KeeperDustUnavailableError(
        'keeper wallet preflight',
        new Error(
          'Wallet.InsufficientFunds: no spendable DUST coin is available after an exact wallet sync. ' +
            'The Keeper will wait for DUST generation/maturity before retrying.',
        ),
      )
    }
    const providers = await createProviders(walletCtx, config, privateStoragePassword, {
      zkConfigPath: zkConfigPathV3,
      // Check both V3 keeper write circuits before opening the contract.
      expectedCircuitIds: ['create_market', 'settle_market_action'],
      tokenKindsToBalance: 'all',
    })
    const compiledContract = createCompiledDareuV3Contract(key)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deployed = await findDeployedContract(providers as any, {
      compiledContract,
      contractAddress: deployment.contractAddress,
      privateStateId: deployment.privateStateId,
      initialPrivateState: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    return { deployed, walletCtx, deployment, callerRole: role }
  } catch (error) {
    // createWallet has already started four long-lived services. If setup fails
    // before this context reaches the caller, nobody else owns their cleanup.
    // A stalled replay is quarantined instead of being promoted. Other failures
    // may retain only genuinely advanced working-checkpoint progress.
    let failure: unknown = error
    if (
      error instanceof WalletSyncStalledError &&
      error.stalledStreams.includes('dust') &&
      error.disconnectedStreams.length === 0
    ) {
      const recovery = await walletCtx.recoverFromSyncStall(error)
      console.error(
        `[keeper-v3] wallet sync stalled at DUST applied=${error.dustAppliedIndex}; ` +
          `checkpoint ${recovery.quarantinedPath ? `quarantined at ${recovery.quarantinedPath}` : 'was absent'}; ` +
          `${recovery.restoredLastKnownGood ? 'restored a distinct last-known-good' : 'identical/absent last-known-good quarantined; next start will cold-sync'}; ` +
          `recovery mode ${recovery.recoveryMode}; ` +
          `recovery attempt ${recovery.attempt}.`,
      )
      if (recovery.exhausted) {
        failure = new WalletSyncRecoveryExhaustedError(recovery.attempt, error.dustAppliedIndex)
      }
    } else {
      try {
        await walletCtx.saveCheckpoint()
      } catch (saveError) {
        console.warn(`[keeper-v3] could not save wallet checkpoint after setup failure: ${errorMessage(saveError)}`)
      }
    }
    await stopWalletSafely(walletCtx.wallet, 'connectKeeperV3 failed setup')
    throw failure
  }
}

/** Read-only v3 ledger snapshot from the indexer (no wallet). */
export async function readV3Ledger(network: SupportedNetwork): Promise<LedgerV3 | null> {
  const config = configureNetwork(network)
  const { contractAddress } = await resolveDeploymentV3(network)
  const state = await queryLatestContractState(config.indexer, contractAddress)
  if (!state) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ledgerV3((state as any).data)
}
