# Audit (`@tulipfarm/audit`)

Canonical audit events, hash chaining, sealing, export, retention, legal hold, erasure, and
lineage. Owns append-only, hash-linked evidence.

## Read on / Skip

- **Read on if** you touch audit records, chain verification, segment sealing/export, or retention.
- **Skip if** you need permission decisions (`../authz/AGENTS.md`) or DB repos
  (`../storage/AGENTS.md`).

## Map

| Path | Owns |
| --- | --- |
| `src/event.ts` | Audit event shape and input normalization. |
| `src/writer.ts` | Append-only writer behavior. |
| `src/chain.ts`, `src/verify.ts` | Event hash computation and chain verification. |
| `src/seal.ts`, `src/export.ts` | Segment sealing and export bundle verification. |
| `src/retention.ts`, `src/legal-hold.ts`, `src/erase.ts` | Retention, holds, and erasure. |
| `src/storage.ts` | Audit event repository contract and in-memory test repo. |

## Rules

- May import `@tulipfarm/schema`, `@tulipfarm/storage`, and `@tulipfarm/observability`; see
  [`dependency-rules.md`](../../docs/architecture/dependency-rules.md).
- No other package writes audit records directly.
