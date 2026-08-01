# DareU Contracts

DareU uses a shielded V2 parimutuel market on Midnight plus a multi-asset
registry. The active protocol has no proposal, challenge, dispute, arbitration,
or resolution bond.

## Canonical market lifecycle

```text
OPEN ── resolve_market(YES|NO) ──> RESOLVED
  └──── cancel_market() ─────────> CANCELLED
```

`resolve_market` is callable only after `close_time` by the cold owner, hot
operator, or the market-specific oracle. The outcome is final in that single
transaction. `cancel_market` is the terminal refund path.

## Active contracts

| Contract | Source | Purpose |
|---|---|---|
| DareU V2 | `src/dareu-v2.compact` | sNIGHT vault, betting, direct settlement, claims and fees |
| Registry | `src/dareu-registry.compact` | V2 asset discovery and enable/disable control |

The V2 constructor is:

```text
(owner_secret_key, underlying, token_domain, operator_participant_id)
```

The operator is mandatory and never defaults to the owner.

## Toolchain

- Compact compiler `0.31.1`
- Proof server `8.1.0`
- Midnight.js `4.1.x`

```bash
npm run build
npm run typecheck
node --import tsx --test "tests/v2/**/*.test.ts"
```

The V2 build produces nine proving circuits:

- `deposit`
- `withdraw`
- `create_market`
- `place_bet`
- `claim_settled`
- `resolve_market`
- `cancel_market`
- `set_operator`
- `withdraw_treasury`

## Test-environment deployment

A new direct-resolution V2 instance and matching Registry entry must be deployed;
an address running the earlier ABI cannot be upgraded in place.

```bash
npm run deploy:v2:preprod
npm run deploy:registry:preprod
npm run registry:add
```

`DAREU_OPERATOR_SECRET_KEY` is required at deployment and for Keeper operation.
After deployment, update the single deployment manifest consumed by the Keeper
and WebApp, then run a real-wallet deposit → bet → resolve/cancel → claim smoke
test.

See [docs/README.md](docs/README.md) for the current protocol and
[scripts/keeper/README.md](scripts/keeper/README.md) for Keeper operation.
