# Integrations (`@tulipfarm/integrations`)

Owns adapter contracts, event normalization, source ACLs, sync checkpoints, and identity mapping.

## Read on / Skip

- **Read on if** you touch MCP setup, native channels, events, identities, or Knowledge sync.
- **Skip if** you touch concrete HTTP workers or retry daemons; use
  [`../../apps/integration-worker/AGENTS.md`](../../apps/integration-worker/AGENTS.md).

## Map

| Path | Owns |
| --- | --- |
| `src/auth/` | Provider-neutral public origins and callback URLs; initialized hosted context locks environment origins over persisted overrides. |
| `src/mcp/` | Server configuration, reviewed capabilities, account-access ports, governed Tool contracts, and DNS-pinned streaming HTTP transport. |
| `src/accounts/` | Exact MCP account authority, lifecycle, browser OAuth, refresh and revocation. |
| `src/http.ts` | Provider-neutral HTTP port, failure classification, bounded pagination. |
| `src/grants.ts` | Default-deny grants for concrete external targets. |
| `src/egress/` | Fetch transport, destination cage, governed HTTP requests and HTML-to-Markdown rendering. |
| `src/git-source/` | Pre-clone Git source cage and the bounded, sanitised clone helper. |
| `src/retry-after.ts` | Provider Retry-After parsing bounded by the durable-wait limit. |
| `src/ingress/` | Fixed native Slack/GitHub signature verification and atomic Routine admission. |
| `src/github/` | Native GitHub events, channel routing and replies, plus App credentials and scope contracts; no business Tool catalog. |
| `src/slack/` | Native Slack events, channel admission, replies, Markdown, mentions and emoji; no business Tool catalog. |
| `src/knowledge/` | Provider-neutral Knowledge emission and identity-map contracts. |
| `src/channels/`, `src/model/` | Shared native channel ports, security and routing. |

## Rules

- Concrete transports live in `apps/integration-worker`; the broker must not import impls.
- Slack `chat.postMessage` has no guaranteed idempotency key: reconcile uncertain writes against
  the authenticated bot's message metadata; only confirmed receipts or safe retries advance delivery.
- Third-party Agent Tools use MCP; native channel delivery is not an alternate Tool catalog.
- Validate destinations through `assertPublicEgressUrl`, send through
  `GuardedEgressHttp`. Neither subsumes the other — a public name can hold an inward A record.
- `GuardedEgressHttp` passes validated DNS answers to `FetchEgressHttp`, which pins the connection;
  never re-resolve a checked hostname at the socket.
- Every caller-supplied Git source clones through `withGitSourceClone`; never spawn `git` directly
  and never surface its stderr. `GIT_SOURCE_ALLOWED_HOSTS` widens the host allowlist;
  `GIT_SOURCE_ALLOW_LOCAL_PATHS=1` (fixtures only) re-enables `file://`.
- `web-content.ts` strips concealed markup with `addRule`, never `turndown.remove()`: turndown
  matches its built-in rules first, so `remove()` never fires for an element it can already render
  and a `<p hidden>` would reach the prompt. Unhardened turndown also emits `<script>`/`<style>`
  text verbatim.
- `collectPages` must throw `PaginationBoundError` rather than silently truncate a paged read.
- A provider continuation at a pagination ceiling fails; never return it as a complete last page.
- Integration events must resolve external principals; never borrow Conversation owner identity.
- Knowledge sync: preserve ACLs, explicit domain identity mappings, live-authorize sensitive data.
- Snapshot ACL and deletion reads consume all continuation pages within `maxPagesPerRun`; an incomplete read fails closed rather than publishing a partial ACL or completing deletion checkpoints.
- Unreadable/unverifiable permissions remove or suppress content; never leak it.
- Advance checkpoints only after full commit; one source failure must not stall others.
- This package may not import `@tulipfarm/knowledge`; `src/knowledge/` mirrors store records.
- Protocol behavior belongs to `@tulipfarm/mcp`; never add a parallel provider executor.
- The barrel lists every export by name; `scripts/barrel-exports.test.ts` fails the build on a new
  `export *`. Adapters reach the effect plane, so what this package publishes is a security surface,
  not just an API.
- [Dependency rules](../../docs/architecture/dependency-rules.md)
