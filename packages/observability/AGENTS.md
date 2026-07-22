# Observability — Agent Conventions

`@tulipfarm/observability` — OTel conventions, metrics, health/readiness, correlation and
redaction helpers. **Scaffold today:** `src/index.ts` is `export {}`. tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

This is a foundation package: it imports no other TulipFarm runtime package (see
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md)).
