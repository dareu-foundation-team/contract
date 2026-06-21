// Drift guard for prepareMarket. Asserts a fixed input still produces the same
// market_id / metadata_hash. DataProvider vendors a copy of market-metadata.ts and
// runs the SAME golden values (DataProvider/src/market-metadata.golden.ts); if the
// two diverge, one of the golden tests fails before bad ids reach Postgres / chain.
//
//   npx tsx scripts/market-metadata.golden.ts   (exits 1 on mismatch)
import { prepareMarket } from './market-metadata.js'

const EXPECTED = {
  marketId: 'ec2a1d1979de637603cd77ff864121c1afef777fecbef2f5c59e94154c74fa42',
  metadataHash: 'd6fc82941e36f7057989ddc126fd5e80c9931e84362713826166020af0860806',
}

const p = prepareMarket({
  title: 'GOLDEN: Will BTC close above $100,000 by 2030-01-01 (UTC)?',
  category: 'crypto',
  closeTime: '2030-01-01T00:00:00.000Z',
  oracleParticipantId: '0'.repeat(64),
  resolutionSource: 'golden-test',
  externalId: 'golden:fixed:v1',
  network: 'preprod',
})

let ok = true
for (const [k, want] of Object.entries(EXPECTED)) {
  const got = (p as unknown as Record<string, unknown>)[k]
  if (got !== want) {
    console.error(`✗ ${k}\n    expected ${want}\n    got      ${got}`)
    ok = false
  }
}

if (!ok) {
  console.error('\nprepareMarket drifted from the golden values. Reconcile with DataProvider before committing.')
  process.exit(1)
}
console.log('✓ market-metadata golden hashes match')
