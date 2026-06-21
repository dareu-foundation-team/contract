// Keeper SERVICE (M3): mirror on-chain market state into Postgres so the webapp can
// show live odds/status/outcome from the source of truth without each client querying
// the chain. Read-only — needs no wallet, only the indexer.
//
//   npm run keeper:sync -- preprod                       # one-shot
//   SYNC_INTERVAL_SEC=30 npm run keeper:sync -- preprod  # poll loop
import WebSocket from 'ws'
import pg from 'pg'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { ledger, MarketStatus, Outcome } from '../../src/managed/dareu/contract/index.js'
import { configureNetwork } from '../shared/midnight.js'
import { loadEnvFiles, optionalEnv, readDeployment, requiredEnv, resolveNetwork } from '../shared/chain.js'

// The indexer provider opens a WS subscription; give Node a global WebSocket.
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket

// On-chain enums → the lowercase strings the webapp/Postgres mirror columns expect.
const STATUS_TEXT: Record<number, string> = {
  [MarketStatus.OPEN]: 'open',
  [MarketStatus.PROPOSED]: 'proposed',
  [MarketStatus.DISPUTED]: 'disputed',
  [MarketStatus.RESOLVED]: 'resolved',
  [MarketStatus.CANCELLED]: 'cancelled',
}
const OUTCOME_TEXT: Record<number, string | null> = {
  [Outcome.NONE]: null,
  [Outcome.YES]: 'yes',
  [Outcome.NO]: 'no',
}

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')
}

export async function syncOnce(network: ReturnType<typeof resolveNetwork>): Promise<void> {
  const dbUrl = requiredEnv('DATABASE_URL')
  const config = configureNetwork(network) // sets network id + returns indexer URLs
  const { contractAddress } = readDeployment(network)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = indexerPublicDataProvider(config.indexer, config.indexerWS, WebSocket as any)

  const state = await provider.queryContractState(contractAddress)
  if (!state) {
    console.log('Contract state not found on the indexer yet.')
    return
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const led = ledger((state as any).data)

  // One client for the whole batch (avoid a connection per row).
  const client = new pg.Client({ connectionString: dbUrl })
  await client.connect()
  let n = 0
  try {
    for (const [id, m] of led.markets) {
      await client.query(
        `UPDATE markets
            SET onchain_status = $2, onchain_yes_pool = $3, onchain_no_pool = $4,
                onchain_outcome = $5, synced_at = now()
          WHERE id = $1`,
        [toHex(id), STATUS_TEXT[m.status] ?? null, m.yes_pool.toString(), m.no_pool.toString(), OUTCOME_TEXT[m.outcome] ?? null],
      )
      n++
    }
  } finally {
    await client.end()
  }
  console.log(`[sync] mirrored ${n} on-chain market(s) → Postgres.`)
}

async function main(): Promise<void> {
  loadEnvFiles()
  const network = resolveNetwork(process.argv[2])
  const intervalSec = Number(optionalEnv('SYNC_INTERVAL_SEC') ?? '0')

  if (intervalSec > 0) {
    console.log(`[sync] polling every ${intervalSec}s (Ctrl-C to stop)`)
    for (;;) {
      try {
        await syncOnce(network)
      } catch (err) {
        console.error('[sync] error:', err instanceof Error ? err.message : err)
      }
      await new Promise((r) => setTimeout(r, intervalSec * 1000))
    }
  } else {
    await syncOnce(network) // one-shot
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
