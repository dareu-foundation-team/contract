# Blocker: proof-server /check rejects Compact 0.31 ZKIR for a callTx circuit

Two ready-to-send drafts:
1. GitHub issue for `midnight-ntwrk/midnight-js` (or `proof-server`)
2. Support/Discord follow-up to the Midnight team

**SECURITY**: neither draft contains any secret. Do NOT attach the raw `/check`
request-body hex we captured — it embeds the `local_secret_key` witness (the owner
secret key) in plaintext. Only the summarized descriptions below are safe to share.

---

## 1) GitHub issue draft

**Title:** proof-server 8.0.3/8.1.0 `/check` returns 400 "bad input" for a Compact 0.31.0-compiled callTx circuit (reworked ZKIR / wrapped-ir path)

**Body:**

> DECISIVE UPDATE (after further investigation): Lace's own wallet (screenshot-confirmed)
> is configured to the SAME public prover `https://proof-server.preprod.midnight.network`
> (reports 8.0.3), and its wallet-delegated proving of this exact callTx SUCCEEDS — while
> `httpClientProofProvider` fails at `/check` against the same server. So this is NOT a
> proof-server-capability gap and NOT "Lace uses a different backend"; it is specifically
> `httpClientProofProvider`'s `/check` payload (`createCheckPayload(preimage, keyMaterial.ir)`,
> which serializes the 0.31 reworked wrapped-ir) being unparseable by 8.0.3's `/check`,
> whereas Lace's client formats the check compatibly against the same server. We also
> confirmed `/check` is NOT skippable: stubbing `ProvingProvider.check()` to `[]` makes
> `unprovenTx.prove()` fail with WASM `RuntimeError: unreachable` — the check result is
> consumed by proving. No newer STABLE `http-client-proof-provider` exists (latest is 4.1.1;
> only 5.0.0-beta pre-releases).

### Summary
A contract `callTx` (circuit call via `midnight-js` `findDeployedContract` + `callTx`,
proven through `httpClientProofProvider`) fails at the proof-server `/check` endpoint
with **HTTP 400, body `bad input`, in ~3ms**. `deploy` (`/prove`) works; the same
callTx succeeds via **wallet-delegated proving** (Lace's prover backend). This matches
the ZKIR-representation change flagged in the toolchain 0.31.0 notes.

### Environment (all preprod-matrix aligned)
- compact compiler 0.31.1 / toolchain 0.5.1, language 0.23.0, compact-runtime 0.16.0
- compact-js 2.5.1, midnight-js-* 4.1.1, onchain-runtime-v3 3.0.0
- ledger-v8 8.1.0 (note: wallet-sdk-dust-wallet 4.1.0 requires 8.1.0's
  `Transaction.addIntent`; forcing ledger-v8 8.0.3 breaks the wallet SDK)
- proof-server: tried **8.0.3, 8.1.0, and `:latest` (=8.1.0)** — all reject
- Also tried the public `proof-server.preprod.midnight.network` (reports 8.0.3) — rejects

### Repro
Circuit `register_asset(symbol: Bytes<32>, underlying_color: Bytes<32>,
market_address: Bytes<32>, snight_color: Bytes<32>, decimals: Uint<64>, enabled: Boolean)`
on a small owner-gated registry contract (Map<Bytes<32>, struct> insert + `require_owner`
that hashes a `local_secret_key()` witness to a stored owner id). Call it via
`findDeployedContract(...).callTx.register_asset(...)`.

### What we decoded (proof is client-side/format, not truncation)
The `/check` request body is **461 bytes and STRUCTURALLY COMPLETE** — decoding shows the
type tag `midnight:(proof-preimage-versioned,option(wrapped-ir)):` followed by all 6
circuit args, the witness value, the derived owner id, and the ascii circuit id
`register_asset`. It is NOT empty/truncated. The proof-server's `/check` deserializer
rejects this wrapped-ir wire format.

### Isolation evidence
- **Deploy `/prove` works** (no witness path / different endpoint).
- **A different callTx, `create_market` on another contract, succeeds** via the same
  `httpClientProofProvider` → same local proof-server — so it's not a blanket
  httpClientProofProvider failure; it's **per-circuit**, correlating with which
  reworked-ZKIR ops the circuit uses.
- **Wallet-delegated proving works** (Lace uses a different prover backend), confirming
  the request encoding is fine and the local proof-server simply can't parse the new ZKIR.
- Bisect attempt: widening the circuit's `decimals` from `Uint<8>` to `Uint<64>` (to drop
  the Uint-downcast rework), recompiling and redeploying, **did NOT fix it** — so at least
  one more reworked op (byte-vector↔Field/Uint conversion or relational comparison in the
  owner-hash / struct insert path) is also unparseable by 8.0.x `/check`.

### Ask
1. Which proof-server version parses the Compact 0.31.0 ZKIR on the `/check` wrapped-ir
   path, and is there a publicly reachable prover image/endpoint with it today? (The
   `lace-proof-pub.preprod.midnight.network` host referenced in support does not resolve
   via public DNS.)
2. Timeline for the proof-server release that the 0.31.0 notes say will carry the
   ZKIR-format fix.
3. Interim: exact list of 0.31 reworked ops to avoid so a circuit stays provable on
   proof-server 8.0.3 via `httpClientProofProvider`.

---

## 2) Support/Discord follow-up draft

> Update on the /check "bad input" issue — your root-cause call was right (0.31 ZKIR
> rework, proof-server /check can't parse it), and we've now confirmed the details:
>
> 1. **The `decimals Uint<8>` bisect did NOT fully fix it.** We widened `decimals` to
>    `Uint<64>`, recompiled, redeployed the registry, and re-ran — still `400 bad input`
>    at /check. So there's a **second reworked-op trigger** in `register_asset` beyond the
>    Uint downcast (the circuit also has an owner-hash `persistentHash(local_secret_key)`
>    and a `Map<Bytes<32>, struct-with-Boolean>` insert). Note `create_market` uses the
>    same `require_owner` hash and DOES prove fine — so the remaining trigger is something
>    register_asset has that create_market doesn't (the Boolean field / struct shape?).
>
> 2. **We can't reach the working prover you mentioned.** `lace-proof-pub.preprod.midnight.network`
>    does not resolve (no record via 8.8.8.8/1.1.1.1). The public
>    `proof-server.preprod.midnight.network` is 8.0.3 and rejects the same way. Local
>    docker `proof-server:8.0.3`, `:8.1.0`, and `:latest` (=8.1.0) all reject.
>
> 3. **Wallet-delegated proving (Lace) works**, so our browser DApp is unaffected — only
>    our headless admin/keeper scripts (which use `httpClientProofProvider` → local
>    proof-server) are blocked, since the headless `wallet-sdk-facade` has no
>    `getProvingProvider`.
>
> Could you share either (a) a reachable prover endpoint/image that parses the 0.31 ZKIR,
> or (b) the ETA for the proof-server release with the fix, or (c) the precise set of 0.31
> reworked ops to avoid so we can keep the circuit provable on 8.0.3?
>
> Separately: the matrix lists **ledger-v8 8.0.3**, but our **wallet-sdk-dust-wallet 4.1.0
> needs `Transaction.addIntent`, which only exists in ledger-v8 8.1.0** — pinning 8.0.3
> breaks the wallet SDK at deploy (`Transaction.fromParts(...).addIntent is not a
> function`). What is the coherent wallet-sdk package set for the ledger-v8 8.0.3 row?
