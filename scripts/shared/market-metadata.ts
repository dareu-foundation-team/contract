import { createHash } from 'node:crypto'

// Deterministic market identity logic used by the admin CLI to create markets.
// Computes the on-chain market_id + metadata_hash and the canonical metadata that
// gets stored in Postgres. (Postgres is trusted as the metadata source of truth,
// so the browser no longer recomputes this — it just reads the stored metadata.)

export type MarketMetadata = {
  title: string
  description: string | null
  category: string | null
  closeTime: string // ISO 8601
  outcomes: ['YES', 'NO']
  oracleParticipantId: string // 0x-prefixed 32-byte hex
  resolutionSource: string | null
  imageUrl: string | null
  externalId: string | null
  network: string
}

export type PreparedMarket = {
  marketId: string
  marketIdHex: string
  metadataHash: string
  metadataHashHex: string
  metadata: MarketMetadata
  contractCall: {
    circuit: 'create_market'
    args: { market_id: string; metadata_hash: string; oracle: string; close_time: number }
  }
}

export type MarketInput = {
  title: string
  description?: string | null
  category?: string | null
  closeTime: string | number
  oracleParticipantId: string
  resolutionSource?: string | null
  imageUrl?: string | null
  externalId?: string | null
  network: string
}

function asString(value: unknown, field: string, required = true): string | undefined {
  if (typeof value !== 'string') {
    if (required) throw new Error(`${field} is required`)
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed && required) throw new Error(`${field} is required`)
  return trimmed || undefined
}

function normalizeBytes32Hex(value: unknown, field: string): string {
  const raw = asString(value, field)!
  const normalized = raw.replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a 32-byte hex string`)
  }
  return `0x${normalized}`
}

function parseCloseTime(value: string | number): Date {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('closeTime must be a valid date')
  return date
}

// Canonical JSON serializer: object keys are sorted recursively so the SAME logical
// object always produces byte-identical output regardless of insertion order. This
// determinism is what lets the hashes below be reproduced and verified by anyone
// (the browser, DataProvider, or an auditor) from the stored metadata.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function prepareMarket(input: MarketInput): PreparedMarket {
  const title = asString(input.title, 'title')!
  const closeTime = parseCloseTime(input.closeTime)
  const oracleParticipantId = normalizeBytes32Hex(input.oracleParticipantId, 'oracleParticipantId')

  const metadata: MarketMetadata = {
    title,
    description: asString(input.description, 'description', false) ?? null,
    category: asString(input.category, 'category', false) ?? null,
    closeTime: closeTime.toISOString(),
    outcomes: ['YES', 'NO'],
    oracleParticipantId,
    resolutionSource: asString(input.resolutionSource, 'resolutionSource', false) ?? null,
    imageUrl: asString(input.imageUrl, 'imageUrl', false) ?? null,
    externalId: asString(input.externalId, 'externalId', false) ?? null,
    network: input.network,
  }

  // metadata_hash = sha256 of the canonical metadata. This is the value committed
  // on-chain in create_market, so altering any stored field would change the hash
  // and break the commitment — that's what binds the off-chain text to the chain.
  const metadataHash = sha256Hex(stableJson(metadata))
  // market_id = sha256 over a small namespaced identity tuple that INCLUDES the
  // metadata_hash. Deterministic (same inputs -> same id) and domain-separated by
  // `namespace`, so ids are reproducible and can't collide with other hash schemes.
  const marketId = sha256Hex(
    stableJson({
      namespace: 'dareu:market',
      network: input.network,
      title: metadata.title,
      closeTime: metadata.closeTime,
      metadataHash,
    }),
  )

  return {
    marketId,
    marketIdHex: `0x${marketId}`,
    metadataHash,
    metadataHashHex: `0x${metadataHash}`,
    metadata,
    contractCall: {
      circuit: 'create_market',
      args: {
        market_id: `0x${marketId}`,
        metadata_hash: `0x${metadataHash}`,
        oracle: metadata.oracleParticipantId,
        close_time: Math.floor(closeTime.getTime() / 1000),
      },
    },
  }
}
