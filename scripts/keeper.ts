import * as fs from 'node:fs'
import * as path from 'node:path'

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts'
import { fromHex } from '@midnight-ntwrk/midnight-js-utils'

import {
  configureNetwork,
  contractRoot,
  createCompiledDareuContract,
  createProviders,
  createWallet,
  ensureCompiledContract,
  requiredWalletSeedOrMnemonic,
  waitForDustSyncedState,
  type SupportedNetwork,
} from './midnight.js'

// Shared bootstrap for privileged ("keeper") operations that used to be relayer
// endpoints: create_market, resolve_market, cancel_market, withdraw_treasury.
// These hold the owner/oracle secret key and submit transactions directly — they
// are on-demand admin scripts, NOT a long-running service.

const envFiles = ['.env', '.env.local']

export function loadEnvFiles() {
  for (const filename of envFiles) {
    const envPath = path.join(contractRoot, filename)
    if (!fs.existsSync(envPath)) continue
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const sep = trimmed.indexOf('=')
      if (sep === -1) continue
      const key = trimmed.slice(0, sep).trim()
      const value = trimmed.slice(sep + 1).trim().replace(/^['"]|['"]$/g, '')
      if (key && process.env[key] === undefined) process.env[key] = value
    }
  }
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value && value.length > 0 ? value : undefined
}

export function requiredEnv(name: string): string {
  const value = optionalEnv(name)
  if (!value) throw new Error(`${name} is required. Add it to contract/.env.local or export it.`)
  return value
}

export function parseHexBytes(value: string, expectedLength: number, label: string): Uint8Array {
  const bytes = fromHex(value.trim().replace(/^0x/i, ''))
  if (bytes.length !== expectedLength) {
    throw new Error(`${label} must be ${expectedLength} bytes (${expectedLength * 2} hex chars).`)
  }
  return new Uint8Array(bytes)
}

export function resolveNetwork(arg?: string): SupportedNetwork {
  const network = (arg || process.env.MIDNIGHT_NETWORK || 'preprod') as SupportedNetwork
  if (network !== 'preprod' && network !== 'preview') {
    throw new Error(`Unsupported network "${network}". Use "preprod" or "preview".`)
  }
  return network
}

export function readDeployment(network: SupportedNetwork): { contractAddress: string; privateStateId: string } {
  const deploymentPath = path.join(contractRoot, 'deployments', `${network}.json`)
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment record at ${deploymentPath}. Run "npm run deploy:${network}" first.`)
  }
  const record = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) as Record<string, unknown>
  return {
    contractAddress: String(record.contractAddress),
    privateStateId: typeof record.privateStateId === 'string' ? record.privateStateId : `dareu-${network}`,
  }
}

export type KeeperContext = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deployed: any
  walletCtx: Awaited<ReturnType<typeof createWallet>>
  ownerSecretKey: Uint8Array
}

/**
 * Connect to the deployed DareU contract with the owner key so owner/oracle
 * circuits authorize. Assumes the wallet is already funded with DUST (run the
 * deploy script / faucet first); we only wait for DUST sync here.
 */
export async function connectKeeper(network: SupportedNetwork): Promise<KeeperContext> {
  ensureCompiledContract()
  const config = configureNetwork(network)
  const walletSeed = requiredWalletSeedOrMnemonic()
  const privateStoragePassword = requiredEnv('MIDNIGHT_PRIVATE_STATE_PASSWORD')
  const ownerSecretKey = parseHexBytes(requiredEnv('DAREU_OWNER_SECRET_KEY'), 32, 'DAREU_OWNER_SECRET_KEY')
  const { contractAddress, privateStateId } = readDeployment(network)

  const walletCtx = await createWallet(walletSeed, network, config)
  await waitForDustSyncedState(walletCtx.wallet)
  // Cache the synced wallet state so the next keeper run resyncs incrementally.
  await walletCtx.saveState()

  const providers = await createProviders(walletCtx, config, privateStoragePassword)
  const compiledContract = createCompiledDareuContract(ownerSecretKey)

  // CONFIRM against a live deployment: findDeployedContract option shape mirrors
  // deployContract's (compiledContract + privateStateId). Casts match deploy.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deployed = await findDeployedContract(providers as any, {
    compiledContract,
    contractAddress,
    privateStateId,
    initialPrivateState: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)

  return { deployed, walletCtx, ownerSecretKey }
}
