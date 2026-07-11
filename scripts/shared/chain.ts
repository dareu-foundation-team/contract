import * as fs from 'node:fs'
import * as path from 'node:path'

import pg from 'pg'
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts'
import { fromHex } from '@midnight-ntwrk/midnight-js-utils'
import {
  signingKeyFromBip340,
  signatureVerifyingKey,
  type SigningKey,
} from '@midnight-ntwrk/midnight-js-protocol/ledger'

import {
  configureNetwork,
  contractRoot,
  createCompiledDareuContract,
  createProviders,
  createWallet,
  ensureCompiledContract,
  requiredWalletSeedOrMnemonic,
  waitForDustSyncedState,
} from './midnight.js'
import { type SupportedNetwork } from './network.js'

// Re-export so existing importers (admin/market.ts, keeper/*) keep getting
// resolveNetwork from chain.js; the implementation lives in network.ts.
export { resolveNetwork } from './network.js'

// Shared chain/env infrastructure: env loading, network resolution, deployment
// lookup, Postgres exec, and `connectKeeper` (owner-authenticated contract handle).
// Consumed by BOTH the local admin scripts (deploy.ts, market.ts) and the keeper
// SERVICE (scripts/keeper/*). It is plumbing, not an entrypoint.

const envFiles = ['.env', '.env.local']

// One-shot Postgres exec (standard `pg`; opens/closes a connection per call).
// Shared by the local market admin and the keeper service.
export async function pgExec(connectionString: string, text: string, params: unknown[]) {
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    return await client.query(text, params)
  } finally {
    await client.end()
  }
}

// Run several statements atomically in one connection/transaction. Used where the
// spec requires syncing PG status across markets + resolutions in a single tx
// (propose / finalize / cancel). Rolls back on any error.
export async function pgTx(
  connectionString: string,
  fn: (client: pg.Client) => Promise<void>,
): Promise<void> {
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    await client.query('BEGIN')
    await fn(client)
    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore rollback failure */
    }
    throw err
  } finally {
    await client.end()
  }
}

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

export type ContractMaintenanceAuthorityResolution = {
  /** Pass straight through to deployContract's `signingKey` option. */
  signingKey: SigningKey | undefined
  /** Public verifying key, when a deterministic key was derived — for the
   *  deployment JSON record and for printing. */
  verifyingKeyHex: string | undefined
  /** True when DAREU_CMA_SECRET_HEX was set and a deterministic CMA was derived. */
  deterministic: boolean
}

/**
 * Resolve the contract maintenance authority (CMA) signing key for a deploy, shared
 * by deploy-v2.ts and deploy-registry.ts so both scripts thread the CMA identically.
 *
 * deployContract() samples a RANDOM signing key as the CMA whenever `signingKey` is
 * left undefined, and stores it ONLY in the local private-state provider (see
 * DeployContractOptionsBase's `signingKey` doc in midnight-js-contracts). If that
 * local store is ever lost, the contract can never be upgraded again (no
 * verifier-key/maintenance update is possible without the CMA). For any
 * production/long-lived deploy, DAREU_CMA_SECRET_HEX MUST be set so the CMA is
 * derived deterministically from a secret the operator backs up cold — the same
 * secret can be reused across every dareu-v2 instance + the registry to have one CMA
 * govern all of them, or a distinct secret per instance for isolation.
 */
export function resolveContractMaintenanceAuthority(): ContractMaintenanceAuthorityResolution {
  const cmaSecretHex = optionalEnv('DAREU_CMA_SECRET_HEX')

  if (!cmaSecretHex) {
    console.warn(
      [
        '',
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        '!! WARNING: DAREU_CMA_SECRET_HEX is not set.',
        '!!',
        '!! The contract maintenance authority (CMA / upgrade key) will be a RANDOM key',
        '!! sampled by deployContract() and stored ONLY in the local private-state store.',
        '!! If that local store is ever lost, this contract can NEVER be upgraded again',
        '!! (no verifier-key / maintenance update is possible without the CMA).',
        '!!',
        '!! Set DAREU_CMA_SECRET_HEX (32-byte hex, e.g. `openssl rand -hex 32`) for any',
        '!! production or long-lived deploy. Back it up COLD, alongside',
        '!! DAREU_OWNER_SECRET_KEY — never on the keeper server.',
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        '',
      ].join('\n'),
    )
    return { signingKey: undefined, verifyingKeyHex: undefined, deterministic: false }
  }

  const cmaSecretBytes = parseHexBytes(cmaSecretHex, 32, 'DAREU_CMA_SECRET_HEX')
  const cmaSigningKey = signingKeyFromBip340(cmaSecretBytes)
  const verifyingKeyHex = signatureVerifyingKey(cmaSigningKey)

  console.log(`Contract maintenance authority (CMA): deterministic, derived from DAREU_CMA_SECRET_HEX.`)
  console.log(`CMA verifying key: ${verifyingKeyHex}`)

  return { signingKey: cmaSigningKey, verifyingKeyHex, deterministic: true }
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
