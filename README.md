# DareU Contract

Compact smart contracts for DareU — **parimutuel prediction markets** on the Midnight
network, with an **optimistic-oracle** resolution flow and privacy-preserving bettor
identities. **Two contracts live in this package:**

| | Source | Status | Docs |
|---|---|---|---|
| **V2** — shielded vault (sNIGHT) + ticket claims + operator/owner split | [`src/dareu-v2.compact`](src/dareu-v2.compact) | **deployed on preprod**; NIGHT registered, keeper preflight verified | [`docs/README.md`](docs/README.md) |
| **Registry** — multi-asset V2 discovery | [`src/dareu-registry.compact`](src/dareu-registry.compact) | **deployed on preprod**; NIGHT enabled | [`docs/README.md`](docs/README.md) |

V2 exists to fix V1's two structural defects: claims permanently failing when the
browser-derived identity key drifts ("Only the bettor can claim"), and the public
wallet ↔ position linkage in every bet/claim transaction. See `docs/README.md` for the
V1 → V2 change map.

- Language: `pragma language_version >= 0.23` — Compact compiler **0.31.1**, toolchain **0.5.1**
- Runtime: `@midnight-ntwrk/compact-runtime` 0.16.0, `@midnight-ntwrk/compact-js` 2.5.1
- Build: `npm run build` (V2 + Registry)

Current preprod addresses are recorded in `deployments/preprod-v2.json` and
`deployments/preprod-registry.json`. Keeper V2 resolves NIGHT through the registry and
refuses to start on a disabled asset or registry/deployment drift.

> **Fee-model deployment note (2026-07-13):** the source and generated artifacts now
> implement a 1% fee on every accepted stake, refundable with the stake when a market is
> cancelled. This ABI change is tested locally but is **not yet deployed to preprod**;
> the preprod address above still uses the previous V2 artifact.

## V2-only cutover (2026-07-11)

Preprod now runs the Compact V2 contract exclusively. V1 remains documented only as
historical design context; the default build, deploy, market-admin, Keeper, DataProvider,
and Webapp paths do not fall back to V1.

### Supported toolchain

- Compact compiler: **0.31.1** (0.31.0 is not used).
- Proof server: **8.1.0**.
- Midnight.js: **4.1.x**. Do not add a direct `ledger-v8` compatibility pin: the ledger
  implementation is supplied through `@midnight-ntwrk/midnight-js-protocol/ledger`.
- Default `npm run build` compiles only `dareu-v2.compact` and
  `dareu-registry.compact`.

### Current preprod deployment

| Component | Address / value |
|---|---|
| Registry | `f3b500ea376a09871f2e8a4cc418647ff75e3dfa8cd8c2357725e09240a5462a` |
| NIGHT V2 market | `aefe790c3f0c75bb991740cce86eae803204f8f6e49efeab36d297ed9fa3c70e` |
| Underlying NIGHT color | `0000000000000000000000000000000000000000000000000000000000000000` |
| sNIGHT color | `e4383670761aacc9387b14b7056b1bd1fbeac4154979e93d4551c03878a15a06` |
| Decimals | `6` |

The Registry record is enabled. Deployment metadata and transaction identifiers remain
the authoritative source in `deployments/preprod-v2.json` and
`deployments/preprod-registry.json`.

### Build, deploy, and register NIGHT

```bash
npm run build
npm run deploy:v2:preprod
npm run deploy:registry:preprod

DAREU_ASSET_SYMBOL=NIGHT \
DAREU_ASSET_UNDERLYING_HEX=0000000000000000000000000000000000000000000000000000000000000000 \
DAREU_ASSET_MARKET_ADDRESS=aefe790c3f0c75bb991740cce86eae803204f8f6e49efeab36d297ed9fa3c70e \
DAREU_ASSET_SNIGHT_COLOR=e4383670761aacc9387b14b7056b1bd1fbeac4154979e93d4551c03878a15a06 \
DAREU_ASSET_DECIMALS=6 \
npm run registry:add -- preprod
```

V2 uses a shielded vault: `deposit` locks the exact underlying NIGHT amount and mints
the same amount of sNIGHT; betting consumes sNIGHT; a successful/cancelled settlement
is claimed through the position ticket using `claim_settled`. Proposal and dispute
bonds are also exact-value sNIGHT coins.

### Verification performed for this cutover

- Both V2 and Registry deployed successfully on preprod.
- NIGHT Registry registration submitted successfully.
- Contract suite: **124 tests passed**.
- Contract TypeScript typecheck passed.
- Keeper preflight, full shielded-wallet discovery, V2 market publishing, and database
  namespace diagnostics passed.

---

## Upgrade Notes (odds-v2) — V1, historical

This upgrade finalized the parimutuel + optimistic-oracle model and aligned the
per-market economics with the design in [`../README-odds.md`](../README-odds.md).

### Model
- **Parimutuel pools** — each market holds `yes_pool` / `no_pool`. Payouts are funded
  **only by real bet money**; winners split the losing pool pro-rata to stake. There is
  no AMM and no protocol counterparty.
- **Real odds = pool ratio.** Odds/payout are derived purely from `yes_pool/no_pool`
  (50/50 when empty). Participant count / reputation never affect odds or payouts.
- **Bettor authorization is wallet-native** — `place_bet` spends an sNIGHT coin and
  mints a value-1 claim ticket. `claim_settled` burns that ticket and proves the
  committed payout-key preimage; no browser-derived participant identity is used.
- **Per-market parameters** are set at `create_market` and enforced on-chain:
  `close_time`, `challenge_window`, `betting_cutoff`, `platform_fee_rate`.
- **Betting cutoff** — `place_bet` reverts with `betting closed` once
  `blockTime >= close_time − betting_cutoff` (default 300s / 5min).
- **Platform fee** — charged on **every accepted stake** at `place_bet`. The wallet pays
  `stake + floor(stake × fee_bps / 10000)`; only the stake enters the parimutuel pool.
  The fee is escrow until resolution, becomes withdrawable revenue only after
  `RESOLVED`, and is refunded with the stake after `CANCELLED`. Default: 100 bps (1%).
- **Single-sided / empty pools must be cancelled** — a market with money on only one
  side (or none) cannot pay out, so it is `cancel_market`-ed and stake plus fee become
  refundable (`claim_settled`, pull payment). This is why unbet / one-sided
  markets end up `cancelled` rather than `resolved`.

### Lifecycle
```
create_market → place_bet(stake + fee; fee escrowed) (until close − betting_cutoff)
  → propose_resolution → [challenge window] → dispute_resolution / vote_dispute
  → finalize_proposal ⟶ RESOLVED → claim_settled(stake + gross profit) (pull)
  or cancel_market  ⟶ CANCELLED → claim_settled(stake + original fee) (pull)
```

### Addresses (important for clients)
`withdraw` and `withdraw_treasury` take a **`UserAddress` struct `{ bytes: Bytes<32> }`**,
not a bech32m string. Clients must decode the wallet's
`mn_addr_<network>1…` address into 32 bytes (see
`webapp/src/lib/midnight/place-bet.ts` using `@midnight-ntwrk/wallet-sdk-address-format`).

### Config changes in this upgrade (`.env.local`, read at deploy / by admin scripts)
- `DAREU_PLATFORM_FEE_BPS=100` — platform fee set to **1%** (was 200 / 2%). Note: this is
  the constructor default + guardrail; per-market fee comes from the PG mirror column and
  is already 100 for auto-drafted markets.
- `DAREU_LEADER_COMMISSION_BPS` — **dead** (leader/copy-trading was removed from the
  contract; not read anywhere). Safe to delete.
- `DATABASE_URL` moved to the Supabase **transaction-mode** pooler (`:6543`) — see
  `../database/README.md`.

The keeper (publish / sync / optimistic-oracle loops) is documented in
[`scripts/keeper/README.md`](scripts/keeper/README.md).
