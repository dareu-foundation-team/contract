// Shared keys, a canonical timeline, and scenario builders for the test suites.
import { DareuSim, Outcome, bytes32, participantId } from './simulator.js';

export const KEYS = {
  owner: bytes32('owner'),
  oracle: bytes32('oracle'),
  alice: bytes32('alice'),
  bob: bytes32('bob'),
  carol: bytes32('carol'),
  arbiter1: bytes32('arb1'),
  arbiter2: bytes32('arb2'),
  leader: bytes32('leader'),
  stranger: bytes32('stranger'),
};

export const IDS = {
  owner: participantId(KEYS.owner),
  oracle: participantId(KEYS.oracle),
  alice: participantId(KEYS.alice),
  bob: participantId(KEYS.bob),
  leader: participantId(KEYS.leader),
  arbiter1: participantId(KEYS.arbiter1),
  arbiter2: participantId(KEYS.arbiter2),
};

export const TOKEN = bytes32('token');
export const LEADER_BPS = 1000n; // 10%
export const PLATFORM_BPS = 200n; // 2%

// Canonical timeline (absolute unix seconds, year ~2030 with wide margins).
export const T = {
  now: 1_900_000_000,
  close: 1_900_000_000 + 86_400, // market closes 1 day out
};
export const CLOSE = BigInt(T.close);
// propose deadline must be >= close + challenge_window (7200) and in the future.
export const DEADLINE = CLOSE + 8_000n;

export const TIME = {
  now: T.now,
  create: T.now,
  bet: T.now + 10,
  afterClose: T.close + 100, // > close, < deadline → propose window
  duringChallenge: T.close + 200, // < deadline → dispute window
  voting: T.close + 300,
  afterDeadline: Number(DEADLINE) + 100, // finalize window
  // emergency cancel grace: blockTime > propose_deadline + challenge_window
  afterGrace: Number(DEADLINE + 7200n) + 100,
};

export function deploy(): DareuSim {
  return DareuSim.deploy({
    ownerKey: KEYS.owner,
    tokenType: TOKEN,
    leaderBps: LEADER_BPS,
    platformBps: PLATFORM_BPS,
  });
}

/** Deploy + create one OPEN market (id "m") with `oracle` as its oracle. */
export function withMarket(marketTag = 'm'): { sim: DareuSim; marketId: Uint8Array } {
  const sim = deploy();
  const marketId = bytes32(marketTag);
  sim.createMarket(KEYS.owner, marketId, bytes32('meta'), IDS.oracle, CLOSE, TIME.create);
  return { sim, marketId };
}

/**
 * Deploy + market + two opposing bets, returning the position ids.
 * Default: Alice YES 600, Bob NO 400 (no leader).
 */
export function withBets(opts?: {
  aliceAmount?: bigint;
  bobAmount?: bigint;
  aliceLeader?: Uint8Array;
}): {
  sim: DareuSim;
  marketId: Uint8Array;
  alicePos: Uint8Array;
  bobPos: Uint8Array;
} {
  const aliceAmount = opts?.aliceAmount ?? 600n;
  const bobAmount = opts?.bobAmount ?? 400n;
  const aliceLeader = opts?.aliceLeader ?? new Uint8Array(32);
  const { sim, marketId } = withMarket();
  const alicePos = sim.placeBet(
    KEYS.alice,
    marketId,
    Outcome.YES,
    aliceAmount,
    aliceLeader,
    bytes32('na'),
    TIME.bet,
  );
  const bobPos = sim.placeBet(
    KEYS.bob,
    marketId,
    Outcome.NO,
    bobAmount,
    new Uint8Array(32),
    bytes32('nb'),
    TIME.bet,
  );
  return { sim, marketId, alicePos, bobPos };
}
