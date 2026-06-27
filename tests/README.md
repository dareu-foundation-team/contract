# DareU contract tests

Network-free unit tests that run the **real compiled circuits** in-process via
`@midnight-ntwrk/compact-runtime` (no node / proof server / indexer needed). ZK
proving is skipped; the JS execution of each circuit — asserts, ledger writes,
token effects, `kernel.blockTime*` checks — is exercised directly.

## Run

```bash
npm test           # run once
npm run test:watch # re-run on change
npm run typecheck  # also type-checks the tests
```

> Requires the compiled artifact `src/managed/dareu` — run `npm run build` first
> if it is missing or the contract changed.

## How it works

`tests/helpers/simulator.ts` builds a `CircuitContext` from the contract's
ledger state and runs a circuit as a chosen caller at a chosen block time. The
contract's identity ("msg.sender") is `participant_id(local_secret_key())`, and
the witness closure binds one secret key per `Contract` instance — so each call
uses a fresh per-caller contract over the single shared ledger state. Block time
is supplied through `createCircuitContext`'s `time` argument. Identities and
`position_id`s are derived through the exported `pureCircuits`, so tests never
re-implement the contract's hashing.

## Coverage (13 circuits + constructor)

| Circuit / area | File |
|---|---|
| constructor (fee invariant) | `admin.test.ts` |
| `set_arbiter` | `admin.test.ts` |
| `create_market`, `place_bet` | `markets.test.ts` |
| `propose_resolution`, `dispute_resolution`, `finalize_proposal`, `vote_dispute` | `oracle.test.ts` |
| `cancel_market` stuck-market escape hatch (locked-funds fix) | `oracle.test.ts` |
| `claim_winnings` (floor-division brackets), `cancel_market`, `refund_cancelled_position`, `withdraw_credit`, `withdraw_treasury` | `payouts.test.ts` |
| harness smoke (blockTime + receiveUnshielded) | `smoke.test.ts` |

Each circuit has happy-path coverage plus negative tests for its `assert`
guards (authorization, state-machine phase, time windows, double-claim, and the
exact-floor bracket bounds for payouts).
