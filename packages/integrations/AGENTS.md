# Integrations (`@tulipfarm/integrations`)

Owns adapter contracts, event normalization, source ACLs, sync checkpoints, and identity mapping.

## Read on / Skip

- **Read on if** you touch adapters, events, identities, egress Tools, Knowledge sync, or imports.
- **Skip if** you touch concrete HTTP workers or retry daemons; use
  [`../../apps/integration-worker/AGENTS.md`](../../apps/integration-worker/AGENTS.md).

## Map

| Path | Owns |
| --- | --- |
| `src/auth/` | Provider-neutral public origins and callback URL resolution. |
| `src/http.ts` | Provider-neutral HTTP port, failure classification, bounded pagination. |
| `src/grants.ts` | Default-deny grants for concrete external targets. |
| `src/egress/` | Manifest-to-ToolContract compiler, adapter, fetch transport, destination cage. `web-content.ts` renders a fetched response to Markdown deterministically via turndown — no model, so the same bytes always give the same text. |
| `src/git-source/` | Pre-clone Git source cage and the bounded, sanitised clone helper. |
| `src/import/`, `src/ingress/`, `src/external-protocol/` | Import and ingress protocols. |
| `src/github/` | GitHub Tool adapters and provider contracts. |
| `src/slack/`, `src/slack/knowledge/` | Slack messaging Tool adapters, contracts, and Knowledge sync. |
| `src/google/` | Google Workspace (Gmail/Drive/Docs/Calendar) Tool adapters and contracts. |
| `src/knowledge/` | Provider-neutral Knowledge emission and identity-map contracts. |
| `src/channels/`, `src/generic/`, `src/model/` | Shared security, adapters, routing. |

## Rules

- Concrete transports live in `apps/integration-worker`; the broker must not import impls.
- Prefer `src/egress/` over `src/<provider>/` when a manifest can express the provider.
- Manifest hosts are chat-authored: compile through `assertPublicEgressUrl`, send through
  `GuardedEgressHttp`. Neither subsumes the other — a public name can hold an inward A record.
- `GuardedEgressHttp` passes validated DNS answers to `FetchEgressHttp`, which pins the connection;
  never re-resolve a checked hostname at the socket.
- `openapi-compile.ts` must resolve every `$ref`; survivors can break unrelated Tool registration.
- Every caller-supplied Git source clones through `withGitSourceClone`; never spawn `git` directly
  and never surface its stderr. `GIT_SOURCE_ALLOWED_HOSTS` widens the host allowlist;
  `GIT_SOURCE_ALLOW_LOCAL_PATHS=1` (fixtures only) re-enables `file://`.
- `web-content.ts` strips concealed markup with `addRule`, never `turndown.remove()`: turndown
  matches its built-in rules first, so `remove()` never fires for an element it can already render
  and a `<p hidden>` would reach the prompt. Unhardened turndown also emits `<script>`/`<style>`
  text verbatim.
- `collectPages` must throw `PaginationBoundError` rather than silently truncate a paged read.
- Integration events must resolve external principals; never borrow Conversation owner identity.
- Knowledge sync: preserve ACLs, explicit domain identity mappings, live-authorize sensitive data.
- Unreadable/unverifiable permissions remove or suppress content; never leak it.
- Advance checkpoints only after full commit; one source failure must not stall others.
- This package may not import `@tulipfarm/knowledge`; `src/knowledge/` mirrors store records.
- `@tulipfarm/soul` is allowed only in `src/egress/` for manifest authoring types.
- The barrel lists every export by name; `scripts/barrel-exports.test.ts` fails the build on a new
  `export *`. Adapters reach the effect plane, so what this package publishes is a security surface,
  not just an API.
- [Building an integration](../../docs/architecture/building-an-integration.md)
- [Dependency rules](../../docs/architecture/dependency-rules.md)
