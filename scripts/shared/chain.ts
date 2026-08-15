import * as fs from 'node:fs'
import * as path from 'node:path'

import pg from 'pg'
import { fromHex } from '@midnight-ntwrk/midnight-js-utils'
import {
  signingKeyFromBip340,
  signatureVerifyingKey,
  type SigningKey,
} from '@midnight-ntwrk/midnight-js-protocol/ledger'

import { contractRoot } from './midnight.js'

// Re-export for the current V2 admin and Keeper entrypoints.
export { resolveNetwork } from './network.js'

// Shared env, Postgres and maintenance-authority infrastructure.

const defaultEnvFiles = ['.env', '.env.local']

function positiveTimeout(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; received ${JSON.stringify(raw)}.`)
  }
  return value
}

export function pgClientConfig(connectionString: string): pg.ClientConfig {
  return {
    connectionString,
    application_name: process.env.DAREU_KEEPER_CATEGORY
      ? `dareu-keeper-${process.env.DAREU_KEEPER_CATEGORY}`
      : 'dareu-maintenance',
    connectionTimeoutMillis: positiveTimeout('PG_CONNECT_TIMEOUT_MS', 10_000),
    query_timeout: positiveTimeout('PG_QUERY_TIMEOUT_MS', 30_000),
    statement_timeout: positiveTimeout('PG_STATEMENT_TIMEOUT_MS', 30_000),
    lock_timeout: positiveTimeout('PG_LOCK_TIMEOUT_MS', 10_000),
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
  }
}

export function createPgClient(connectionString: string): pg.Client {
  return new pg.Client(pgClientConfig(connectionString))
}

export async function closePgClient(client: pg.Client): Promise<void> {
  const timeoutMs = positiveTimeout('PG_CLOSE_TIMEOUT_MS', 5_000)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.end(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Postgres client close timed out after ${timeoutMs}ms`)
          ;(error as Error & { code?: string }).code = 'PG_CLOSE_TIMEOUT'
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// One-shot Postgres exec (standard `pg`; opens/closes a connection per call).
export async function pgExec(connectionString: string, text: string, params: unknown[]) {
  const client = createPgClient(connectionString)
  let operationFailed = false
  try {
    await client.connect()
    return await client.query(text, params)
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    try {
      await closePgClient(client)
    } catch (closeError) {
      // Preserve the connect/query error when both the operation and teardown fail.
      // A standalone close timeout remains fatal so the keeper supervisor restarts.
      if (!operationFailed) throw closeError
    }
  }
}

export function loadEnvFiles() {
  const explicitEnvFile = process.env.DAREU_ENV_FILE?.trim()
  const envFiles = explicitEnvFile
    ? [explicitEnvFile, ...defaultEnvFiles]
    : defaultEnvFiles

  for (const filename of envFiles) {
    const envPath = path.isAbsolute(filename) ? filename : path.join(contractRoot, filename)
    if (filename === explicitEnvFile && !fs.existsSync(envPath)) {
      throw new Error(`DAREU_ENV_FILE does not exist: ${envPath}`)
    }
    if (!fs.existsSync(envPath)) continue
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const sep = trimmed.indexOf('=')
      if (sep === -1) continue
      const key = trimmed.slice(0, sep).trim()
      const value = trimmed.slice(sep + 1).trim().replace(/^['"]|['"]$/g, '')
      // A category-specific Keeper file is authoritative for its wallet. Common
      // .env/.env.local values fill only variables that it did not define.
      if (key && (filename === explicitEnvFile || process.env[key] === undefined)) process.env[key] = value
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
