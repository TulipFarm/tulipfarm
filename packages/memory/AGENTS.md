# Memory — Agent Conventions

`@tulipfarm/memory` — scoped, versioned memory assertions, confirmations, provenance,
supersession, and expiry. tsconfig extends `@tulipfarm/tsconfig/base.json`. See root `AGENTS.md`
for commands/lint.

## Layout

- `src/scope.ts` — `authorizeMemoryScope`: an identity match against the scope's *owner*, never a
  capability the caller carries. Default-deny for unknown or disabled scopes.
- `src/memory.ts` — the `MemoryAssertion` shape, `rememberMemory`, `forgetMemory`, and
  `commitAssertion`. Edits supersede rather than overwrite; forgetting keeps a tombstone, not text.
- `src/confirm.ts` — inferred statements live here, outside the assertion store, until the scope
  owner confirms. Deny and expiry delete the pending record and persist nothing.
- `src/retrieve.ts` — `recallMemory`: reauthorizes scope *and* Knowledge evidence on every recall
  through `MemoryEvidenceAuthorizationPort` (supplied by the composing app, since this package may
  not import `@tulipfarm/knowledge`). Exclusions are reason counts only.
- `test/security/` — scope × requester × lifecycle × evidence-provider matrices with side-channel
  assertions.

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`, `@tulipfarm/storage`,
`@tulipfarm/observability`. See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). Durable
writes require explicit confirmation; nothing in this package infers or persists unscoped memory.
