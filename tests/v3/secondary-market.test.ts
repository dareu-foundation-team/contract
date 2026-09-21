import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DareuV3Sim,
  FundingMode,
  Outcome,
  PositionStatus,
  SaleStatus,
  bytes32,
  expectRevert,
  participantId,
  zswapPk,
} from './helpers/simulator.js';

const NOW = 1_000;
const CLOSE = 3_000n;
const DEADLINE = 2_700n;

function fixture() {
  const owner = bytes32('owner');
  const operator = bytes32('operator');
  const oracle = bytes32('oracle');
  const seller = bytes32('seller');
  const buyer = bytes32('buyer');
  const sim = DareuV3Sim.deploy({ ownerKey: owner, operatorId: participantId(operator) });
  const marketId = bytes32('market');
  sim.createMarket(operator, marketId, participantId(oracle), CLOSE, NOW);
  return { sim, owner, operator, oracle, seller, buyer, marketId };
}

function poolSnapshot(sim: DareuV3Sim, marketId: Uint8Array) {
  const market = sim.ledger.markets.lookup(marketId);
  return [market.yes_pool, market.no_pool, market.total_pool] as const;
}

describe('DareU v3 primary funding modes', () => {
  test('shielded and unshielded entry create equivalent pool positions', () => {
    const { sim, seller, buyer, marketId } = fixture();
    const shieldedFee = sim.stakeFee(marketId, 100n);
    const shielded = sim.placeBet(
      seller,
      marketId,
      Outcome.YES,
      100n,
      sim.betCoin(marketId, 100n, 'shielded'),
      zswapPk('seller'),
      bytes32('shielded-pos'),
      NOW + 1,
    );
    assert.equal(sim.ledger.positions.lookup(shielded).fee_paid, shieldedFee);
    assert.equal(sim.lastEffects.unshieldedInputs.size, 0);

    const publicFee = sim.stakeFee(marketId, 200n);
    const publicPos = sim.placeBetUnshielded(
      buyer,
      marketId,
      Outcome.NO,
      200n,
      zswapPk('buyer'),
      bytes32('public-pos'),
      NOW + 2,
    );
    assert.equal(sim.ledger.positions.lookup(publicPos).fee_paid, publicFee);
    assert.equal(
      sim.lastEffects.unshieldedInputs.get(sim.underlyingColorHex),
      200n + publicFee,
    );
    assert.deepEqual(poolSnapshot(sim, marketId), [100n, 200n, 300n]);
  });

  test('shielded entry spends a larger vault coin and privately returns change', () => {
    const { sim, seller, marketId } = fixture();
    const amount = 100n;
    const fee = sim.stakeFee(marketId, amount);
    const vaultCoin = sim.snightCoin(740n, 'vault');

    sim.placeBet(
      seller,
      marketId,
      Outcome.YES,
      amount,
      vaultCoin,
      zswapPk('seller'),
      bytes32('change-pos'),
      NOW + 1,
    );

    assert.ok([...sim.lastEffects.shieldedMints.values()].includes(740n - amount - fee));
    assert.ok([...sim.lastEffects.shieldedMints.values()].includes(1n));
  });
});

describe('DareU v3 whole-position sales', () => {
  test('listing escrows the claim ticket and never changes the parimutuel pool', () => {
    const { sim, seller, marketId } = fixture();
    const pos = sim.placeBetUnshielded(
      seller,
      marketId,
      Outcome.YES,
      100n,
      zswapPk('seller'),
      bytes32('pos'),
      NOW + 1,
    );
    const pools = poolSnapshot(sim, marketId);
    const order = sim.listPosition(
      seller,
      pos,
      sim.ticketFor(pos, 0n),
      150n,
      FundingMode.SHIELDED,
      zswapPk('seller'),
      bytes32('seller-salt'),
      bytes32('sale'),
      2_500n,
      NOW + 2,
    );

    const position = sim.ledger.positions.lookup(pos);
    const sale = sim.ledger.sales.lookup(order);
    assert.equal(position.status, PositionStatus.LISTED);
    assert.deepEqual(position.active_sale, order);
    assert.equal(sale.status, SaleStatus.OPEN);
    assert.equal(sale.ask_price, 150n);
    assert.deepEqual(poolSnapshot(sim, marketId), pools);
    assert.ok([...sim.lastEffects.shieldedMints.values()].includes(1n));

    expectRevert(
      () =>
        sim.listPosition(
          seller,
          pos,
          sim.ticketFor(pos, 0n, 'again'),
          160n,
          FundingMode.SHIELDED,
          zswapPk('seller'),
          bytes32('salt-2'),
          bytes32('sale-2'),
          2_500n,
          NOW + 3,
        ),
      'Position is not active',
    );
  });

  test('shielded fill atomically pays seller, advances ownership revision, and leaves pool unchanged', () => {
    const { sim, seller, buyer, marketId } = fixture();
    const sellerPk = zswapPk('seller');
    const sellerSalt = bytes32('salt');
    const pos = sim.placeBet(
      seller,
      marketId,
      Outcome.YES,
      100n,
      sim.betCoin(marketId, 100n, 'bet'),
      sellerPk,
      bytes32('pos'),
      NOW + 1,
    );
    const order = sim.listPosition(
      seller,
      pos,
      sim.ticketFor(pos, 0n),
      150n,
      FundingMode.SHIELDED,
      sellerPk,
      sellerSalt,
      bytes32('sale'),
      2_500n,
      NOW + 2,
    );
    const pools = poolSnapshot(sim, marketId);

    sim.fillSaleShielded(
      buyer,
      order,
      sim.snightCoin(150n, 'payment'),
      sellerPk,
      sellerSalt,
      zswapPk('buyer'),
      NOW + 3,
    );

    assert.equal(sim.ledger.sales.lookup(order).status, SaleStatus.FILLED);
    assert.equal(sim.ledger.positions.lookup(pos).status, PositionStatus.ACTIVE);
    assert.equal(sim.ledger.positions.lookup(pos).revision, 1n);
    assert.deepEqual(poolSnapshot(sim, marketId), pools);
    assert.ok([...sim.lastEffects.shieldedMints.values()].includes(150n));
    assert.ok([...sim.lastEffects.shieldedMints.values()].includes(1n));

    expectRevert(
      () =>
        sim.fillSaleShielded(
          buyer,
          order,
          sim.snightCoin(150n, 'again'),
          sellerPk,
          sellerSalt,
          zswapPk('buyer'),
          NOW + 4,
        ),
      'Sale is not open',
    );
  });

  test('unshielded fill receives exact public payment and gives seller shielded sNIGHT', () => {
    const { sim, seller, buyer, marketId } = fixture();
    const sellerPk = zswapPk('seller');
    const sellerSalt = bytes32('salt');
    const pos = sim.placeBetUnshielded(
      seller,
      marketId,
      Outcome.NO,
      80n,
      sellerPk,
      bytes32('pos'),
      NOW + 1,
    );
    const order = sim.listPosition(
      seller,
      pos,
      sim.ticketFor(pos, 0n),
      120n,
      FundingMode.UNSHIELDED,
      sellerPk,
      sellerSalt,
      bytes32('sale'),
      2_500n,
      NOW + 2,
    );
    const pools = poolSnapshot(sim, marketId);
    sim.fillSaleUnshielded(
      buyer,
      order,
      sellerPk,
      sellerSalt,
      zswapPk('buyer'),
      NOW + 3,
    );

    assert.equal(sim.lastEffects.unshieldedInputs.get(sim.underlyingColorHex), 120n);
    assert.ok([...sim.lastEffects.shieldedMints.values()].includes(120n));
    assert.deepEqual(poolSnapshot(sim, marketId), pools);
  });

  test('payment mode and seller commitment are bound into the order', () => {
    const { sim, seller, buyer, marketId } = fixture();
    const sellerPk = zswapPk('seller');
    const sellerSalt = bytes32('salt');
    const pos = sim.placeBetUnshielded(
      seller,
      marketId,
      Outcome.YES,
      100n,
      sellerPk,
      bytes32('pos'),
      NOW + 1,
    );
    const order = sim.listPosition(
      seller,
      pos,
      sim.ticketFor(pos, 0n),
      150n,
      FundingMode.SHIELDED,
      sellerPk,
      sellerSalt,
      bytes32('sale'),
      2_500n,
      NOW + 2,
    );

    expectRevert(
      () => sim.fillSaleUnshielded(buyer, order, sellerPk, sellerSalt, zswapPk('buyer'), NOW + 3),
      'Wrong payment mode',
    );
    expectRevert(
      () =>
        sim.fillSaleShielded(
          buyer,
          order,
          sim.snightCoin(150n, 'pay'),
          sellerPk,
          bytes32('wrong-salt'),
          zswapPk('buyer'),
          NOW + 3,
        ),
      'Seller payment details do not match',
    );
  });

  test('cancel restores a new ticket revision and an expired order cannot fill', () => {
    const { sim, seller, buyer, marketId } = fixture();
    const sellerPk = zswapPk('seller');
    const salt = bytes32('salt');
    const pos = sim.placeBetUnshielded(
      seller,
      marketId,
      Outcome.YES,
      100n,
      sellerPk,
      bytes32('pos'),
      NOW + 1,
    );
    const order = sim.listPosition(
      seller,
      pos,
      sim.ticketFor(pos, 0n),
      150n,
      FundingMode.SHIELDED,
      sellerPk,
      salt,
      bytes32('sale'),
      1_100n,
      NOW + 2,
    );
    expectRevert(
      () =>
        sim.fillSaleShielded(
          buyer,
          order,
          sim.snightCoin(150n, 'late'),
          sellerPk,
          salt,
          zswapPk('buyer'),
          1_101,
        ),
      'Sale has expired',
    );
    sim.cancelSale(
      seller,
      order,
      sim.saleControlTicket(order),
      sellerPk,
      1_101,
    );
    assert.equal(sim.ledger.sales.lookup(order).status, SaleStatus.EXPIRED);
    assert.equal(sim.ledger.positions.lookup(pos).revision, 1n);
    assert.equal(sim.ledger.positions.lookup(pos).status, PositionStatus.ACTIVE);
  });

  test('buyer revision is the only claim right after a fill', () => {
    const { sim, seller, buyer, oracle, marketId } = fixture();
    const sellerPk = zswapPk('seller');
    const buyerPk = zswapPk('buyer');
    const salt = bytes32('salt');
    const yes = sim.placeBetUnshielded(
      seller,
      marketId,
      Outcome.YES,
      100n,
      sellerPk,
      bytes32('yes'),
      NOW + 1,
    );
    sim.placeBetUnshielded(
      bytes32('no-bettor'),
      marketId,
      Outcome.NO,
      60n,
      zswapPk('no-bettor'),
      bytes32('no'),
      NOW + 1,
    );
    const order = sim.listPosition(
      seller,
      yes,
      sim.ticketFor(yes, 0n),
      140n,
      FundingMode.SHIELDED,
      sellerPk,
      salt,
      bytes32('sale'),
      2_500n,
      NOW + 2,
    );
    sim.fillSaleShielded(
      buyer,
      order,
      sim.snightCoin(140n, 'payment'),
      sellerPk,
      salt,
      buyerPk,
      NOW + 3,
    );
    sim.resolveMarket(oracle, marketId, Outcome.YES, Number(CLOSE + 1n));

    expectRevert(
      () => sim.claimSettled(seller, yes, sellerPk, sim.ticketFor(yes, 0n, 'old'), 60n, 3_002),
      'Position ticket mismatch',
    );
    sim.claimSettled(buyer, yes, buyerPk, sim.ticketFor(yes, 1n, 'buyer'), 60n, 3_002);
    assert.equal(sim.ledger.positions.lookup(yes).status, PositionStatus.CLAIMED);
    assert.ok([...sim.lastEffects.shieldedMints.values()].includes(160n));
  });

  test('a listed position can be recovered after resolution and then claimed', () => {
    const { sim, seller, oracle, marketId } = fixture();
    const sellerPk = zswapPk('seller');
    const yes = sim.placeBetUnshielded(
      seller,
      marketId,
      Outcome.YES,
      100n,
      sellerPk,
      bytes32('yes'),
      NOW + 1,
    );
    sim.placeBetUnshielded(
      bytes32('no-bettor'),
      marketId,
      Outcome.NO,
      100n,
      zswapPk('no'),
      bytes32('no'),
      NOW + 1,
    );
    const order = sim.listPosition(
      seller,
      yes,
      sim.ticketFor(yes, 0n),
      130n,
      FundingMode.SHIELDED,
      sellerPk,
      bytes32('salt'),
      bytes32('sale'),
      DEADLINE,
      NOW + 2,
    );
    sim.resolveMarket(oracle, marketId, Outcome.YES, Number(CLOSE + 1n));
    expectRevert(
      () => sim.claimSettled(seller, yes, sellerPk, sim.ticketFor(yes, 0n), 100n, 3_002),
      'Position is not active',
    );
    sim.cancelSale(
      seller,
      order,
      sim.saleControlTicket(order),
      sellerPk,
      3_002,
    );
    sim.claimSettled(seller, yes, sellerPk, sim.ticketFor(yes, 1n), 100n, 3_003);
    assert.equal(sim.ledger.positions.lookup(yes).status, PositionStatus.CLAIMED);
  });
});
