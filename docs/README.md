# DareU Contract V2 — Shielded Vault + Ticket Claims

> **Status (2026-07-11): deployed on preprod; V2-only production path.**
> `src/dareu-v2.compact` compiles clean (full ZK, 12 circuits / 24 keys) with Compact
> compiler **0.31.1** (toolchain 0.5.1), `pragma language_version >= 0.23`, and is proved
> with proof-server **8.1.0**. The Registry and NIGHT V2 instance are deployed, NIGHT is
> registered/enabled, and the Contract/Keeper/DataProvider/Webapp paths no longer fall
> back to V1. V1 documentation is retained only at [README-V1.md](README-V1.md).
>
> Preprod Registry:
> `f3b500ea376a09871f2e8a4cc418647ff75e3dfa8cd8c2357725e09240a5462a`
>
> Preprod NIGHT V2 instance:
> `aefe790c3f0c75bb991740cce86eae803204f8f6e49efeab36d297ed9fa3c70e`
>
> sNIGHT color:
> `e4383670761aacc9387b14b7056b1bd1fbeac4154979e93d4551c03878a15a06`
>
> The full contract test suite currently passes **133/133** tests (including **56/56**
> V2-specific tests). Midnight.js is 4.1.x; do not
> directly pin `ledger-v8`, because the ledger implementation is packaged through
> `@midnight-ntwrk/midnight-js-protocol/ledger`.
>
> **Local fee-model update (2026-07-13, not yet deployed):** `place_bet` now charges
> the per-market fee on stake. It remains refundable escrow until resolution;
> `claim_settled` refunds stake + fee on cancellation, and treasury withdrawal is
> permitted only for a RESOLVED market. A fresh preprod V2 deployment is required.
>
> Full design rationale (Chinese, with all decision records D1–D8):
> [`../../README-shielded-vault-market.zh-CN.md`](../../README-shielded-vault-market.zh-CN.md)

## Why V2 exists

Two V1 problems, one root cause each:

1. **Stuck funds.** V1 authorized `claim_winnings` / `refund_cancelled_position` by a
   browser-derived secret (`participant_id` from a wallet `signData` signature). Wallet
   signatures are not guaranteed deterministic, so a cleared localStorage / new browser /
   new device produced a *different* identity — the contract rejected the rightful owner
   with `"Only the bettor can claim"`, permanently. V2 removes user-held app secrets
   entirely: every user credential is **wallet-native** (seed-recoverable).
2. **Privacy leak.** V1 bets spent the user's unshielded UTXOs and claims paid to the
   user's unshielded address, publicly linking wallet ↔ position ↔ amounts on both ends.
   V2 moves all in-market value onto a contract-issued **shielded token**, shrinking the
   public linkage surface to the deposit/withdraw edges.

## Architecture

One deployable contract, two logical modules (Compact has **no cross-contract calls**,
and only the issuing contract can mint its token colors — so the vault and the market
must live together; multi-asset support = one contract instance per underlying asset):

```
┌────────────────────────── dareu-v2.compact ───────────────────────────┐
│ VAULT   deposit: NIGHT (unshielded) in → mint sNIGHT (shielded) 1:1    │
│         withdraw: burn sNIGHT → NIGHT out to any user address          │
│ MARKET  everything denominated in sNIGHT, strict burn-and-mint         │
│         (the contract NEVER holds shielded coins → no UTXO contention) │
└────────────────────────────────────────────────────────────────────────┘
```

## Trust & key model

| Role / credential | Held by | Powers | Loss/compromise blast radius |
|---|---|---|---|
| `owner` (cold) | Platform, offline | `withdraw_treasury`, `set_role` | Treasury + role admin — keep off servers |
| `operator` (hot) | Keeper server | `create_market`, `cancel_market` | Market ops only; owner rotates via `set_role(OPERATOR, …)` |
| `oracle` (per-market) | Keeper | cancel an OPEN market | Single market |
| `arbiter` | DVM council | `vote_dispute` | One vote |
| User: sNIGHT coins | User wallet (zswap) | pay bets / withdraw | Spending = private-key proof; seed-recoverable |
| User: claim **ticket** | User wallet | trigger `claim_settled` for one position | Trigger-only — cannot redirect funds |
| User: `payout_commitment` preimage | User wallet (its coin pk) | prove beneficiary at claim | pk never stored on-chain in plaintext |

Users never touch `local_secret_key` — it remains only for platform roles.

## V1 → V2 change map

| V1 | V2 | Why |
|---|---|---|
| Bets/claims move unshielded NIGHT per call | Vault: `deposit`/`withdraw` at the edges; sNIGHT inside | Privacy + one testable payment path |
| `claim_winnings` + `refund_cancelled_position`, identity-gated | **`claim_settled`** (merged), **ticket-gated**: burn the position's ticket + prove `payout_commitment` preimage → payout **minted to the committed pk** | Kills the lost-identity failure class; wallet-seed recoverable; no keeper fallback (product decision D7) |
| `bettor` id stored in Position | `payout_commitment` hash (pk never on-chain until claim mint) | Unlinkability across positions |
| `bond_credits` pull-payments | Bonds minted straight back to `proposer_pk`/`disputer_pk` | Push is safe when minting to a shielded pk |
| Global `treasury` cell | `market_fees[market_id]` escrow + resolved-only `withdraw_treasury(market_id, addr)` | Removes cross-market contention and protects cancellation refunds |
| `set_arbiter` | **`set_role(Role, participant, enabled)`** (ARBITER \| OPERATOR) | Operator/owner split within the 12-circuit budget |
| `commitments` audit map | removed | Self-documented as adding no secrecy |
| — | `operator` ledger field | Least-privilege hot key for the keeper |

## The 12 circuits

| # | Circuit | Auth | Token effect |
|---|---|---|---|
| 1 | `deposit(amount, recipient_pk, mint_nonce)` | none | NIGHT in → mint sNIGHT to pk |
| 2 | `withdraw(coin, payout_address)` | holding sNIGHT | burn sNIGHT → NIGHT out |
| 3 | `create_market(…)` | owner **or operator** | — |
| 4 | `place_bet(market, side, amount, stake_fee, coin, payout_pk, pos_nonce)` | holding sNIGHT | burn stake + fee; pool gets stake; escrow fee; **mint 1 ticket** |
| 5 | `claim_settled(bet_id, payout_pk, ticket, gross_profit, stake_fee)` | **ticket holder only** | burn ticket → mint payout (RESOLVED: stake + gross profit; CANCELLED: stake + original fee) |
| 6 | `propose_resolution(market, result, deadline, coin, refund_pk)` | bond in sNIGHT | burn bond |
| 7 | `dispute_resolution(market, coin, refund_pk)` | counter-bond | burn bond |
| 8 | `finalize_proposal(market)` | permissionless | mint bond → proposer_pk |
| 9 | `vote_dispute(market, result)` | arbiter | on threshold: mint 2×bond → winner pk |
| 10 | `cancel_market(market)` | owner/operator (+oracle when OPEN) | stuck-cancel mints bonds back |
| 11 | `set_role(role, participant, enabled)` | **owner only** | — |
| 12 | `withdraw_treasury(market_id, payout_address)` | **owner only, RESOLVED market** | withdraw earned fee; unresolved/cancelled escrow is protected |

Pure exports for clients: `participant_id`, `position_id`. Ticket color must be derived
client-side as `tokenType(pos_id, contractAddress)` (it reads `kernel.self()`, so it
cannot be a pure export).

## Claim: three wallet-derived gates

```
① burn ticket[bet_id]        — without the coin the tx cannot even be constructed
② H("dareu:payee:", pk) == position.payout_commitment — preimage known only to owner
③ payout minted to that pk   — even if ①② were bypassed, funds reach the beneficiary
```

No timeout fallback, no keeper auto-claim (D7): a ticket lost *together with its wallet
seed* leaves that payout locked forever (shows up as permanent surplus in the solvency
monitor — track it separately).

## Solvency invariant (off-chain monitor, independent of the keeper)

```
NIGHT held by contract ≥ circulating sNIGHT
                        + Σ unresolved pools + Σ posted bonds + Σ refundable/unswept market_fees
```

On-chain `total_in/out` counters were deliberately **removed** — the contract's balance
is publicly queryable and an indexer reconstructs flows from events, while on-chain
accumulators would have serialized all deposits/withdraws on one cell.

## Concurrency & mint nonces

Deterministic per-event nonces instead of a shared evolving-nonce cell: claim mint =
`H(tag, bet_id)`, ticket = `pos_nonce`, bond refunds = `H(tag, market_id, role)`,
deposit = caller-random. deposits/withdraws touch **no shared ledger cell**; only
same-market bets (pool + fee escrow) and cancellation claims (`market_fees`) serialize.

## Build & deploy

```bash
compact compile src/dareu-v2.compact src/managed/dareu-v2          # full ZK
compact compile --skip-zk src/dareu-v2.compact <tmp>               # fast check
```

Constructor: `(owner_secret_key, underlying, domain, init_bond, init_threshold,
operator_id)` — `operator_id` is a participant_id (all-zero → defaults to owner, fine
for test deploys). New env at deploy/keeper time: `DAREU_OPERATOR_SECRET_KEY` (hot,
keeper) alongside the existing `DAREU_OWNER_SECRET_KEY` (cold, offline). **Redeploy with
all credentials rotated.** Deploy budget: 12 circuits is the observed max (13 exceeded
the block limit for V1).

### Contract maintenance authority

Set `DAREU_CMA_SECRET_HEX` at deploy time (both `scripts/admin/deploy-v2.ts` and
`scripts/admin/deploy-registry.ts` read it) so future upgrades — verifier-key /
maintenance updates via `replaceAuthority`-style maintenance transactions — stay
possible **without changing the contract address**. If it is left unset,
`deployContract()` samples a random signing key as the contract maintenance authority
(CMA) and stores it only in the local private-state store; lose that store and the
contract can never be upgraded again. Treat `DAREU_CMA_SECRET_HEX` like
`DAREU_OWNER_SECRET_KEY`: generate it once (`openssl rand -hex 32`), keep it cold,
never put it on the keeper server. The same secret may govern every dareu-v2 instance
and the registry (one CMA for the whole platform), or each instance can use a distinct
secret for isolation — either way, both deploy scripts print the resulting CMA
verifying key and record it in `deployments/<network>{-v2,-registry}.json` as
`maintenanceAuthorityHex`.

## Multi-asset registry

DareU v2 deploys **one dareu-v2 instance per underlying asset** (NIGHT, USDT, USDC,
BTC, ETH — a separate contract each; Compact has no cross-contract calls and only the
issuing contract can mint its shielded token colors, so a shared multi-asset vault is
not possible). `src/dareu-registry.compact` is a small, separate, owner-gated contract
that maps `underlying_color → AssetInfo {symbol, underlying_color, market_address,
snight_color, decimals, enabled}`. It exists purely for **off-chain discovery** — the
webapp, keeper, and any monitoring read ONE registry address via the indexer and get
every deployed market instance back, instead of hardcoding per-asset addresses.
Compiled output: `src/managed/dareu-registry`.

**Add-asset runbook:**

```bash
# 1. Deploy the registry ONCE per network (not per asset).
npm run deploy:registry:preprod
# → writes contract/deployments/preprod-registry.json

# 2. For EACH asset: deploy a dareu-v2 market instance for that asset's underlying color.
#    (Today only NIGHT is deployable — see "Bridge blocker" below.)
DAREU_V2_UNDERLYING_HEX=  npm run deploy:v2:preprod   # unset = native NIGHT
# → writes contract/deployments/preprod-v2.json (overwritten per run — copy it aside
#   per-asset if deploying more than one instance before registering each)

# 3. Register that instance into the registry.
DAREU_ASSET_SYMBOL=NIGHT DAREU_ASSET_DECIMALS=6 npm run registry:add -- preprod
# → reads DAREU_ASSET_MARKET_ADDRESS or falls back to deployments/preprod-v2.json;
#   derives snight_color via rawTokenType(token_domain, market_address) if
#   DAREU_ASSET_SNIGHT_COLOR is unset.
```

To pause an asset without deleting its record: `npm run registry:disable -- preprod`
(calls `set_asset_enabled(underlying_color, false)`; `DAREU_ASSET_ENABLED=true` flips
it back on with the same command).

Full env var reference: `contract/.env.example` (`DAREU_REGISTRY_*` / `DAREU_ASSET_*`).
Off-chain read layer (webapp + keeper): `webapp/src/lib/midnight/registry.ts`.

**Bridge blocker.** Wrapped USDT/USDC/BTC/ETH tokens do not exist on Midnight yet — no
bridge has shipped a real color for any of them. All the tooling above is
asset-agnostic and parameterized (symbol/color/decimals are plain inputs, nothing
hardcoded), so onboarding a new asset once a bridge exists is exactly steps 2–3 above
with that asset's real values filled in. **NIGHT (`nativeToken()`, the all-zero color)
is the only asset actually deployable and testable today.**

**ETH precision caveat.** Ledger amounts are `Uint<64>`. Native ETH has 18 decimals,
so a raw 18-decimal amount overflows `Uint<64>` at roughly 18 ETH — far below any real
balance. When an ETH bridge does arrive, it **must** be onboarded at reduced precision
(e.g. `DAREU_ASSET_DECIMALS=8`, i.e. bridge/scale ETH into the vault in 1e8 units, not
1e18). The registry's `decimals` field records the asset's *actual deployed* precision
for exactly this reason — every off-chain amount conversion (webapp display, keeper
accounting) MUST read `decimals` from the registry record rather than assuming a
token's native decimal count.

## Known-open items

- Webapp funds layer rewrite (drop `identity.ts` signature-derived keys; zswap payments;
  ticket management; per-position fresh `payout_pk` if the wallet supports it — else
  positions sharing a pk become mutually linkable once one is claimed). The registry
  read layer (`webapp/src/lib/midnight/registry.ts`) is ready for this rewrite to wire
  in but is not yet used by any production page.
- Wallet-support demo V1–V6 (custom-color zswap payments in Lace is the hard gate).
- v2 test suite incl. lifecycle solvency simulation; adversarial audit.
- Bridge blocker + ETH precision caveat — see "Multi-asset registry" above.
