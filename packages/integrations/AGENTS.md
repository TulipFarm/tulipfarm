# Integrations — Agent Conventions

`@tulipfarm/integrations` — internal integration adapter contracts, event normalization,
delivery, source ACL adapters, sync checkpoints, and identity mapping. tsconfig extends
`@tulipfarm/tsconfig/base.json`. See root `AGENTS.md` for commands/lint.

## Layout

- `src/http.ts` — provider-neutral `IntegrationHttpPort` plus `classifyHttpFailure` (the one place
  an HTTP status becomes a `before_dispatch`/`after_dispatch` durability decision) and bounded
  `collectPages` (throws `PaginationBoundError` rather than silently truncating a paged read).
- `src/grants.ts` — AccessGrant evaluation for external targets: default-deny intersection of
  Integration, principal, action, and concrete external target.
- `src/egress/` — the generic runtime that turns an Integration manifest's `egress` block into
  agent Tools, so a provider needs no code here at all. `openapi-compile.ts` compiles a spec plus
  the manifest's `operations` allowlist into `ToolContractSpec`s (pure; resolves every `$ref`,
  because a survivor throws inside `ajv.compile` at registration and takes down *other*
  integrations' Tools); `openapi-adapter.ts` executes one compiled operation. Prefer extending this
  over adding another `src/<provider>/` directory — those exist for providers the declarative layer
  cannot yet express. Authoring reference:
  [`docs/architecture/building-an-integration.md`](../../docs/architecture/building-an-integration.md).
- `src/github/` — installation scope + identity resolution (`scope.ts`), published ToolContracts
  (`contracts.ts`), signed-webhook normalization (`events.ts`), and the `GitHubAdapter`
  (`adapter.ts`) implementing the broker's dispatch and reconciliation ports.
- `src/jira/` — site/project scope + identity resolution (`scope.ts`), published ToolContracts
  (`contracts.ts`), and the `JiraAdapter` (`adapter.ts`). Jira has no provider idempotency key, so
  creates carry a `tulipfarm-effect-<hash>` label and every mutation reads state before writing.
- `src/knowledge/` — the provider-neutral Knowledge emission contract (`KnowledgeSourceEmission`,
  `KnowledgeChunkEmission`, `KnowledgeEmissionSink`, `KnowledgeIdentityMapPort`). This package may
  not import `@tulipfarm/knowledge`, so these shapes mirror the store's records; `apps/worker` owns
  the conformance test that keeps them from drifting.
- `src/google-drive/` — Drive change-feed sync into Knowledge: per-file permissions become the ACL,
  unreadable permissions emit `unverifiable`, sensitive classifications use live authorization, and
  checkpoints advance only after a change is fully committed.
- `src/google-docs/` — Google Docs sync into Knowledge: Drive permissions become the snapshot ACL,
  link-sharing grants no principal, domain-sharing grants only through explicit identity mappings,
  and unreadable permissions remove content.
- `src/notion/` — Notion page sync into Knowledge: pages require a verifiable reader set (for
  example an admin-managed People/email property); missing ACL data emits `unverifiable`.
- `src/confluence/` — Confluence page sync into Knowledge: effective page readers are captured as
  mapped Confluence account ACLs, unreadable permissions remove content, stale ACLs are revalidated,
  and checkpoints advance only after a page change fully commits.
- `src/slack/knowledge/` — Slack channels as sources and messages as chunks. Non-public channels are
  restricted + live-authorized; archived channels are revoked and their content removed; deleted
  messages remove their chunk; one failing channel never stalls the others.

Concrete transports live in `apps/integration-worker` (e.g. `src/github/http.ts`), never here.

May import: `@tulipfarm/schema`, `@tulipfarm/authz`, `@tulipfarm/audit`,
`@tulipfarm/tool-broker`, `@tulipfarm/storage`, `@tulipfarm/observability`, `@tulipfarm/soul`
(`src/egress/` only, for the manifest authoring types — `@tulipfarm/soul` does not import this
package, so there is no cycle). See
[`docs/architecture/dependency-rules.md`](../../docs/architecture/dependency-rules.md). This
package implements the Tool adapter interface owned by `@tulipfarm/tool-broker`; the broker never
imports Integration implementations. Integration events must resolve the external principal —
never borrow a Conversation owner's identity.
