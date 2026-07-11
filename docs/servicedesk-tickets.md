# Midnight Service Desk — combined ticket

Submit at https://midnightntwrk.github.io/servicedesk/ using the fields below.

**SECURITY**: This description contains NO secrets. Do NOT attach the raw `/check`
request-body hex we captured — it embeds the `local_secret_key` witness (owner secret
key) in plaintext. The summarized evidence below is safe. A safe, strong attachment is
the Lace "Midnight settings" screenshot showing the wallet's Proof Server configured to
`https://proof-server.preprod.midnight.network`.

---

## Bug Description

Two related problems surfaced while proving the SAME Compact 0.31.0 contract `callTx` on
preprod:

**(A) Primary — proof-server `/check` returns "400 bad input" for a 0.31.0 callTx via
`httpClientProofProvider`, while Lace's wallet-delegated proving of the exact same call
SUCCEEDS on the same 8.0.3 prover.** This isolates the problem to `httpClientProofProvider`'s
`/check` request serialization of the 0.31.0 reworked ZKIR — not a proof-server-capability
gap, not user error, not version drift.

**(B) Secondary (blocks working around A by matrix-pinning) — the preprod matrix lists
ledger-v8 8.0.3, but `wallet-sdk-dust-wallet` 4.1.0 needs 8.1.0's `Transaction.addIntent`,**
so pinning ledger-v8 8.0.3 breaks the wallet SDK at deploy. We run ledger-v8 8.1.0 to work
around it.

## Expected Behavior

- (A) `httpClientProofProvider.check()` for a 0.31.0-compiled circuit should be accepted by
  proof-server 8.0.3 `/check` and proceed to `/prove` (as Lace's delegated proving does
  against the same prover), so headless / CLI / keeper `callTx` proving succeeds.
- (B) The matrix's ledger-v8 version and the corresponding `wallet-sdk-*` versions should be
  mutually compatible for deploy + callTx.

## Actual Behavior

- (A) `POST /check` returns HTTP 400, body `bad input`, in ~3 ms.
  `httpClientProvingProvider.check()` builds the payload via
  `createCheckPayload(serializedPreimage, keyMaterial.ir)` — serializing the 0.31 reworked
  wrapped-ir — which the 8.0.3 `/check` deserializer cannot parse. `deploy` (`/prove`) and a
  `create_market` callTx (no Uint downcast / Boolean-in-struct) both SUCCEED via the same
  provider/prover; only circuits using 0.31-reworked ops fail. The `/check` body decodes as
  **structurally complete** (461 bytes: type tag
  `midnight:(proof-preimage-versioned,option(wrapped-ir)):`, all six args, the witness value,
  the derived owner id, ascii circuit id `register_asset`) — it is NOT truncated.
- (B) Pinning ledger-v8 8.0.3 throws at deploy:
  `Transaction.fromParts(...).addIntent is not a function`.

## Steps to Reproduce

Primary (A):
1. Compile a small owner-gated registry contract with circuit
   `register_asset(symbol: Bytes<32>, underlying_color: Bytes<32>, market_address: Bytes<32>,
   snight_color: Bytes<32>, decimals: Uint<64>, enabled: Boolean)` — a
   `Map<Bytes<32>, AssetInfo>` insert guarded by `require_owner()` (hashes a
   `local_secret_key()` witness via `persistentHash`). Compiler 0.31.1, language 0.23.0,
   runtime 0.16.0.
2. Deploy it (SUCCEEDS — `/prove`).
3. Call `register_asset` via `findDeployedContract().callTx.register_asset(...)` with
   `proofProvider = httpClientProofProvider(<local or public 8.0.3 prover>, zkConfigProvider)`.
4. Proving fails at `POST /check` → 400 `bad input`.
5. Contrast: the same callTx proven via Lace `wallet.getProvingProvider()` (same 8.0.3 public
   prover) SUCCEEDS.

Secondary (B):
6. With `wallet-sdk-dust-wallet` 4.1.0, pin `@midnight-ntwrk/ledger-v8` to 8.0.3 (matrix) via
   npm `overrides`, run a contract deploy → `Transaction.fromParts(...).addIntent is not a
   function`.

## Logs and Error Messages

```
# (A) callTx /check rejection
register-asset failed: Unexpected error submitting scoped transaction '<unnamed>':
Error: 'check' returned an error: Error: Failed Proof Server response:
url="https://proof-server.preprod.midnight.network/check", code="400", status="Bad Request"
# proof-server access log: POST /check -> 400, ~3ms ; /check response body: "bad input"

# (A) client-side /check-skip attempt (stub check()->[]) -> proving WASM aborts:
RuntimeError: unreachable   (at unprovenTx.prove / wasm)

# (B) ledger-v8 pinned to 8.0.3, at deploy:
Wallet.Other: Transaction.fromParts(...).addIntent is not a function
  at wallet-sdk-dust-wallet/dist/v1/Transacting.js:236 (dryRunFee)
```

(We will NOT attach the raw `/check` request hex — it embeds the `local_secret_key` witness
in plaintext.)

## Operating System

macOS 26.5.1 (Darwin 25.5.0)

## Node Version

v24.13.0

## SDK Version

- midnight-js-* 4.1.1 (contracts / http-client-proof-provider / types / network-id /
  node-zk-config-provider / indexer-public-data-provider)
- compact-js 2.5.1, compact-runtime 0.16.0, onchain-runtime-v3 3.0.0
- ledger-v8 8.1.0 (matrix says 8.0.3 — see problem B)
- wallet-sdk: facade 4.0.1, dust-wallet 4.1.0 (+ capabilities 3.3.1, prover-client 1.2.2),
  shielded 3.0.1, unshielded-wallet 3.1.0, hd 3.0.2, abstractions 2.1.0, address-format 3.1.2
- proof-server: docker 8.0.3, 8.1.0, :latest (=8.1.0), and public
  `proof-server.preprod.midnight.network` (8.0.3) — ALL reject `/check` identically
- latest STABLE `http-client-proof-provider` = 4.1.1 (only 5.0.0-beta pre-releases exist)

## Compiler Version

compact 0.5.1 (toolchain 0.31.1), language 0.23.0

## Additional Context

**Isolation / what we ruled out (A):**
- Proof-server 8.0.3, 8.1.0, `:latest`, and the public prover — all reject `/check`.
- ledger-v8 8.0.3 and 8.1.0 — no effect on `/check`.
- Bisect: widening the circuit's `decimals` `Uint<8>→Uint<64>` (to drop the Uint downcast),
  recompiled + redeployed, re-ran — STILL 400 → at least one MORE reworked op
  (byte-vector↔Field/Uint or relational compare in the owner-hash / struct-insert path, or
  the `Boolean` field) is also unparseable by 8.0.3 `/check`.
- `/check` is not skippable client-side: stubbing `ProvingProvider.check()`→`[]` makes
  `unprovenTx.prove()` fail with WASM `RuntimeError: unreachable` (the check result is
  consumed by proving).
- Impact scope: the browser DApp (Lace delegated proving) is UNAFFECTED; only headless
  scripts using `httpClientProofProvider` are blocked (`wallet-sdk-facade` has no
  `getProvingProvider`).

**Asks:**
1. Which proof-server version/image parses the Compact 0.31.0 ZKIR on the `/check` wrapped-ir
   path, and is there a publicly reachable prover with it? (`lace-proof-pub.preprod.midnight.network`
   does not resolve via 8.8.8.8 / 1.1.1.1.)
2. ETA for the proof-server release that the toolchain 0.31.0 notes say carries the
   ZKIR-format fix.
3. Is `httpClientProofProvider` 4.1.1's `createCheckPayload` the component to fix (Lace's
   client succeeds against the same 8.0.3 prover), and is a fixed release planned?
4. The precise list of 0.31 reworked ops to avoid so a circuit stays provable on 8.0.3 via
   `httpClientProofProvider` (interim workaround).
5. (B) What is the coherent, mutually-compatible `@midnight-ntwrk/wallet-sdk-*` set for the
   ledger-v8 8.0.3 matrix row — or should the matrix row be ledger-v8 8.1.0? (The matrix
   lists an aggregate "Wallet SDK: 1.0.0" but not the sub-package versions.)

**Related:** toolchain 0.31.0 notes (ZKIR representation change for Uint downcasts,
byte-vector↔Field/Uint conversions, relational comparisons; ZKIR-format fix "in a later
release"). Proof performance: `/check` fails in ~3 ms (deserialization-stage rejection, not a
proving-time/constraint-count issue).
