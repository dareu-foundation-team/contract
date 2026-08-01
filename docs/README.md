# DareU V2 Direct-Resolution Protocol

## Trust model

- `owner`: cold administration key; rotates the operator and withdraws earned fees.
- `operator`: hot Keeper key; creates, resolves and cancels markets.
- `oracle`: frozen per market; may resolve or cancel only that market.
- users: authorize value movement by spending shielded sNIGHT and position tickets.

There is no user challenge or subjective adjudication. The result must be
calculated from the settlement rule committed for the market and submitted by an
authorized platform identity.

## State machine

Only three on-chain states exist:

- `OPEN`
- `RESOLVED`
- `CANCELLED`

An OPEN market can transition exactly once to RESOLVED or CANCELLED. A resolved
or cancelled market cannot be reopened or resolved again.

## Constructor and ledgers

Constructor:

```text
(owner_secret_key, underlying, token_domain, operator_participant_id)
```

Core ledgers:

- `owner`, `operator`, `underlying_token`, `token_domain`
- `markets`, `positions`, `market_fees`, `market_count`

There are no bond, proposal, resolution-record, council, vote or challenge-window
ledgers.

## Circuits

| Circuit | Authorization | Effect |
|---|---|---|
| `deposit` | public | wrap underlying into sNIGHT |
| `withdraw` | sNIGHT holder | burn sNIGHT and release underlying |
| `create_market` | owner/operator | create an OPEN market |
| `place_bet` | sNIGHT holder | burn stake+fee and mint a claim ticket |
| `claim_settled` | ticket + payout binding | pay winner or cancelled refund |
| `resolve_market` | owner/operator/market oracle | OPEN → RESOLVED after close |
| `cancel_market` | owner/operator/market oracle | OPEN → CANCELLED |
| `set_operator` | owner | rotate or revoke the hot operator |
| `withdraw_treasury` | owner | withdraw fees from RESOLVED markets only |

## Direct settlement constraints

`resolve_market(market_id, outcome)` requires:

- the market exists and is OPEN;
- current block time is after `close_time`;
- outcome is YES or NO;
- caller is owner, operator or the market oracle;
- the selected winning pool is non-zero.

DataProvider may use `manual_review` only as an off-chain data-quality task state.
It cannot authorize a subjective result. Once objective data is available it
emits `ready_to_resolve`; if the committed rule says the market is void or the
winning pool is empty, it emits `cancel_requested`.

## Required deployment cutover

The direct-resolution ABI is not compatible with earlier deployed instances.
Deploy a new V2 contract, update the Registry, Keeper and WebApp to the same
manifest, and verify the nine circuit artifacts before sending transactions.
