import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'

import * as Rx from 'rxjs'
import WebSocket from 'ws'
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { toHex } from '@midnight-ntwrk/midnight-js-utils'
import * as ledgerRuntime from '@midnight-ntwrk/midnight-js-protocol/ledger'

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
  currentWalletState,
  requiredWalletSeedOrMnemonic,
  waitForSyncedState,
} from './midnight.js'
import { optionalEnv, parseHexBytes, pgExec, requiredEnv } from './chain.js'
import { type SupportedNetwork } from './network.js'

// v2 twin of shared/chain.ts's deployment/connection layer. Kept separate because
// almost every knob differs from v1: the managed asset dir, the deployment record
// (`<network>-v2.json`, which also carries snightColorHex), the caller key (the
// hot OPERATOR key per design decision D8 — the owner key stays cold), and the
// balancer (v2 bond/bet circuits spend a custom-color shielded coin, so balanceTx
// must be allowed to balance 'shielded' too).

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
 * (propose/dispute spend an sNIGHT bond coin; deposit spends unshielded NIGHT).
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
    // `deposit` is v2-only; the keeper's oracle circuits also exist in v1 and
    // cannot by themselves detect that the wrong managed-contract directory was
    // selected. Preflight every circuit this shared connection may submit.
    expectedCircuitIds: ['deposit', 'propose_resolution', 'finalize_proposal', 'cancel_market'],
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

/** Read-only v2 ledger snapshot from the indexer (no wallet). Shared by sync-v2
 *  and the propose loop (which needs the immutable on-chain resolution_bond). */
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

const normHex = (h: string) => h.trim().toLowerCase().replace(/^0x/, '')

/** The keeper wallet's ZswapCoinPublicKey ({ bytes }) — used as the bond refund pk
 *  and as the sNIGHT deposit recipient. */
export async function keeperCoinPublicKey(walletCtx: KeeperV2Context['walletCtx']): Promise<{ bytes: Uint8Array }> {
  const state = await currentWalletState(walletCtx.wallet)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pkHex: string = (state as any).shielded.coinPublicKey.toHexString()
  return { bytes: ledgerRuntime.encodeCoinPublicKey(pkHex) }
}

export type BondCoin = { nonce: Uint8Array; color: Uint8Array; value: bigint }

function findAvailableSnightCoin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any,
  snightColorHex: string,
  value: bigint,
  usedNonces: Set<string>,
): BondCoin | undefined {
  const colorHex = normHex(snightColorHex)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const match = (state.shielded.availableCoins as any[]).find(
    (c) => normHex(c.coin.type) === colorHex && BigInt(c.coin.value) === value && !usedNonces.has(normHex(c.coin.nonce)),
  )
  if (!match) return undefined
  const encoded = ledgerRuntime.encodeShieldedCoinInfo({
    type: match.coin.type,
    nonce: match.coin.nonce,
    value: BigInt(match.coin.value),
  })
  return { nonce: encoded.nonce, color: encoded.color, value: encoded.value }
}

/**
 * Produce an sNIGHT coin of EXACTLY `bond` for propose_resolution to escrow
 * (the circuit asserts value == resolution_bond, so no change-splitting exists).
 *
 * 1. Reuse an available wallet coin of that exact value — after a finalize the
 *    on-chain bond refund mints one back, so steady-state cycles a single coin.
 * 2. Otherwise mint one via the vault: deposit(bond, keeper_pk, random_nonce)
 *    (spends unshielded NIGHT 1:1), then wait for the wallet to detect the
 *    minted coin (its nonce is the mint nonce we chose).
 *
 * `usedNonces` tracks coins already committed to earlier proposes in this same
 * cycle, before the chain/wallet reflects their spend.
 */
export async function ensureSnightBondCoin(
  ctx: KeeperV2Context,
  bond: bigint,
  usedNonces: Set<string>,
): Promise<BondCoin> {
  const state = await currentWalletState(ctx.walletCtx.wallet)
  const existing = findAvailableSnightCoin(state, ctx.deployment.snightColorHex, bond, usedNonces)
  if (existing) {
    usedNonces.add(normHex(toHex(existing.nonce)))
    return existing
  }

  const mintNonce = new Uint8Array(randomBytes(32))
  const recipient = await keeperCoinPublicKey(ctx.walletCtx)
  console.log(`  [bond] no spare sNIGHT bond coin — depositing ${bond} NIGHT to mint one…`)
  await ctx.deployed.callTx.deposit(bond, recipient, mintNonce)

  // The minted coin's nonce IS the mint nonce; wait for the wallet to sync it.
  const wantNonce = normHex(toHex(mintNonce))
  const timeoutMs = Number(optionalEnv('DAREU_BOND_COIN_TIMEOUT_MS') ?? 10 * 60 * 1000)
  const coin = await Rx.firstValueFrom(
    ctx.walletCtx.wallet.state().pipe(
      Rx.auditTime(2_000),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Rx.map((s: any) =>
        (s.shielded.availableCoins as any[]).find(
          (c) =>
            normHex(c.coin.nonce) === wantNonce &&
            normHex(c.coin.type) === normHex(ctx.deployment.snightColorHex),
        ),
      ),
      Rx.filter((c) => c !== undefined),
      Rx.timeout({
        first: timeoutMs,
        with: () =>
          Rx.throwError(
            () =>
              new Error(
                `Deposit submitted but the minted sNIGHT bond coin (nonce ${wantNonce.slice(0, 12)}…) ` +
                  `did not appear in the keeper wallet within ${timeoutMs}ms. ` +
                  'Check indexer sync and that the wallet detects contract-minted coins (V2a demo check).',
              ),
          ),
      }),
    ),
  )
  usedNonces.add(wantNonce)
  const encoded = ledgerRuntime.encodeShieldedCoinInfo({
    type: coin.coin.type,
    nonce: coin.coin.nonce,
    value: BigInt(coin.coin.value),
  })
  return { nonce: encoded.nonce, color: encoded.color, value: encoded.value }
}
