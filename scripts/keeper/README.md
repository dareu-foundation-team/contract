# DareU V2 Keeper

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

The supervisor gives the initial Preprod wallet replay up to six hours and saves
a wallet-state checkpoint every 10,000 applied DUST events. Override
`MIDNIGHT_WALLET_SYNC_TIMEOUT_MS` or `MIDNIGHT_WALLET_CHECKPOINT_EVERY` in a
category-specific env file when needed. A failed setup saves its partial state,
closes the wallet, and exits before the supervisor starts a fresh process.

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

The Keeper must use the same deployment manifest and nine V2 proving circuits as
the WebApp. It must not load the cold owner secret as a runtime fallback.
