# DareU Keeper (V3 default; V2 retained)

V3 has separate `keeper:v3:*` commands and uses the deployed `dareu-v3`
artifact. Its `create_market` ABI and market-ledger mirror match V2, while
resolution/cancellation use `settle_market_action(market_id, RESOLVE|CANCEL,
outcome)`. V3 SQL is restricted to rows marked with the V3 contract address;
drafts already published on V2 are never re-published on V3. The DataProvider
resolver now accepts both V2 and V3 published markets.

Before starting a V3 keeper, register NIGHT in the registry against the V3
market address and sNIGHT color, then check each category's operator key and
wallet independently:

```bash
npm run keeper:v3:preflight -- preprod crypto
npm run keeper:v3:wallet -- preprod crypto
SYNC_INTERVAL_SEC=0 npm run keeper:v3:sync -- preprod
```

Use `stocks` and `sports` in place of `crypto` for their preflights. The
read-only sync is one global process; the transaction keeper is one process per
category. `keeper:run`, `keeper:publish`, `keeper:sync`, `keeper:resolve`, and
managed `keeper:multi` now default to V3. The managed supervisor accepts
`DAREU_KEEPER_CONTRACT_VERSION=v2` to run the retained V2 commands, but the
registry must then still point to V2. Stop existing keeper/sync supervisors
before switching versions; the same PID files are deliberately shared to
prevent two versions competing for the same queue.

No keeper is started or transaction submitted by this code change.

## V2 operational details

The Keeper consists of an independent read-only mirror and the active
direct-resolution pipeline:

```text
Indexer → sync (30s, global, change-only batch update) → Postgres

crypto/stocks/sports:
funded resolve/cancel → bounded publish → funded resolve/cancel → empty cleanup
```

- `sync-v2.ts`: one global process mirrors OPEN/RESOLVED/CANCELLED state and
  pools from chain. It reads the shared contract once per cycle and uses one
  conditional batch update, so unchanged rows are not rewritten. Cycles never
  overlap; the default 30-second interval starts after the previous cycle ends.
- `publish-v2.ts`: publishes eligible drafts with `create_market`. The managed
  keeper limits each turn with `PUBLISH_QUANTUM` (default 10) and checks for
  settlement/refund work between transactions. An in-flight proof is allowed to
  finish before publishing yields, so wallet contexts never overlap.
- `resolve-v2.ts`: submits `resolve_market` for `ready_to_resolve`. Funded
  `cancel_requested` refunds are urgent; empty 0/0 cancellations are handled by
  a separate low-volume cleanup turn.
- `run-v2.ts`: schedules wallet/prover transaction work only. DUST shortages or
  a long publish/cancel queue cannot delay the read-only mirror.

Funded lifecycle work has strict priority over market creation. Empty markets do
not preempt publishing and are capped by `EMPTY_CANCEL_LIMIT` (default 2) per
eligible cleanup turn. If a cycle resolves, cancels or publishes anything, the next priority check runs after
`KEEPER_BUSY_RETRY_SEC` (default 5 seconds); an idle keeper keeps the normal
`KEEPER_CYCLE_SEC` interval (default 300 seconds). The standalone
`keeper:v2:publish` command remains a bulk operation controlled by
`PUBLISH_LIMIT`.

There are no proposal, finalization, bond, challenge, dispute or stuck-market
loops.

## Run

```bash
npm run keeper:v2:preflight -- preprod crypto
npm run keeper:v2:run -- preprod crypto
```

Run one process per category (`crypto`, `stocks`, `sports`). Each category must
have separate wallet cache, private-state namespace, PID/log files and operator
wallet configuration.

For managed background processes, use:

```bash
npm run keeper:multi -- start preprod
npm run keeper:multi -- status preprod
npm run keeper:multi -- restart preprod
npm run keeper:multi -- stop preprod
```

The optional third argument targets exactly one service and leaves every other
Keeper and the global sync process untouched:

```bash
npm run keeper:multi -- stop preprod crypto
npm run keeper:multi -- start preprod stocks
npm run keeper:multi -- restart preprod sports
npm run keeper:multi -- status preprod sync
```

Valid targets are `crypto`, `stocks`, `sports`, `sync`, and `all` (the default).

Every `start` or `restart` creates a fresh log for each category under `logs/`,
named `keeper-<category>-YYYYMMDD-HHMMSS.log`. The status command prints the
log path associated with the current process (or the most recently stopped one).
The same command also manages the one global mirror process and its
`keeper-sync-YYYYMMDD-HHMMSS.log` file.

To manage only the mirror without restarting transaction Keepers:

```bash
npm run keeper:sync:multi -- start preprod
npm run keeper:sync:multi -- status preprod
npm run keeper:sync:multi -- restart preprod
npm run keeper:sync:multi -- stop preprod
```

Set `SYNC_INTERVAL_SEC` to override the 30-second default. Set it to `0` for a
single foreground sync, for example:

```bash
SYNC_INTERVAL_SEC=0 npm run keeper:v2:sync -- preprod
```

Run `keeper:v2:prepare-wallet` or `keeper:v3:prepare-wallet` before starting the
service. Preparation has no absolute wall-clock limit while cursors advance. It
stops all wallet streams and writes a verified working checkpoint every 25,000
applied DUST events, every 15 minutes, or at the 4GB soft heap boundary, then
resumes in a fresh process with a 12GB V8 heap ceiling. If a child still reaches
OOM before committing its atomic checkpoint, the parent preserves the previous
checkpoint, lowers the next soft boundary toward a 2GB floor, and retries at
most three times. Only a fully synchronized wallet is promoted to `.last-good`.
A separate progress watchdog defaults to ten minutes
(`MIDNIGHT_WALLET_SYNC_STALL_TIMEOUT_MS`): if any required unsynced cursor stops
advancing, the wallet context is restarted. The operational Keeper accepts only
a fully prepared `.last-good` snapshot and never performs a silent cold replay.
A stalled DUST cursor additionally
quarantines the working checkpoint, and the next process restores last-known-good
or performs a cold replay. If the active checkpoint and last-known-good have the
same SHA-256 fingerprint, both are quarantined because restoring identical tree
state cannot repair a non-linear replay. A cold recovery creates a canary marker;
the next publish run is limited to one market until that transaction finalizes
and the wallet completes its post-transaction sync. A second stall at the same
DUST index
(`MIDNIGHT_WALLET_SYNC_RECOVERY_ATTEMPTS`, default 2) exits with status 78 and
stops the supervisor for operator inspection instead of replaying forever.
Fully synced and post-transaction-settled states alone are promoted to
`<cache>.last-good`; quarantined files remain recoverable as
`<cache>.quarantine-*`. Override `MIDNIGHT_WALLET_CHECKPOINT_EVERY`,
`MIDNIGHT_WALLET_REPLAY_SEGMENT_MS`, or the stall timeout in a category-specific
env file when needed.
Before starting wallet services, the keeper performs a bounded `system_health` websocket probe
(`MIDNIGHT_RPC_PREFLIGHT_TIMEOUT_MS`, default 15 seconds). A failed setup closes
every partially-started wallet service and exits before the supervisor starts a
fresh process.

After every successful write, the Keeper waits for the transaction to be
finalized by the Indexer, for the wallet's DUST applied index to advance, for
all DUST/pending-transaction bookings to clear, and for every wallet stream to
reach the exact Indexer tip before it builds another proof. The barrier timeout
defaults to five minutes and can be changed with
`MIDNIGHT_WALLET_POST_TX_SYNC_TIMEOUT_MS`. A barrier failure or node
`Custom error: 170` destroys the current wallet context; only the supervisor's
fresh process may retry. A transaction rejected with 170 stays `draft`, while a
transaction finalized before a barrier failure stays marked `open`. Wallet state
mutated by an unconfirmed/rejected transaction is never cached or promoted to
`.last-good`; the fresh process restores the last post-settlement snapshot.

Consecutive short-lived process failures use exponential restart backoff instead
of reconnecting every 20 seconds. Configure the base, cap and stable-runtime reset
with `KEEPER_RESTART_DELAY_SEC` (default 20), `KEEPER_RESTART_MAX_DELAY_SEC`
(default 300) and `KEEPER_RESTART_STABLE_SEC` (default 600).

Before proving a write, each wallet session performs an exact sync and reports
its spendable DUST coin count. A wallet with no spendable DUST aborts the whole
batch before proving the first market and retries after `KEEPER_DUST_RETRY_SEC`
(default 300 seconds). This is expected time-based backpressure, not a broken
wallet context. Fund and register a new Keeper wallet once with:

```bash
npm run keeper:v2:prepare-wallet -- preprod crypto
```

Use the appropriate category in place of `crypto`. The DUST fee headroom defaults
to 1,000 specks and can be overridden with
`MIDNIGHT_DUST_ADDITIONAL_FEE_OVERHEAD`; do not restore the old
`300000000000000` value because it can make an otherwise affordable transaction
fail local DUST coin selection.

Postgres connect, query, statement, lock and close phases are independently
bounded by the `PG_*_TIMEOUT_MS` settings. Database timeouts invalidate the
current keeper process so the supervisor can recover instead of leaving a live
PID blocked on a dead socket.

Required configuration includes:

- `DATABASE_URL`
- `DAREU_REGISTRY_ADDRESS`
- `DAREU_OPERATOR_SECRET_KEY`
- category-specific wallet seed/mnemonic
- `MIDNIGHT_PRIVATE_STATE_PASSWORD`
- Midnight network endpoints and proof server

Wallet caches are operational state, not build artifacts. In containers set
`MIDNIGHT_WALLET_CACHE_DIR` to a durable mounted volume; startup verifies that
the directory is readable/writable and creates a `.durable-wallet-cache` marker.
Each checkpoint records its schema, wallet role, network, genesis hash, three
cursor sets and per-wallet blob hashes. It is read-back verified and replaced
atomically under a write lock. Configure
`KEEPER_WALLET_ALERT_WEBHOOK_URL` to receive unhealthy structured wallet-health
snapshots; logs always contain the same JSON metrics even without a webhook.

Wallet secrets support `*_MNEMONIC_FILE` / `*_SEED_FILE`. Production should
mount those mode-0600 files from its Secret Manager/sidecar instead of placing
seed material directly in `.env.local` or category env files.

The Keeper must use the same deployment manifest and nine V2 proving circuits as
the WebApp. It must not load the cold owner secret as a runtime fallback.
