# DareU Contract

Compact smart contract for DareU — **parimutuel prediction markets** on the Midnight
network, with an **optimistic-oracle** resolution flow and privacy-preserving bettor
identities.

- Language: `pragma language_version >= 0.22` — Compact compiler **0.31.1**, toolchain **0.5.1**
- Runtime: `@midnight-ntwrk/compact-runtime` 0.16.0, `@midnight-ntwrk/compact-js` 2.5.1
- Source: [`src/dareu.compact`](src/dareu.compact) · build: `npm run build`

---

## Upgrade Notes (odds-v2)

This upgrade finalized the parimutuel + optimistic-oracle model and aligned the
per-market economics with the design in [`../README-odds.md`](../README-odds.md).

### Model
- **Parimutuel pools** — each market holds `yes_pool` / `no_pool`. Payouts are funded
  **only by real bet money**; winners split the losing pool pro-rata to stake. There is
  no AMM and no protocol counterparty.
- **Real odds = pool ratio.** Odds/payout are derived purely from `yes_pool/no_pool`
  (50/50 when empty). Participant count / reputation never affect odds or payouts.
- **Bettor identity is a ZK `participant_id`** = `persistentHash("dareu:participant:", sk)`,
  where `sk` is the caller's secret supplied by the `local_secret_key()` witness. Only
  the hash is ever disclosed; the same identity is required to `claim_winnings` /
  `refund_cancelled_position` (see webapp identity notes).
- **Per-market parameters** are set at `create_market` and enforced on-chain:
  `close_time`, `challenge_window`, `betting_cutoff`, `platform_fee_rate`.
- **Betting cutoff** — `place_bet` reverts with `betting closed` once
  `blockTime >= close_time − betting_cutoff` (default 300s / 5min).
- **Platform fee** — charged on **winnings only** (from the loser pool), never on the
  stake. **Default 100 bps (1%).**
- **Single-sided / empty pools must be cancelled** — a market with money on only one
  side (or none) cannot pay out, so it is `cancel_market`-ed and stakes become
  refundable (`refund_cancelled_position`, pull payment). This is why unbet / one-sided
  markets end up `cancelled` rather than `resolved`.

### Lifecycle
```
create_market → place_bet (until close − betting_cutoff)
  → propose_resolution → [challenge window] → dispute_resolution / vote_dispute
  → finalize_proposal ⟶ RESOLVED → claim_winnings (pull)
  or cancel_market  ⟶ CANCELLED → refund_cancelled_position (pull)
```

### Addresses (important for clients)
`claim_winnings`, `refund_cancelled_position`, and `withdraw_*` take a **`UserAddress`
struct `{ bytes: Bytes<32> }`**, not a bech32m string. Clients must decode the wallet's
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
