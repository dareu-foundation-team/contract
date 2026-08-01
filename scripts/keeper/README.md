# DareU V2 Keeper

The Keeper is the active direct-resolution pipeline:

```text
sync → publish → resolve → cancel → sleep
```

- `sync-v2.ts`: mirrors OPEN/RESOLVED/CANCELLED state and pools from chain.
- `publish-v2.ts`: publishes eligible drafts with `create_market`.
- `resolve-v2.ts`: submits `resolve_market` for `ready_to_resolve`, and
  `cancel_market` for `cancel_requested`.
- `run-v2.ts`: schedules the complete cycle.

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

Required configuration includes:

- `DATABASE_URL`
- `DAREU_REGISTRY_ADDRESS`
- `DAREU_OPERATOR_SECRET_KEY`
- category-specific wallet seed/mnemonic
- `MIDNIGHT_PRIVATE_STATE_PASSWORD`
- Midnight network endpoints and proof server

The Keeper must use the same deployment manifest and nine V2 proving circuits as
the WebApp. It must not load the cold owner secret as a runtime fallback.
