# DareU Keeper

Long-running service that bridges the off-chain draft markets (Postgres) and the on-chain
contract, and drives the optimistic-oracle resolution loops.

The production path is V2-only. Run `npm run keeper:run -- preprod` (the explicit alias
`npm run keeper:v2:run -- preprod` is equivalent; see `contract-keeper-run.sh`). There
is no V1 fallback and old V1 market rows are never submitted to the V2 lifecycle loops.

Run `npm run keeper:v2:preflight -- preprod` first for a read-only Registry/address/
ledger check. It does not open a wallet, submit a transaction, or write Postgres.

At startup the V2 keeper resolves native NIGHT from the on-chain Registry (address from
`DAREU_REGISTRY_ADDRESS` or `deployments/<network>-registry.json`) and validates that:

- the asset exists and is enabled;
- its market address and sNIGHT color match `deployments/<network>-v2.json`;
- its decimals are read from the Registry rather than assumed.

Set `DAREU_KEEPER_ASSET_UNDERLYING_HEX` to run a keeper for a non-NIGHT instance.
All-zero/unset selects native NIGHT.

---

## V2-only Keeper update (2026-07-11)

### Wallet and sNIGHT bond fix

The Keeper now starts and synchronizes all wallet services:

- shielded (sNIGHT and position/bond coins);
- unshielded;
- DUST;
- pending transactions.

Waiting only for DUST is insufficient for V2. It can make a successful `deposit`
transaction appear to have minted no sNIGHT and eventually fail with:

```text
Deposit submitted but the minted sNIGHT bond coin did not appear ... within 600000ms
```

`connectKeeperV2` therefore waits for the complete wallet state before selecting an
sNIGHT bond coin. The wallet cache remains in `.wallet-cache/<network>.json`, so later
runs resume incrementally. A successful deposit must not be repeated merely because an
older run timed out; run the read-only wallet diagnostic first:

```bash
npm run keeper:v2:wallet -- preprod
```

It prints the resolved Registry asset, sNIGHT color, available matching coins, values,
and nonces without submitting a transaction.

### V1/V2 database isolation

Every on-chain market mirror is now namespaced by:

- `markets.onchain_contract_version` — currently `v2`;
- `markets.onchain_contract_address` — the exact Registry-resolved V2 instance.

The schema files add both nullable columns. Keeper also applies
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for an existing database. The database role
must therefore have permission to add these columns during the first upgraded run (or
the migration must be applied beforehand).

Publish may republish still-future legacy/draft rows into the current V2 instance and
then stamps both namespace fields. Propose, finalize, requested-cancel, and stuck-cancel
select only rows matching both `v2` and the current contract address. This prevents old
V1 rows from producing repeated `Market does not exist` failures after a V2 redeploy.

Read-only namespace report:

```bash
npm run keeper:v2:db -- preprod
```

The report separates legacy rows, rows belonging to the current V2 instance, future
rows eligible for V2 publication, and current V2 cancel requests.

## Cycle

`run-v2.ts` executes one **full cycle every `KEEPER_CYCLE_SEC` (default 300s = 5min)**,
in order:

```
sync → publishDrafts → autoPropose → finalize → cancelRequested → cancelStuck → sleep
```

The 300s is the pause **after** a cycle finishes, not a timeout — a cycle runs to
completion (a large publish batch can take much longer than 5 min).

### Loops
- **`sync-v2.ts`** — mirrors on-chain status / pools (`onchain_status`,
  `onchain_yes_pool/no_pool`, `onchain_outcome`) back into Postgres. Runs first so the
  other loops see fresh state and stamps the current V2 namespace.
- **`publish-v2.ts`** — reads future draft/open rows not yet owned by the current V2
  instance, validates their immutable parameters, calls `create_market`, then sets
  `status='open'`, `onchain_tx_id`, version, address, and initial mirror values. This is
  what the Webapp gates the live feed on.
- **`autopropose-v2.ts`** — `ready_to_propose → propose_resolution`; `proposed →
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
- Use Compact **0.31.1** artifacts and proof-server **8.1.0**. `MIDNIGHT_PROOF_SERVER`
  must point at the 8.1.0 server used by this Keeper.
- V2 proposal/dispute bonds are shielded sNIGHT coins; user payout/refund claims are
  ticket-gated browser transactions and are not submitted by Keeper.
- Wallet sync uses `.wallet-cache/<network>.json`; keep it (a full resync is expensive).
- `DATABASE_URL` may stay on the session-mode pooler (`:5432`) — a single long-lived
  process uses few connections. See `../../../database/README.md`.

### Preprod verification from this cutover

- The previously deposited `1,000,000` sNIGHT bond coin was recovered after shielded
  sync; no second deposit was needed.
- The legacy dataset remained intact while its rows were excluded from V2 cancellation.
- The V2 cancel-request report returned zero before restart.
- The restarted Keeper completed full shielded sync and began publishing V2 markets
  consecutively without the earlier bond-timeout or `Market does not exist` storm.
