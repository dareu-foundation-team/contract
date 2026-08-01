# DareU contract tests

The active suite covers only the direct-resolution V2 protocol and its shared
operational infrastructure. There is no V1 compatibility suite.

```bash
npm run build
npm test
npm run typecheck
```

V2 circuit coverage is documented in [v2/README.md](v2/README.md). The root
suite also verifies Keeper reliability and ZK asset preflight behavior.
