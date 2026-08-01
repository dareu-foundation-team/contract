// End-to-end value-flow model for the direct-resolution V2 lifecycle.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DareuV2Sim,
  Outcome,
  bytes32,
  participantId,
  userAddress,
  zswapPk,
  payoutBreakdown,
} from './helpers/simulator.js'

const NOW = 1_900_000_000
const CLOSE = BigInt(NOW + 86_400)
const AFTER_CLOSE = NOW + 90_000
const ownerKey = bytes32('owner')
const operatorKey = bytes32('operator')
const oracleKey = bytes32('oracle')

class Book {
  underlyingIn = 0n
  underlyingOut = 0n
  snightMinted = 0n
  snightBurned = 0n

  get held() { return this.underlyingIn - this.underlyingOut }
  get circulating() { return this.snightMinted - this.snightBurned }
}

function assertSolvent(
  book: Book,
  unsettledPools: bigint,
  unsweptFees: bigint,
  label: string,
) {
  const liabilities = book.circulating + unsettledPools + unsweptFees
  assert.ok(
    book.held >= liabilities,
    `[${label}] held ${book.held} must cover liabilities ${liabilities}`,
  )
}

test('direct resolve, cancel/refund, fee sweep, and lost-ticket flows remain solvent', () => {
  const sim = DareuV2Sim.deploy({
    ownerKey,
    operatorId: participantId(operatorKey),
  })
  const book = new Book()
  let unsettled = 0n
  let fees = 0n

  for (const user of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    sim.deposit(bytes32(user), 10_000n, zswapPk(user), bytes32(`dep:${user}`), NOW)
    book.underlyingIn += 10_000n
    book.snightMinted += 10_000n
  }
  assertSolvent(book, unsettled, fees, 'deposits')

  // Market A: direct YES resolution, winner claims, owner sweeps fees.
  const marketA = bytes32('A')
  sim.createMarket(ownerKey, marketA, participantId(oracleKey), CLOSE, NOW)
  const alice = sim.placeBet(bytes32('alice'), marketA, Outcome.YES, 1_000n, sim.betCoin(marketA, 1_000n, 'A-a'), zswapPk('alice'), bytes32('A-na'), NOW)
  sim.placeBet(bytes32('bob'), marketA, Outcome.NO, 1_000n, sim.betCoin(marketA, 1_000n, 'A-b'), zswapPk('bob'), bytes32('A-nb'), NOW)
  const feeA = sim.stakeFee(marketA, 1_000n)
  book.snightBurned += 2_000n + feeA * 2n
  unsettled += 2_000n
  fees += feeA * 2n
  assertSolvent(book, unsettled, fees, 'market A bets')

  sim.resolveMarket(oracleKey, marketA, Outcome.YES, AFTER_CLOSE)
  const payoutA = payoutBreakdown({
    amount: 1_000n,
    winners: 1_000n,
    losers: 1_000n,
    platformBps: 200n,
  })
  sim.claimSettled(bytes32('alice'), alice, zswapPk('alice'), sim.ticketFor(alice), payoutA.grossProfit, payoutA.platformFee, NOW)
  book.snightMinted += payoutA.payout
  unsettled -= 2_000n
  assertSolvent(book, unsettled, fees, 'market A claim')

  sim.withdrawTreasury(ownerKey, marketA, userAddress('treasury'), NOW)
  book.underlyingOut += feeA * 2n
  fees -= feeA * 2n
  assertSolvent(book, unsettled, fees, 'market A fee sweep')

  // Market B: cancellation returns stake and the up-front fee.
  const marketB = bytes32('B')
  sim.createMarket(operatorKey, marketB, participantId(oracleKey), CLOSE, NOW)
  const carol = sim.placeBet(bytes32('carol'), marketB, Outcome.YES, 500n, sim.betCoin(marketB, 500n, 'B-c'), zswapPk('carol'), bytes32('B-nc'), NOW)
  const feeB = sim.stakeFee(marketB, 500n)
  book.snightBurned += 500n + feeB
  unsettled += 500n
  fees += feeB
  sim.cancelMarket(operatorKey, marketB, AFTER_CLOSE)
  sim.claimSettled(bytes32('carol'), carol, zswapPk('carol'), sim.ticketFor(carol), 0n, feeB, NOW)
  book.snightMinted += 500n + feeB
  unsettled -= 500n
  fees -= feeB
  assertSolvent(book, unsettled, fees, 'market B refund')

  // Market C resolves, but the winner loses the claim ticket. No payout is minted,
  // so the corresponding underlying remains as permanent surplus.
  const marketC = bytes32('C')
  sim.createMarket(ownerKey, marketC, participantId(oracleKey), CLOSE, NOW)
  const dave = sim.placeBet(bytes32('dave'), marketC, Outcome.YES, 1_000n, sim.betCoin(marketC, 1_000n, 'C-d'), zswapPk('dave'), bytes32('C-nd'), NOW)
  sim.placeBet(bytes32('erin'), marketC, Outcome.NO, 1_000n, sim.betCoin(marketC, 1_000n, 'C-e'), zswapPk('erin'), bytes32('C-ne'), NOW)
  const feeC = sim.stakeFee(marketC, 1_000n)
  book.snightBurned += 2_000n + feeC * 2n
  unsettled += 2_000n
  fees += feeC * 2n
  sim.resolveMarket(oracleKey, marketC, Outcome.YES, AFTER_CLOSE)
  assert.equal(sim.ledger.positions.lookup(dave).claimed, false)
  assertSolvent(book, unsettled, fees, 'lost ticket surplus')
})
