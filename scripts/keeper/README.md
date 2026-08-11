# DareU V2 Keeper

The Keeper consists of an independent read-only mirror and the active
direct-resolution pipeline:

```text
Indexer → sync (30s, global, change-only batch update) → Postgres

crypto/stocks/sports: publish → resolve → cancel → sleep
```

- `sync-v2.ts`: one global process mirrors OPEN/RESOLVED/CANCELLED state and
  pools from chain. It reads the shared contract once per cycle and uses one
  conditional batch update, so unchanged rows are not rewritten. Cycles never
  overlap; the default 30-second interval starts after the previous cycle ends.
- `publish-v2.ts`: publishes eligible drafts with `create_market`.
- `resolve-v2.ts`: submits `resolve_market` for `ready_to_resolve`, and
  `cancel_market` for `cancel_requested`.
- `run-v2.ts`: schedules wallet/prover transaction work only. DUST shortages or
  a long publish/cancel queue cannot delay the read-only mirror.

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

Required configuration includes:

- `DATABASE_URL`
- `DAREU_REGISTRY_ADDRESS`
- `DAREU_OPERATOR_SECRET_KEY`
- category-specific wallet seed/mnemonic
- `MIDNIGHT_PRIVATE_STATE_PASSWORD`
- Midnight network endpoints and proof server

The Keeper must use the same deployment manifest and nine V2 proving circuits as
the WebApp. It must not load the cold owner secret as a runtime fallback.
