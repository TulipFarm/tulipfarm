# MCP Knowledge source contract

Knowledge owns copying and serving rules. Protocol execution and account authority are injected
ports, not reimplemented here. `createMcpKnowledgeLiveAccess` feeds the existing
`decideKnowledgeAccess` gate. It is not an alternative permission evaluator.

## Supported adapter

`github-file` accepts explicit `.md` and `.txt` files on an explicit `refs/heads/...` branch,
using a **personal account, visible only to that account's owner**. It supports the
source-reviewed **isolated local official GitHub MCP server**, revision
`85598ba6e1256f7ebf4867b95d63b833c4549264`. The host must verify the actual deployed build,
not trust a server's self-reported name or a user-supplied revision string. Hosted GitHub,
custom servers, other builds and shared-account sync are not covered by this contract.

The Integrations catalog exposes **Set up GitHub Knowledge (local)** beside the remote GitHub
option. The image/revision and server seed come from the pure shared
`@tulipfarm/schema` profile (`src/mcp-knowledge-profile.ts`); Knowledge re-exports the same constants.
The preset starts disabled, uses personal token accounts and grants no capability approval.
After account setup, an admin must explicitly review `get_me` and `get_file_contents` as
non-mutating Tools without per-call approval and enable the server before selecting files.

The reviewed commit is the official release
[`v1.12.2`](https://github.com/github/github-mcp-server/releases/tag/v1.12.2).
Public GHCR metadata retrieved on 2026-09-18 maps that release to
`ghcr.io/github/github-mcp-server@sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6`
(`GITHUB_KNOWLEDGE_IMAGE`). Both the Linux amd64 and arm64 image configurations declare
the reviewed source revision, publisher source URL, version `1.12.2`, entrypoint
`/server/github-mcp-server`, and command `stdio`. Their manifest and configuration byte
digests were checked. The public
[publication workflow](https://github.com/github/github-mcp-server/blob/85598ba6e1256f7ebf4867b95d63b833c4549264/.github/workflows/docker-publish.yml)
publishes these tags and signs the image digest. This investigation did **not** run the
image or independently verify its Cosign signature. The host must bind eligibility to
the actual pinned image and approved server configuration; a matching text field in
`serverInfo` or an unrelated image's label is not evidence.

Every sync and every content use calls `get_me`, matches the numeric provider user ID to
the selected account, then calls `get_file_contents` for that exact selected file. The
host must execute both calls under the same exact account/configuration, recheck current
authority before each call, bound response bytes, honor aborts, and never reuse a cached
Tool result. A current successful file read supplies the owner's permission evidence;
an account-use grant or a cached ACL does not.

Only the exact official text/empty-file success response and the exact requested path
in its embedded commit URI are accepted. Fuzzy path matches, fallback branches,
symlinks, directories, binary data, linked downloads and truncated/oversized results
are refused. No provider HTTP call or download URL is followed by TulipFarm's adapter.

Limits: 1,000 explicitly selected files, 20 files per batch, 256 KiB UTF-8 per file;
60-second default batch budget and 30-second live-read budget. A checkpoint advances
only after durable source/chunk publication, or a recorded failed read. `complete`
means all selected files were attempted, not all succeeded: inspect `failed` and
`failures`. A partial scan never proves deletion. This adapter performs no directory
inventory, search-based discovery or bulk repository export.

Refresh defaults to 15 minutes and permits configured intervals from one minute to 24 hours.
The worker's durable `requestSync` port supports explicit Sync now and notification
acceleration; notifications never substitute for polling. Progress and errors must be
shown through the host's persisted job state, not authored Knowledge pages.

## Host obligations

- Persist the exact selection, revision, account binding, source locator, checkpoints,
  leased worker jobs, last successful sync and safe failure codes. `assertCurrent` and
  live `open` must deny disabled/removed sources and changed/revoked/disconnected accounts.
  Account revision is separate from server configuration revision. Fence source, sink
  and checkpoint writes against the current selection and worker lease, not just job
  completion; per-job port facades can bind the opaque lease without exposing it to MCP.
- Publish through source-backed, **read-only** Knowledge pages. Display
  `sourceLocator.sourceUrl`, `lastSyncedAt`, and `mcpKnowledgeFreshness().stale`
  (pass persisted refresh failure state so even an early failed manual refresh shows stale).
  Do not use the authored-page creation path or copy external content into unrestricted notes.
- Inject the live bridge on retrieval, direct page reads and citation reauthorization.
  A different reader, exact-account mismatch, missing port, malformed source, failed
  live read or content older than 24 hours denies. Up to 24-hour-old content is usable
  **only** after a new successful permission read, with a stale notice.
  The live source's `maximumAgeSeconds` is 24 hours for the existing stale-source
  invalidation sweep, not an authorization cache TTL. The gate calls the live port
  on every use regardless of that field.
- Complete existing Knowledge invalidation before publishing replacement chunks.
  If purge fails, persist pending invalidation, fail publication and leave the source
  hidden. Purge source text, indexes, caches and derived summaries, not independent notes.
- On disconnect, selection removal or confirmed sync-account source loss, first make
  authority checks deny immediately, then durably schedule `removeMcpKnowledgeSource`.
  Its source tombstone precedes purge; failed cleanup must be retried. Never treat one
  shared reader's refusal as global loss (shared sync is currently unsupported).

Durable selections, requested generations, expiring leases, checkpoints and cleanup links live in
`McpKnowledgeStore`. The integration-worker's `composeMcpKnowledgeSyncLoop` claims and finishes jobs,
calling `POST /api/v1/internal/mcp-knowledge/reconcile` and `POST .../batch` for API-hosted
account credentials and transactional Knowledge repositories. The API only accepts an already-leased
batch; it hosts no polling timer or queue consumer. A newer Sync now generation remains due after an older batch finishes.
Pending cleanup blocks new publication, survives process reconstruction and is retried transactionally.

`McpKnowledgePublication` publishes placed `source: "mcp"` Pages, their normal Page index and
source index. It never creates authored notes or blanket grants. Replacements invalidate Page and
Source GraphRAG provenance before publishing. Erasure removes text, chunks, revisions, links and
derived summaries while retaining source tombstones and independent notes.

The exact-account controls are `GET/PUT/DELETE
/api/v1/integrations/:key/accounts/:accountId/knowledge` and `POST .../knowledge/sync`.
`GET /api/v1/knowledge/pages/:pageId/source` returns live-gated attribution and freshness.
The authorized `/api/v1/knowledge/pages/mentions` listing carries persisted Page `source`, so
trees can withhold move and child-authoring controls for `source: "mcp"`.
Selections and progress are operational state, never authored Pages.

The Worker's local Knowledge Tool gate calls the service-only
`POST /api/v1/internal/mcp-knowledge/page-access` for each MCP Page use. The API reloads the
running Run before and after the fresh source check, and the claimed reader must match its
effective user. Missing callbacks, unavailable checks and non-user Runs deny; no source-owner
identity is substituted. Authored Pages retain their normal local gate.

The account host must provide governed **uncached** reads through its scoped `open` callback,
checking the actual personal reader, reviewed nonmutating capability, current selection and
account/configuration before each SDK call. The Agent Tool dispatcher is not this path:
confirmed effect output is not fresh permission evidence, and storing raw source text in its
ledger would escape Knowledge's purge lifecycle. Audit only safe operation metadata.
The in-memory fixtures in tests are not production storage. Library coverage alone is not a claim
that root wiring or a deployed server has been verified.

## Public evidence and unsupported claims

Reviewed 2026-09-18, public documentation/source only; no private account was called.

- [GitHub get_me](https://github.com/github/github-mcp-server/blob/85598ba6e1256f7ebf4867b95d63b833c4549264/pkg/github/context_tools.go):
  calls `Users.Get` for the authenticated user each time.
- [GitHub get_file_contents](https://github.com/github/github-mcp-server/blob/85598ba6e1256f7ebf4867b95d63b833c4549264/pkg/github/repositories.go):
  obtains repository contents on each call, emits a SHA plus embedded text, but can fall
  back to another branch or fuzzy path and emits links for files of at least 1 MiB.
  The adapter rejects those alternate response forms.
- [GitHub errors](https://github.com/github/github-mcp-server/blob/85598ba6e1256f7ebf4867b95d63b833c4549264/pkg/errors/error.go):
  Tool errors do not expose a reliable structured downstream HTTP status. They are
  **unavailable**, not a deletion proof. In particular, 404 can conceal private content;
  transient failures retain the last copy but never bypass live access checks. Confirmed
  lifecycle loss must arrive from the host's account/selection authority or another
  separately reviewed source-loss signal, not parsed error prose.
- [Google's first-party Drive MCP](https://developers.google.com/workspace/drive/api/guides/configure-mcp-server)
  documents `read_file_content`, `get_file_metadata`, `get_file_permissions` and user
  permission inheritance. The reviewed page does not establish exact output,
  truncation, complete reader mapping or cache freshness sufficient for this adapter.
  Third-party Drive MCP documentation is not evidence for Google's server. **Not enabled.**
- [Notion's first-party tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)
  document `notion-fetch` with `self` for user/workspace identity, page fetches and
  `truncated`/`unknown_block_ids` for incomplete content. Its connected-app search results
  cannot be fetched with `notion-fetch`. The reviewed contract does not prove fresh
  per-reader access or complete shared ACLs. **Not enabled.**
- Shared sync needs an admin-managed explicit sync grant **and** independently proven
  current per-reader source access. None of these docs proves shared sync for this
  implementation. `unsupported_shared_sync` is deliberate, not an empty ACL fallback.
- Slack Knowledge sync is excluded. MCP resources, prompts, discovery lists and
  read-only annotations do not establish permission to persist or share content.
