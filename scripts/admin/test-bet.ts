import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { connectKeeper, requiredEnv, loadEnvFiles } from '../shared/chain.js'
import { resolveNetwork } from '../shared/network.js'
import { Outcome } from '../../src/managed/dareu/contract/index.js'

loadEnvFiles()
const c = new pg.Client({ connectionString: requiredEnv('DATABASE_URL') })
await c.connect()
const { rows } = await c.query(
  "SELECT id, left(title,50) title FROM markets WHERE close_time > now() AND onchain_tx_id IS NOT NULL AND length(onchain_tx_id) >= 40 ORDER BY updated_at DESC LIMIT 1",
)
await c.end()
const market = rows[0]
console.log('place_bet test on:', market.title, '| id', market.id.slice(0, 16))

const { deployed } = await connectKeeper(resolveNetwork('preprod'))
const marketId = Uint8Array.from(Buffer.from(market.id, 'hex'))
try {
  const result = await deployed.callTx.place_bet(marketId, Outcome.YES, 1n, new Uint8Array(randomBytes(32)))
  console.log('RESULT_OK', result?.public?.txId ?? 'ok')
} catch (e: any) {
  // 把整条 cause 链平铺打印,找节点的真实错误码/原因
  let cur: any = e, depth = 0
  while (cur && depth < 12) {
    console.log(`--- cause[${depth}] ---`)
    console.log('  name:', cur?.name, '| message:', cur?.message, '| _tag:', cur?._tag)
    cur = cur?.cause ?? cur?.failure ?? null; depth++
  }
}
process.exit(0)
