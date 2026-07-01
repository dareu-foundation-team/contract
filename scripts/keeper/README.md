# DareU Keeper

Long-running service that bridges the off-chain draft markets (Postgres) and the on-chain
contract, and drives the optimistic-oracle resolution loops.

Run: `npm run keeper:run -- preprod` (see `contract/contract-keeper-run.sh`).

---

## Cycle

`run.ts` executes one **full cycle every `KEEPER_CYCLE_SEC` (default 300s = 5min)**, in
order:

```
sync → publishDrafts → autoPropose → finalize → cancelRequested → cancelStuck → sleep
```

The 300s is the pause **after** a cycle finishes, not a timeout — a cycle runs to
completion (a large publish batch can take much longer than 5 min).

### Loops
- **`sync.ts`** — mirrors on-chain status / pools (`onchain_status`,
  `onchain_yes_pool/no_pool`, `onchain_outcome`) back into Postgres. Runs first so the
  other loops see fresh state.
- **`publish.ts`** — reads markets the dataprovider drafted (`status IN ('draft','open')`,
  `onchain_tx_id IS NULL`, params non-null, `close_time > now()`, oracle not all-zero,
  ordered `close_time ASC`), calls `create_market` on-chain, then flips them to
  `status='open'` + sets `onchain_tx_id`. This is what the webapp gates the live feed on.
- **`autopropose.ts`** — `ready_to_propose → propose_resolution`; `proposed →
  finalize_proposal` after the challenge window; `cancel_requested → cancel_market`;
  stuck `proposed/disputed → cancel_market`.

---

## Upgrade Notes (odds-v2)

- **`PUBLISH_LIMIT` sweep.** Each `create_market` is a separate on-chain transaction with
  its own ZK proof, submitted sequentially by a single wallet. `PUBLISH_LIMIT` (default
  20) caps how many are published per cycle. **DUST cost is per-transaction**, so
  publishing 500 at once costs the same total as dribbling 20/cycle — set
  `PUBLISH_LIMIT` high (e.g. **500**) to sweep the entire backlog each cycle. The first
  cycle drains the backlog; steady-state cycles only carry the hour's new drafts.
- **Throughput reality.** Publishing is proof-bound: the local proof server
  (`MIDNIGHT_PROOF_SERVER`, default `127.0.0.1:6300`) generates one zk-SNARK per market,
  sequentially. Observed ≈ 10–20 markets/cycle. To scale: faster/remote proof server, or
  multiple keeper wallets publishing partitions in parallel.
- **Reads PG mirror columns, never env**, for per-market params (`challenge_window`,
  `betting_cutoff`, `platform_fee_rate`) — avoids env drift.

### Operational rules
- **Run only ONE keeper instance.** All loops share one wallet; two instances collide on
  the wallet nonce.
- The publish/refund/claim flows pass **`UserAddress` structs** on-chain — see the
  contract README.
- Wallet sync uses `.wallet-cache/<network>.json`; keep it (a full resync is expensive).
- `DATABASE_URL` may stay on the session-mode pooler (`:5432`) — a single long-lived
  process uses few connections. See `../../../database/README.md`.
