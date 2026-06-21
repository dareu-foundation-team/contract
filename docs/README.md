# DareU Contract

A privacy-preserving (zero-knowledge) **prediction market** smart contract for the
[Midnight](https://midnight.network) blockchain, written in the **Compact** language.

Users bet **YES/NO** on binary markets. Each market holds two on-chain pools
(`yes_pool` / `no_pool`); when a market resolves, winners split the losing pool
pro-rata to their stake. Outcomes are decided by an **optimistic oracle** (propose →
dispute / finalize → arbiter vote) rather than a single trusted resolver. A bettor's
identity is a zero-knowledge `participant_id` derived from a secret key that never
leaves the client, so the link between a wallet and its positions/PnL stays private.

- **Network:** Midnight (Compact, `language_version >= 0.22`)
- **Source:** [`src/dareu.compact`](../src/dareu.compact)
- **Deployed (preprod):** `d62e23dce7a2439b1ff36903e21917ff6feb62d944b0426c403e09d5e74ba78d`

This document doubles as the design rationale and the usage guide. The first half
explains **why and how**; the second half (["Using the contract"](#using-the-contract))
is the practical build/deploy/CLI reference. Where this document and the code disagree,
**the code is authoritative.**

### Operational runbooks

`contract/` ships three independently deployable on-chain units, each with its own
runbook:

| Unit | What it does | Runbook |
| --- | --- | --- |
| **Smart contract** | Compile + deploy the contract to Midnight (first launch / on source changes) | [contract-runbook.md](./contract-runbook.md) |
| **Proof server** | Local ZK proving service (`:6300`); deploy / keeper / webapp all depend on it | [proof-server-runbook.md](./proof-server-runbook.md) |
| **Keeper** | Always-on automation: chain↔DB sync, draft markets on-chain, auto-propose resolutions | [keeper-runbook.md](./keeper-runbook.md) |

> Start order: **proof server** first → **deploy** (one-off) → **keeper** (long-running).

---

## Why — public prediction markets leak everything

A prediction market lets people stake on the outcome of a future event. On a
transparent public chain, every interaction is visible: which wallet bet, on which
side, how much, when, and — after settlement — exactly how much it won or lost. That
has real costs:

- **Position leakage** — anyone can see a wallet's open exposure on every market.
- **PnL leakage** — a wallet's complete win/loss history is reconstructable forever.
- **Strategy leakage** — large or informed bettors are trivially front-run, copied, or
  targeted; "smart money" can't act without telegraphing its hand.
- **Identity linkage** — all of a person's bets across all markets tie to one public
  address, building a permanent public dossier.

These are not incidental — they are the default behavior of a naive on-chain market.

## How — zero-knowledge privacy on Midnight

DareU is built on **Midnight**, whose Compact language separates **private witness
inputs** from **public ledger state** and enforces, at compile time, that nothing
private reaches the ledger unless it is explicitly **disclosed**.

The contract takes exactly one private input — the caller's secret key, via the witness
`local_secret_key()`. Identity is derived from it as a one-way hash:

```compact
circuit participant_id(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "dareu:participant:"), sk]);
}
circuit current_participant(): Bytes<32> {            // the contract's private "msg.sender"
  return participant_id(local_secret_key());
}
```

The chain only ever sees this `participant_id` — never the key. Positions are stored
under an unguessable `position_id = hash("dareu:position:", market_id, bettor, nonce)`,
so a wallet's bets are **not enumerable** from its public address, and a `nonce` lets
one identity hold many independent positions.

**Private vs public.** DareU protects the *linkage* between a real wallet and its
activity, not the aggregate market state. Pool sizes, bet amounts, sides, and payout
math are public so anyone can verify the market is solvent and payouts are correct.
Each such value is released deliberately with `disclose(...)`; because the compiler
rejects an undisclosed witness-derived write, every information release is intentional
and auditable rather than accidental.

---

## Architecture

### On-chain pools and commitments

Each market is a `Market` struct in the `markets: Map<Bytes<32>, Market>` ledger:

```compact
export struct Market {
  creator, oracle, metadata_hash: Bytes<32>,
  close_time: Uint<64>, status: MarketStatus, outcome: Outcome,
  yes_pool, no_pool, total_pool: Uint<64>,
}
```

Two pools (`yes_pool`, `no_pool`) accumulate stakes. A bet creates a `Position`
recording the side, amount, and optional copy-trading `leader`. Optional bet
commitments are kept in `commitments` so a client can later prove a bet's contents
off-chain without the contract storing the wallet link.

| On-chain (this contract) | Off-chain (Postgres / DataProvider) |
| --- | --- |
| `market_id` + `metadata_hash` (commitment) | Full market metadata: title, description, category, image, resolution source, … |
| Pools, positions, status, outcome, fees, bonds | A status mirror (best-effort hint; chain is source of truth) |
| ZK `participant_id`s, bond/commission credits | — |

### Off-chain metadata, bound by `metadata_hash`

Rich market content (title, description, category, image, …) is **not** stored
on-chain — it lives off-chain in Postgres. The chain commits only to a hash of it. The
id and hash are computed deterministically by
[`scripts/shared/market-metadata.ts`](../scripts/shared/market-metadata.ts) (`prepareMarket`):

```
metadata_hash = sha256( canonicalJSON(metadata) )
market_id     = sha256( canonicalJSON({ namespace:"dareu:market", network, title,
                                         closeTime, metadataHash }) )
```

`canonicalJSON` recursively sorts object keys, so the same logical metadata always
serializes to identical bytes. Consequences:

- **Determinism** — anyone (browser, DataProvider, auditor) can recompute the id and
  hash from the stored metadata.
- **Tamper-evidence** — changing any stored field changes `metadata_hash`, which no
  longer matches the on-chain commitment, so the off-chain text is effectively bound to
  the chain even though it isn't stored there.
- **Domain separation** — the `namespace` tag prevents `market_id` from colliding with
  the participant/position/vote/commitment hash schemes.

A **drift guard** ([`scripts/shared/market-metadata.golden.ts`](../scripts/shared/market-metadata.golden.ts),
`npm run test:metadata`) pins this function to known-good outputs. DataProvider vendors
a copy of the same logic and runs the same golden values, so the two implementations
cannot diverge silently (see [Drift-guard test](#drift-guard-test)).

### Platform configuration

Set in the constructor and held in ledger fields: `owner` (admin id), `payment_token`
(the token used for all bets/payouts), `leader_commission_rate` and `platform_fee_rate`
(basis points; the constructor asserts their sum ≤ 10000), `treasury` (accrued fees),
and the optimistic-oracle parameters `resolution_bond`, `challenge_window`, and
`arbiter_threshold`.

---

## The 12 circuits

The contract exports **12 circuits**, grouped by purpose.

### Market management
| Circuit | Who | What it does |
| --- | --- | --- |
| `create_market` | owner | Create a market from an `(market_id, metadata_hash, oracle, close_time)` commitment. Pools start empty; market opens. |
| `place_bet` | anyone | Escrow a stake on YES or NO, grow the chosen pool, record a private `Position`, return its `position_id`. Optional copy-trading `leader`. |
| `cancel_market` | owner / oracle | Cancel an **OPEN** market; pools are kept intact for refunds. |

### Optimistic-oracle resolution
| Circuit | Who | What it does |
| --- | --- | --- |
| `propose_resolution` | anyone (keeper/human) | After close, propose an outcome and post a **bond**; market → PROPOSED with a challenge window. |
| `dispute_resolution` | anyone | During the challenge window, post a **counter-bond** to dispute; market → DISPUTED. |
| `finalize_proposal` | anyone (permissionless) | After the window with **no dispute**, finalize the proposed outcome; proposer's bond is credited back. |
| `vote_dispute` | enrolled arbiter | Vote on a DISPUTED market; once a side hits the threshold the market settles and the winning party is credited **both** bonds. |
| `set_arbiter` | owner | Enroll/disable a dispute-resolution arbiter (DVM council member). |

### Payouts & treasury
| Circuit | Who | What it does |
| --- | --- | --- |
| `claim_winnings` | winning bettor | Claim stake + pro-rata profit on a RESOLVED market, minus platform fee + leader commission. |
| `refund_cancelled_position` | bettor | Reclaim the exact stake from a CANCELLED market (no fees). |
| `withdraw_credit` | anyone with credit | Pull a credited balance: resolution bond (`is_leader_reward=false`) **or** leader commissions (`is_leader_reward=true`). |
| `withdraw_treasury` | owner | Withdraw accumulated platform fees. |

> `withdraw_credit` is deliberately one circuit with an `is_leader_reward` flag (two
> payout paths) to keep the deployed circuit count at 12.

---

## Lifecycle

```
connect → bet → resolve (optimistic oracle) → claim
```

**Connect.** A client derives its `participant_id` from its secret key. No registration
transaction is needed; identity is implicit in every call.

**Create & bet.** `create_market` (owner) inserts a market from `(market_id,
metadata_hash, oracle, close_time)`, requires the close time to be in the future, and
opens it. `place_bet` validates the market is OPEN and not past `close_time`, escrows
the stake with `receiveUnshielded`, grows the chosen pool, stores a `Position` under a
fresh `position_id`, and returns that id. A non-empty `leader` flags the bet for a
copy-trading commission if it later wins.

**Resolve (the optimistic oracle).** After `close_time`, the outcome is settled
**without a single trusted resolver**:

1. **Propose** — `propose_resolution` posts a `resolution_bond`, sets the outcome, and
   sets `status = PROPOSED` with a `propose_deadline` at least `challenge_window` after
   close. A `Resolution` record is created.
2. **Finalize (happy path)** — if no one disputes before the deadline,
   `finalize_proposal` is **permissionless**: anyone can settle the market to the
   proposed outcome, and the proposer's bond is credited back. The optimistic
   assumption is that an unchallenged proposal is correct.
3. **Dispute** — `dispute_resolution`, during the window, posts an equal counter-bond
   and sets `status = DISPUTED`. Two competing claims are now bonded.
4. **Vote** — `vote_dispute` lets each enrolled **arbiter** (DVM council, managed via
   `set_arbiter`) vote once (deduplicated by `vote_key` in `dispute_votes`). When a side
   reaches `arbiter_threshold`, the market settles to that outcome and whichever party
   (proposer or disputer) backed the winning side is credited **both** bonds.

Settlement (`settle_market`) sets `status = RESOLVED` and refuses to resolve a market
whose winning pool is empty (nobody to pay) — such markets must be cancelled instead.

**Claim (ZK-proven entitlement).** `claim_winnings` proves entitlement: the caller must
be the position's `bettor` (proven via the private key), the position unclaimed, the
market RESOLVED, and the position's side equal to the final outcome. The position is
marked `claimed` **before** funds are sent (no double-claim), then the payout is pushed
to a caller-supplied unshielded address. Two non-winning exits exist:
`refund_cancelled_position` returns the exact stake from a CANCELLED market, and
`withdraw_credit` pulls bond refunds or leader commissions.

---

## Economics

### Pari-mutuel payout and the fee/bound math

DareU is **pari-mutuel**: winners split the losing pool pro-rata to their stake.
Compact has no integer division, so the client computes the exact values off-chain and
the circuit re-derives the unique correct answer by **bracketing each value between two
integer inequalities** — the standard "prove a floor-division result without dividing."
For a true floor `q = a / b`, the only integer satisfying `q*b ≤ a` **and**
`a < (q+1)*b` is `q`. In `claim_winnings`, with `winners`/`losers` the winning/losing
pool sizes and `amount` the position's stake:

```compact
// gross_profit = floor(amount * losers / winners)
assert(gross_profit * winners <= amount * losers,           "Profit is too high");
assert(amount * losers       < (gross_profit + 1) * winners, "Profit is too low");

// platform_fee = floor(gross_profit * platform_fee_rate / 10000)
assert(platform_fee * 10000  <= gross_profit * platform_fee_rate,      "Platform fee is too high");
assert(gross_profit * platform_fee_rate < (platform_fee + 1) * 10000,  "Platform fee is too low");

// leader_fee = 0 if no leader, else floor(gross_profit * leader_commission_rate / 10000)
```

`gross_profit` is the bettor's pro-rata slice of the **losing** pool; the platform and
leader fees are basis-point cuts of that profit. The final payout is:

```
payout = stake + gross_profit − platform_fee − leader_fee
```

Because each fee is bounded above by the rate applied to `gross_profit`, the
subtraction cannot underflow. If a caller passes any value other than the unique
correct one, an assertion fails and the claim reverts.

- **Platform fee (treasury).** A percentage of each winner's profit
  (`platform_fee_rate`, default 2%) accrues to `treasury`, which the owner withdraws via
  `withdraw_treasury` (bounded by the treasury balance, so it can only pay out fees
  actually collected).
- **Leader commission (copy-trading).** When a bet names a `leader`, a percentage of its
  profit (`leader_commission_rate`, default 10%) is paid to that leader on a winning
  claim. Commissions accrue in `leader_rewards` and are pulled via
  `withdraw_credit(is_leader_reward = true)` — the reward for being copied.
- **Resolution bonds.** Proposing and disputing each require a `resolution_bond`. Honest
  proposers reclaim their bond on finalization; in a dispute the party whose claim
  matches the arbiter vote takes **both** bonds — so being wrong is costly and being
  right is rewarded. Bond credits are pulled via `withdraw_credit(is_leader_reward = false)`.

---

## Trust assumptions & security

**Trustless / enforced on-chain:**

- **Identity & authorization** — owner/oracle/arbiter/bettor checks all derive from
  `current_participant()` (the caller's private key); they cannot be spoofed.
- **Custody & accounting** — stakes and bonds are escrowed by the contract; payouts are
  bounded by the bracketing math, the treasury balance, and the per-position `claimed`
  flag (no double-claim, no over-payout, no underflow).
- **Metadata integrity** — off-chain metadata is bound by `metadata_hash`; tampering is
  detectable by recomputation.
- **Privacy** — the wallet→position→PnL linkage is hidden by ZK identity and unguessable
  position ids; pools and payouts remain publicly verifiable.
- **Permissionless finalization** — an undisputed correct proposal can be finalized by
  anyone, so settlement does not depend on the owner's availability.

**Trusted / assumed:**

- **The owner** creates markets, enrolls arbiters, and withdraws the treasury — a
  privileged role.
- **Off-chain metadata source (Postgres)** — the chain commits to a hash, not the
  content; the metadata's *availability* (not its integrity) depends on the off-chain
  store. The drift guard plus DataProvider's vendored copy guard the id/hash logic.
- **Oracle / keeper liveness** — someone must propose an outcome after close. Honesty is
  not assumed (the dispute mechanism + bond incentive is the correctness guarantee), but
  liveness — a proposal eventually being made, and disputers watching the window — is.
- **The arbiter council** — disputed markets are decided by a majority of enrolled
  arbiters up to `arbiter_threshold`; their honesty is the final backstop.

---

## Limitations & future work

Grounded in the current code:

- **Only binary YES/NO markets.** `Outcome` is `{NONE, YES, NO}`; multi-outcome or
  scalar markets are not supported.
- **Empty winning pool ⇒ no resolution.** `settle_market` rejects a winning pool of zero
  (one-sided markets), which must be cancelled and refunded rather than resolved.
- **Single owner role.** Ownership is centralized in one `owner`; there is no on-chain
  ownership transfer or fee-rate update circuit in the current 12-circuit set (fee rates
  and oracle params are fixed at deploy).
- **Client-computed payout terms.** `claim_winnings` requires the caller to supply
  `gross_profit` / `platform_fee` / `leader_fee` (the contract verifies, but does not
  compute, them).
- **Off-chain metadata availability.** Integrity is hash-committed, but the contract does
  not guarantee the metadata remains retrievable.
- **Minimal governance.** Arbiter/keeper governance (council membership, keeper
  decentralization, slashing beyond bond forfeiture) is a natural area for hardening.

---

# Using the contract

## Build

The Compact source is compiled with the `compact` compiler (part of the Midnight /
Compact toolchain; install it separately).

```bash
npm run build
# → compact compile src/dareu.compact src/managed/dareu
```

This produces `src/managed/dareu/` (contract bindings, prover/verifier keys, ZKIR). The
directory is git-ignored (~37 MB of ZK keys) and regenerated on demand; the
deploy/keeper scripts import the generated bindings from it.

> The TypeScript scripts can be type-checked without the compiler: `npm run typecheck`.

## Deploy

```bash
# 1) Start a local Midnight proof server (Docker):
npm run start-proof-server

# 2) Deploy to preprod (or deploy:preview):
npm run deploy:preprod
```

[`scripts/admin/deploy.ts`](../scripts/admin/deploy.ts) loads `.env` / `.env.local`, requires a
compiled contract, funds + DUST-registers the wallet, then submits the deploy
transaction. On success it writes `deployments/<network>.json` — **which contains the
owner secret key**, so that file is git-ignored. Keep it private. Constructor args come
from env (below).

## Environment

Copy [`.env.example`](../.env.example) to `.env.local` and fill in. Key variables:

| Variable | Purpose |
| --- | --- |
| `MIDNIGHT_NETWORK` | `preprod` or `preview` |
| `MIDNIGHT_INDEXER_URL` / `_WS_URL`, `MIDNIGHT_NODE_URL` / `_WS_URL` | Midnight endpoints (defaults baked in per network) |
| `MIDNIGHT_PROOF_SERVER` | Proof server URL (default `http://127.0.0.1:6300`) |
| `MIDNIGHT_WALLET_MNEMONIC` **or** `MIDNIGHT_WALLET_SEED` | Wallet key — a BIP39 recovery phrase (precedence) or a hex HD seed |
| `MIDNIGHT_PRIVATE_STATE_PASSWORD` | Encrypts the local private-state store |
| `DAREU_OWNER_SECRET_KEY` | 32-byte hex; deploy generates one if unset, keeper requires it |
| `DAREU_PAYMENT_TOKEN_HEX` | 32-byte token type (defaults to the native unshielded token) |
| `DAREU_LEADER_COMMISSION_BPS` / `DAREU_PLATFORM_FEE_BPS` | Fee rates in basis points (defaults `1000` / `200`) |
| `DATABASE_URL` + `MARKET_*` / `TREASURY_AMOUNT` / `ARBITER_*` | Admin market CLI inputs |

`.env.example` documents the full list, including wallet sync/cache tuning.

## Admin & keeper CLI

[`scripts/admin/market.ts`](../scripts/admin/market.ts) provides the privileged operations
(owner/oracle keyed). It upserts off-chain metadata to Postgres first, then submits the
matching circuit:

```bash
npm run market:create      -- preprod   # reads MARKET_* env, writes metadata + create_market
npm run market:propose     -- preprod   # MARKET_ID + MARKET_OUTCOME=YES|NO + MARKET_DEADLINE
npm run market:dispute     -- preprod   # MARKET_ID
npm run market:finalize    -- preprod   # MARKET_ID
npm run market:vote        -- preprod   # MARKET_ID + MARKET_OUTCOME (arbiter)
npm run market:arbiter     -- preprod   # ARBITER_ID + ARBITER_ENABLED (owner)
npm run market:cancel      -- preprod   # MARKET_ID
npm run treasury:withdraw  -- preprod   # TREASURY_AMOUNT
npm run balance:preprod    -- <mn_addr_preprod...>   # query an unshielded balance
```

## Drift-guard test

```bash
npm run test:metadata      # → tsx scripts/shared/market-metadata.golden.ts (exits 1 on mismatch)
```

`prepareMarket` is the single source of truth for `market_id` / `metadata_hash`, and
**DataProvider vendors a copy of it**. The golden test feeds a fixed input and asserts
the output still equals known-good hashes; the same golden values run on the
DataProvider side, so if the two implementations ever diverge a golden test fails
**before** mismatched ids can reach Postgres or the chain.

## Layout

```
contract/
├── src/dareu.compact                  # the contract (12 circuits)
├── scripts/
│   ├── shared/                        # cross-cutting helpers
│   │   ├── chain.ts                   #   env / pg / connect-as-owner bootstrap
│   │   ├── midnight.ts                #   wallet, providers, network config, sync/cache
│   │   ├── network.ts                 #   per-network endpoints (single source of truth)
│   │   ├── market-metadata.ts         #   deterministic market_id / metadata_hash (prepareMarket)
│   │   └── market-metadata.golden.ts  #   drift guard (npm run test:metadata)
│   ├── admin/                         # privileged, run by hand
│   │   ├── deploy.ts                  #   deploy a fresh contract
│   │   ├── market.ts                  #   admin CLI (create/propose/dispute/finalize/vote/...)
│   │   └── balance.ts                 #   unshielded balance query
│   └── keeper/                        # always-on automation service
│       ├── run.ts                     #   scheduler loop (sync + publish + autopropose)
│       ├── publish.ts                 #   draft markets → create_market on-chain
│       ├── sync.ts                    #   chain markets → Postgres mirror
│       └── autopropose.ts             #   closed markets → propose_resolution
├── deployments/<network>.json         # deploy record (git-ignored; holds owner secret)
├── .env.example                       # env reference
└── docs/
    ├── README.md                      # this document (design + usage)
    ├── contract-runbook.md            # build + deploy runbook
    ├── proof-server-runbook.md        # proof server runbook
    └── keeper-runbook.md              # keeper operations runbook
```

---

*This document reflects the contract in [`src/dareu.compact`](../src/dareu.compact) and
[`scripts/`](../scripts/) at the time of writing. Where this document and the code
disagree, the code is authoritative.*
