# DareU Keeper

Long-running service that bridges the off-chain draft markets (Postgres) and the on-chain
contract, and drives the optimistic-oracle resolution loops.

The production path is V2-only and category-sharded: one process and one Midnight
wallet each for `crypto`, `stocks`, and `sports`. There is no V1 fallback and old V1
market rows are never submitted to the V2 lifecycle loops.

Run `npm run keeper:v2:preflight -- preprod crypto` first for a read-only Registry/address/
ledger check. It does not open a wallet, submit a transaction, or write Postgres.

At startup the V2 keeper resolves native NIGHT from the on-chain Registry (address from
`DAREU_REGISTRY_ADDRESS` or `deployments/<network>-registry.json`) and validates that:

- the asset exists and is enabled;
- its market address and sNIGHT color match `deployments/<network>-v2.json`;
- its decimals are read from the Registry rather than assumed.

Set `DAREU_KEEPER_ASSET_UNDERLYING_HEX` to run a keeper for a non-NIGHT instance.
All-zero/unset selects native NIGHT.

### Stake-fee model (2026-07-13)

Keeper still publishes each immutable `platform_fee_rate` (normally 100 bps). The V2
contract now interprets it as a fee on every accepted stake, escrowed until resolution
and refunded on cancellation. Keeper does not collect or refund user fees itself.
Because the user-circuit ABI changed, deploy/register the new V2 artifact before running
Keeper against markets intended for this model; the current preprod address is older.

## Category-sharded Keepers

`markets.category` is the strict off-chain work partition. Every publish, propose,
finalize, requested-cancel, stuck-cancel, and mirror update is limited to exactly one
of `crypto`, `stocks`, or `sports`. An unscoped Keeper is rejected at startup, so two
wallets cannot select the same market. Category is not a separate on-chain field; its
integrity still comes from the committed metadata hash and the trusted DataProvider/
Postgres pipeline.

Create the three private wallet files (all `*.local` files are ignored by Git):

```bash
cp .env.keeper.crypto.example .env.keeper.crypto.local
cp .env.keeper.stocks.example .env.keeper.stocks.local
cp .env.keeper.sports.example .env.keeper.sports.local
```

Put one wallet mnemonic or seed in each file. Common settings remain in `.env.local`:
`DATABASE_URL`, network endpoints, `MIDNIGHT_PRIVATE_STATE_PASSWORD`, and the single
`DAREU_OPERATOR_SECRET_KEY` authorized by the deployed contract. The three Midnight
wallets are independent transaction/bond accounts, but the current Compact contract
has one operator role, so all three processes intentionally use that same operator
witness. Each wallet must be separately funded with NIGHT/DUST; proposal workflows also
need enough NIGHT to mint their own sNIGHT bond coin.

Manage all three services together:

```bash
npm run keeper:multi -- start preprod
npm run keeper:multi -- status preprod
npm run keeper:multi -- restart preprod
npm run keeper:multi -- stop preprod
```

Runtime files are isolated:

```text
logs/keeper-crypto.log              .wallet-cache/preprod-crypto.json
logs/keeper-stocks.log              .wallet-cache/preprod-stocks.json
logs/keeper-sports.log              .wallet-cache/preprod-sports.json
.midnight-state/level-db-crypto     (and stocks/sports)
```

Individual diagnostics use the same category argument and wallet file:

```bash
npm run keeper:v2:wallet -- preprod crypto
npm run keeper:v2:db -- preprod crypto
tail -f logs/keeper-crypto.log
```

After funding each address with Preprod NIGHT, initialize its DUST generation once:

```bash
npm run keeper:v2:prepare-wallet -- preprod crypto
npm run keeper:v2:prepare-wallet -- preprod stocks
npm run keeper:v2:prepare-wallet -- preprod sports
```

This preparation command may submit a NIGHT UTXO registration transaction. The ordinary
`keeper:v2:wallet` diagnostic remains read-only.

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
sNIGHT bond coin. The wallet cache remains in `.wallet-cache/<network>-<category>.json`, so later
runs resume incrementally. A successful deposit must not be repeated merely because an
older run timed out; run the read-only wallet diagnostic first:

```bash
npm run keeper:v2:wallet -- preprod crypto
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
npm run keeper:v2:db -- preprod crypto
```

The report separates legacy rows, rows belonging to the current V2 instance, future
rows eligible for V2 publication, and current V2 cancel requests.

### Connection recovery and process supervision

Every V2 `callTx` now has a bounded `KEEPER_TX_TIMEOUT_MS`. A rejected transport error
(`ECONNRESET`, wallet/indexer websocket failure, or node custom error 170) aborts the
current batch immediately, closes the wallet, and retries the full cycle after
`KEEPER_ERROR_RETRY_SEC`. It does not continue submitting the remaining rows with a
stale DUST/UTXO view.

A timed-out SDK Promise cannot be cancelled safely inside the same Node process. The
Keeper therefore exits on that specific condition, and `keeper:service` starts a clean
process after `KEEPER_RESTART_DELAY_SEC`. This prevents a timed-out submission from
overlapping a replacement wallet in the same process.

Publishing uses two different limits:

- `PUBLISH_LIMIT=500` — total markets selected for one cycle, so a large backlog is
  drained continuously without a five-minute sleep every 20 transactions;
- `PUBLISH_SESSION_SIZE=20` — transactions handled by one wallet/WebSocket context.
  After each group the Keeper saves wallet state, closes all wallet services, reconnects,
  performs a short incremental sync, and immediately continues the same 500-market sweep.

`KEEPER_MAX_PUBLISH_LIMIT` caps total cycle work (default 1000), while
`KEEPER_MAX_BATCH_SIZE` caps a single wallet session and the lifecycle loops (default
50). `PUBLISH_MIN_LEAD_SEC` also excludes markets that are too close to
`close_time - betting_cutoff`; the lead is checked again immediately before proving.

`contract-keeper-run.sh` is a personal manual command notebook and is not the service
controller. To start only one category during maintenance, run its supervisor directly:

```bash
nohup bash scripts/keeper/supervise-v2.sh preprod crypto >> logs/keeper-crypto.log 2>&1 &
echo $! > logs/keeper-crypto-supervisor.pid
tail -f logs/keeper-crypto.log
```

Run `npm run keeper:v2:preflight -- preprod crypto` before starting. The supervisor
terminates the complete npm/tsx/node child tree and restarts only after it exits.

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
- **`publish-v2.ts`** — reads future draft/open rows for its assigned category that are not yet owned by the current V2
  instance, validates their immutable parameters, calls `create_market`, then sets
  `status='open'`, `onchain_tx_id`, version, address, and initial mirror values. This is
  what the Webapp gates the live feed on.
- **`autopropose-v2.ts`** — `ready_to_propose → propose_resolution`; `proposed →
  finalize_proposal` after the challenge window; `cancel_requested → cancel_market`;
  stuck `proposed/disputed → cancel_market`.

---

## Upgrade Notes (odds-v2)

- **`PUBLISH_LIMIT` sweep.** Each `create_market` is a separate on-chain transaction with
  its own ZK proof. `PUBLISH_LIMIT=500` keeps the backlog sweep continuous, but those
  rows are split into `PUBLISH_SESSION_SIZE=20` wallet sessions. This preserves the
  throughput benefit of a large cycle without keeping one wallet websocket alive for
  hundreds of proofs. **DUST cost remains per transaction**; session rotation changes
  connection lifetime, not proof count or fees.
- **Throughput reality.** Publishing is proof-bound: the local proof server
  (`MIDNIGHT_PROOF_SERVER`, default `127.0.0.1:6300`) generates one zk-SNARK per market,
  sequentially. Observed ≈ 10–20 markets/cycle. To scale: faster/remote proof server, or
  multiple keeper wallets publishing partitions in parallel.
- **Reads PG mirror columns, never env**, for per-market params (`challenge_window`,
  `betting_cutoff`, `platform_fee_rate`) — avoids env drift.

### Operational rules
- Run exactly **one instance per category**. The three instances have disjoint DB work,
  wallet secrets, cache files, logs, PID files, and private-state LevelDB directories.
  Never start a second instance for the same category/wallet.
- Use Compact **0.31.1** artifacts and proof-server **8.1.0**. `MIDNIGHT_PROOF_SERVER`
  must point at the 8.1.0 server used by this Keeper.
- V2 proposal/dispute bonds are shielded sNIGHT coins; user payout/refund claims are
  ticket-gated browser transactions and are not submitted by Keeper.
- Wallet sync uses `.wallet-cache/<network>-<category>.json`; keep it (a full resync is expensive).
- `DATABASE_URL` may stay on the session-mode pooler (`:5432`) — a single long-lived
  process uses few connections. See `../../../database/README.md`.

### Preprod verification from this cutover

- The previously deposited `1,000,000` sNIGHT bond coin was recovered after shielded
  sync; no second deposit was needed.
- The legacy dataset remained intact while its rows were excluded from V2 cancellation.
- The V2 cancel-request report returned zero before restart.
- The restarted Keeper completed full shielded sync and began publishing V2 markets
  consecutively without the earlier bond-timeout or `Market does not exist` storm.
