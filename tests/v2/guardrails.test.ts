// Guards for the audit FIX 2 (close_time overflow bound) and FIX 3 (close_time >
// betting_cutoff, preventing place_bet subtraction underflow).
//
// Run: node --import tsx --test "tests/v2/**/*.test.ts"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DareuV2Sim,
  Outcome,
  bytes32,
  participantId,
  zswapPk,
  expectRevert,
} from './helpers/simulator.js';

const NOW = 1_900_000_000;
const ownerKey = bytes32('owner');
const oracleKey = bytes32('oracle');

// A close_time above the FIX-2 bound (0xF000000000000000) but a valid block time
// (block time is `now`, which is far below it) — the unreasonable-close assert fires.
const OVER_BOUND = 0xf000000000000000n; // == the bound; assert requires strictly less

test('FIX 2: close_time at/above 0xF000000000000000 is rejected as unreasonable', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  // At the bound: rejected (assert is strict `<`).
  expectRevert(
    () => sim.createMarket(ownerKey, bytes32('m-at'), participantId(oracleKey), OVER_BOUND, NOW, { bettingCutoff: 300n }),
    'close_time unreasonable',
  );
  // Above the bound: also rejected.
  expectRevert(
    () => sim.createMarket(ownerKey, bytes32('m-over'), participantId(oracleKey), OVER_BOUND + 1_000n, NOW, { bettingCutoff: 300n }),
    'close_time unreasonable',
  );
});

test('FIX 2: a normal far-future close_time (well below the bound) is accepted', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  const close = BigInt(NOW + 86_400);
  sim.createMarket(ownerKey, bytes32('m-ok'), participantId(oracleKey), close, NOW, { bettingCutoff: 300n });
  assert.equal(Number(sim.ledger.markets.lookup(bytes32('m-ok')).status), 0, 'OPEN');
});

test('FIX 3: close_time must strictly exceed betting_cutoff', () => {
  const sim = DareuV2Sim.deploy({ ownerKey });
  // close_time == betting_cutoff is rejected. Use a small close_time equal to the
  // (max) cutoff so the strict-greater assert is what fires. betting_cutoff max is
  // 1800; pick close_time == 1800. (Block-time "future" check would also fire for a
  // tiny close_time, so we drive `now` back before it to isolate the FIX-3 assert.)
  const cutoff = 1800n;
  const closeEq = 1800n; // == cutoff
  // now must be < close_time for the "future" check; set now = 1 so close (1800) is future.
  expectRevert(
    () => sim.createMarket(ownerKey, bytes32('m-eq'), participantId(oracleKey), closeEq, 1, { bettingCutoff: cutoff }),
    'close_time must exceed betting_cutoff',
  );
});

test('FIX 3: place_bet subtraction never underflows for a stored market', () => {
  // A market that passed create_market has close_time > betting_cutoff by FIX 3, so
  // place_bet's (close_time - betting_cutoff) is safe. Sanity: a valid bet works.
  const sim = DareuV2Sim.deploy({ ownerKey });
  const m = bytes32('m-bet');
  const close = BigInt(NOW + 86_400);
  sim.createMarket(ownerKey, m, participantId(oracleKey), close, NOW, { bettingCutoff: 300n });
  // Bet succeeds (no underflow in the betting-window check).
  const pos = sim.placeBet(bytes32('alice'), m, Outcome.YES, 100n, sim.snightCoin(100n, 'a'),
    zswapPk('alice'), bytes32('pn'), NOW);
  assert.equal(pos.length, 32);
});
