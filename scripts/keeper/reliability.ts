// Shared failure policy for the long-running V2 keeper.
//
// A Midnight callTx can remain pending after its Indexer/RPC websocket dies.  A
// timed-out call cannot be cancelled safely in-process, so timeouts are fatal and
// the external supervisor restarts a fresh Node process.  Transport errors that
// have already rejected are safe to handle by closing the wallet and rebuilding
// it on the next keeper cycle.

export class KeeperTransactionTimeoutError extends Error {
  readonly code = 'KEEPER_TX_TIMEOUT'

  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms; exiting so the keeper can restart with a fresh wallet context.`)
    this.name = 'KeeperTransactionTimeoutError'
  }
}

export class KeeperContextBrokenError extends Error {
  readonly code = 'KEEPER_CONTEXT_BROKEN'

  constructor(readonly operation: string, cause: unknown) {
    super(`${operation} lost its wallet/Indexer/RPC context: ${errorMessage(cause)}`)
    this.name = 'KeeperContextBrokenError'
    ;(this as Error & { cause?: unknown }).cause = cause
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer; received ${JSON.stringify(raw)}.`)
  }
  return value
}

export function keeperTimeoutMs(envName = 'KEEPER_TX_TIMEOUT_MS', fallback = 15 * 60 * 1000): number {
  return positiveInteger(process.env[envName], fallback, envName)
}

export function keeperBatchLimit(
  envName: string,
  fallback = 20,
  maxEnvName = 'KEEPER_MAX_BATCH_SIZE',
  maxFallback = 50,
): number {
  const requested = positiveInteger(process.env[envName], fallback, envName)
  const max = positiveInteger(process.env[maxEnvName], maxFallback, maxEnvName)
  if (requested > max) {
    console.warn(`[keeper-v2] ${envName}=${requested} capped at ${max} by ${maxEnvName}.`)
    return max
  }
  return requested
}

export async function withKeeperTransactionTimeout<T>(
  operation: string,
  run: () => Promise<T>,
  timeoutMs = keeperTimeoutMs(),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new KeeperTransactionTimeoutError(operation, timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(run), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function isKeeperTransactionTimeout(error: unknown): error is KeeperTransactionTimeoutError {
  return error instanceof KeeperTransactionTimeoutError ||
    (error instanceof Error && (error as Error & { code?: string }).code === 'KEEPER_TX_TIMEOUT')
}

export function isBrokenKeeperContext(error: unknown): boolean {
  if (isKeeperTransactionTimeout(error) || error instanceof KeeperContextBrokenError) return true
  const message = errorMessage(error)
  return /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|socket hang up|websocket|wallet\.sync|servererror|connection.*(?:closed|lost|reset)|disconnected|Custom error:\s*170/i.test(message)
}

/** Re-throw transport failures so the current wallet is never reused for the next row. */
export function abortBatchIfContextBroken(operation: string, error: unknown): void {
  if (isKeeperTransactionTimeout(error)) throw error
  if (isBrokenKeeperContext(error)) throw new KeeperContextBrokenError(operation, error)
}

export async function stopWalletSafely(
  wallet: { stop(): Promise<unknown> },
  label: string,
): Promise<void> {
  const timeoutMs = keeperTimeoutMs('KEEPER_WALLET_STOP_TIMEOUT_MS', 30_000)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      wallet.stop(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} wallet.stop timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } catch (error) {
    console.warn(`[keeper-v2] ${errorMessage(error)}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
}
