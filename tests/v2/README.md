# DareU V2 Tests

These tests execute the generated Compact circuits locally without a node,
Indexer or proof server.

```bash
npm run build:v2
node --import tsx --test "tests/v2/**/*.test.ts"
```

Coverage includes:

- mandatory explicit operator and owner-only rotation/revocation;
- owner/operator/oracle/stranger permission matrix;
- one-step resolution after close, invalid outcome, replay and empty-winner guards;
- terminal cancellation and refunds;
- shielded deposit/withdraw and bet coin validation;
- ticket, payout binding and double-claim gates;
- parimutuel floor arithmetic and per-market fee accounting;
- multi-market solvency, fee sweep and lost-ticket surplus.

The simulator validates circuit assertions, ledger writes and declared token
effects. Real wallet balancing, ZK proving, DUST, Indexer finality and ciphertext
delivery still require a preprod end-to-end test.
