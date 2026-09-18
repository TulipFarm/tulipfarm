# MCP Knowledge host

Durable explicit source selections, fenced publication, and fresh viewer access for MCP Knowledge.

## Read on / Skip
- **Read on** for selected-source HTTP controls, source-backed Pages, account lifecycle cleanup,
  or the integration-worker's internal sync callback.
- **Skip** for MCP transport and credentials; those belong to `packages/mcp` and Integration accounts.

## Map
| Path | Owns |
| --- | --- |
| `compose.ts` | Persistent selection/jobs, account-scoped reads, source-backed publication, and live gate bridge. |
| `routes.ts` | Exact-account public controls, per-Page source status, and authenticated worker callback. |
| `page-gate.ts` | Source-aware Page read/edit adapter and actual-user live authorization bridge. |
| `compose.pg.test.ts` | Real persistence/publication and owner-only uncached read contract. |
| `worker-routes.test.ts` | Worker authentication and trusted reader checks around each live source read. |

## Rules
- The integration-worker drives cycles; never start a timer or queue consumer in the API.
- `McpKnowledgeAccountHost` checks local authoritative account/configuration state and uses scoped
  SDK reads. Never use an Agent Tool effect cache or retain provider output in its ledger.
- `bindingFor` returns absent only for confirmed local ineligibility; transient failures throw.
- `captureIdentity` reads the provider identity for an explicit selection write. `contextFor`
  reconstructs trusted `knowledge_sync` authority from that selection, never from a Chat fiction.
- Every publication/checkpoint write uses the selection revision and worker lease. Hide and mark
  cleanup pending before replacement so failed erasure remains durable and unreadable.
- Synced Pages never pass through authored-page writers or blanket grants.
- Worker Page checks resolve the effective user from a running Run before and after the fresh read.
  A claimed reader must match that user; the selected source's owner is never a substitute.
- The worker registrar requires a root-injected `McpKnowledgeRunReaderResolver` that validates
  current Run authority and caller lineage; service authentication alone does not establish a reader.
  Shared or unknown native audiences must deny even without delivery correlation. Agent-subject
  Runs remain denied until original-reader propagation is explicitly supported.

See [`packages/knowledge/src/mcp/README.md`](../../../../../packages/knowledge/src/mcp/README.md).
