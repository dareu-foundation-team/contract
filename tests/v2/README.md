# DareU **v2** contract tests

Network-free unit tests that run the **real compiled v2 circuits** in-process via
`@midnight-ntwrk/compact-runtime` (no node / proof server / indexer). ZK proving is
skipped; the JS execution of each circuit — asserts, ledger writes, token effects,
`kernel.blockTime*` checks — is exercised directly against `src/managed/dareu-v2`.

## Run

Standalone (v2 only):

```bash
node --import tsx --test "tests/v2/**/*.test.ts"
```

The repo-wide `npm test` (`tests/**/*.test.ts`) also picks these up alongside the v1
suite. A dedicated `test:v2` npm script was intentionally **not** added to avoid a
merge conflict with concurrent `package.json` edits (deploy-v2 tooling); if you want
one, add:

```json
"test:v2": "node --import tsx --test \"tests/v2/**/*.test.ts\""
```

> Requires the compiled artifact `src/managed/dareu-v2`. Rebuild if the contract
> changed: `compact compile +0.31.1 src/dareu-v2.compact src/managed/dareu-v2`.

## How value is tracked

v2 moves value through **shielded coins** (sNIGHT) and unshielded sends, not a single
unshielded escrow. `tests/v2/helpers/simulator.ts` captures the runtime's per-call
token **effects** (`shieldedMints`, `unshieldedInputs`, `unshieldedOutputs`) after
every call. The sNIGHT color is derived exactly as the contract does
(`tokenType(token_domain, contractAddress)` via `rawTokenType`), and per-position
claim-ticket colors via `tokenType(pos_id, contractAddress)`. The §8 solvency test
maintains an independent value-flow model (`Book`) and reconciles it against the
public ledger and the invariant after each step.

## Coverage map (7 required areas → test files)

| # | Area | File |
|---|------|------|
| 1 | Permission matrix (owner/operator/stranger × create/cancel/set_role/withdraw_treasury; operator revoke; zero-operator default) | `permissions.test.ts` |
| 2 | Ticket-gated claim, three gates (wrong color, wrong pk pre-image, double-claim, loser, unresolved, CANCELLED branch) | `claim.test.ts` |
| 3 | Floor-bracket math (gross_profit & platform_fee off-by-one over/under; exact; one-sided zero-profit) | `claim.test.ts` |
| 4 | Oracle lifecycle (propose bond-value, dispute self-pk + window, vote→2×bond, finalize→1×bond, stuck-cancel→both bonds, no-winners) | `oracle.test.ts` |
| 5 | Vault (deposit exact mint; withdraw exact pay; wrong-color coin in withdraw/place_bet/bonds) | `vault.test.ts` |
| 6 | §8 solvency simulation (multi-user × 3 markets: resolve/cancel/dispute + lost-ticket; invariant after each step; permanent-surplus) | `solvency.test.ts` |
| 7 | market_fees accrual + withdraw_treasury sweep exactness / zero-after-sweep | `treasury.test.ts` |
| + | Audit fixes: FIX 1 (refund_seq per-call increment → distinct bond-refund nonces), FIX 2 (close_time overflow bound), FIX 3 (close_time > betting_cutoff), proposal block-time anchoring / grace-overflow rejection / nonempty proposer refund key | `oracle.test.ts` (oracle guards), `guardrails.test.ts` (FIX 2/3) |

## NOT simulatable here — must be verified in the on-chain demo phase

The compact-runtime circuit simulation faithfully covers circuit **logic**, asserts,
ledger writes, block-time gating, and the **declared** token effects (amounts a
circuit says it mints/receives/pays and the coin colors it checks). It does **not**
model the zswap UTXO layer. The following therefore need on-chain confirmation and
feed the wallet-demo checklist:

1. **Real coin existence / spendability.** The runtime accepts a fabricated
   `ShieldedCoinInfo` as input (it records the receive/spend as an effect but does not
   verify a matching UTXO exists). So "wrong color rejected" and "value != amount
   rejected" ARE tested here, but **"insufficient/non-existent real balance rejected"
   is NOT** — that is enforced by zswap balancing on-chain.
2. **Shielded burn actually destroys a coin.** `receiveShielded` + `sendImmediateShielded`
   to `shieldedBurnAddress()` (in withdraw / place_bet / bond posting) does not surface
   in the runtime effect maps (`claimedShieldedReceives`/`Spends` stay empty in-sim). We
   assert the *observable* side (exact underlying paid, no stray mint), but that the
   input coin is truly consumed/burned must be confirmed on-chain.
3. **Per-recipient mint split.** The `shieldedMints` effect map is keyed by **color**,
   so multiple same-color mints in one call (e.g. stuck-cancel refunding proposer AND
   disputer, both sNIGHT) **aggregate** into a single entry. We assert the *total*
   (2×bond) but cannot confirm the two separate outputs landed on the two distinct pks
   in-sim. On-chain, verify each pk receives its own coin.
4. **Mint recipient key delivery.** That a payout/ticket/bond coin is actually
   receivable by the intended `ZswapCoinPublicKey` wallet (coin-ciphertext delivery /
   Lace visibility) — spec V1/V4/V6 — is a wallet concern, untestable in-sim.
5. **DUST / fees / balancing.** Transaction fee sufficiency and wallet balancing are
   out of scope for circuit simulation.

## Security regressions covered here

`oracle.test.ts` permanently covers three proposal bugs fixed in the contract:

- a proposal made long after market close could previously set `deadline = now + 1`,
  leaving almost no real challenge period;
- a near-`Uint<64>::MAX` deadline could later overflow the stuck-cancel grace
  calculation; and
- an all-zero proposer refund key could burn a bond whose refund was unusable.

The suite also documents two simulator details: a one-sided market writes a harmless
zero `market_fees` bucket, and same-color stuck-cancel refunds aggregate in the
runtime effect map (see #3 above).
