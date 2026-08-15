# Memory (`@tulipfarm/memory`)
Scoped, versioned memory assertions, confirmations, provenance, contradiction handling, ranking,
supersession, and expiry.

## Read on / Skip
- **Read on if** you touch memory scopes, explicit confirmation, inferred statements,
  supersession/tombstones, recall ranking, evidence authorization, or memory telemetry.
- **Skip if** you touch Knowledge retrieval (`../knowledge/AGENTS.md`), Agent prompt assembly
  (`../agent-runtime/AGENTS.md`), storage repositories, or authz primitives.

## Map
| Path | Owns |
| --- | --- |
| `src/{scope,memory,confirm}.ts` | Scope auth, assertions, confirmation, tombstones. |
| `src/{retrieve,rank,contradiction}.ts` | Recall, ranking, contradiction handling. |
| `src/{extract,episode}.ts` | Extraction and episode modeling. |
| `src/telemetry.ts` | Redaction-safe metric/span names and helpers. |
| `src/{assertion-view,service,limits}.ts` | Keyed KV view of an Assertion, its write policy, and the caps. |
| `src/embedder.ts` | `MemoryEmbedder` port and the text an assertion is indexed by. |
| `src/pg/` | Postgres `MemoryStore` / `PendingMemoryStore` over `@tulipfarm/storage`'s `Queryable`. |
| `test/security/` | Scope/requester/lifecycle/evidence-provider side-channel matrices. |

## Rules
- May import only `@tulipfarm/schema`, `authz`, `audit`, `storage`, and `observability`; see
  [dependency rules](../../docs/architecture/dependency-rules.md).
- `src/pg/` is the only place that may hold SQL. It takes `Queryable` from `@tulipfarm/storage`
  rather than declaring its own, so the control plane can hand it the pool it already has.
- Anything needing `@tulipfarm/constants` or `agent-runtime` stays in `apps/api/src/memory` — those
  edges are not in this package's allowlist and adding one would be an architecture decision.
- Scope auth matches the scope owner, not a caller capability; unknown or disabled scopes deny.
- Durable writes require explicit confirmation; this package never infers or persists unscoped
  memory.
- Edits supersede instead of overwrite. Forgetting keeps a tombstone, not statement text.
- Denied or expired pending inferred statements are deleted and persist nothing.
- Recall reauthorizes scope and Knowledge evidence every time through an injected
  `MemoryEvidenceAuthorizationPort`; this package must not import `@tulipfarm/knowledge`.
- Telemetry labels/attributes are bounded enums or counts only; never pass statements, subjects,
  entities, queries, principals, businesses, assertions, pending memories, episodes,
  conversations, or Run ids.
