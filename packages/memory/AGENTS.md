# Memory (`@tulipfarm/memory`)
A user's memory is **one Markdown page** — `user_memory.document` — injected whole into every turn.
There is no key/value store, no assertion engine, no relevance recall: the model always sees all of
it.

## Read on / Skip
- **Read on if** you touch the Memory Document — sections, deltas, budgets, revisions, hashing,
  rendering, or the `update_memory` Tool.
- **Skip if** you touch Knowledge retrieval, prompt assembly, storage repositories, or authz.

## Map
| Path | Owns |
| --- | --- |
| `src/document/sections.ts` | Char budgets and the `## Recent decisions` cap. The section vocabulary itself is `@tulipfarm/schema`'s, because memory, curator and api all have to agree on it. |
| `src/document/document.ts` | Grammar, canonicalization, deltas, section replacement, hashing, render + its inverse parser. Pure. |
| `src/document/store.ts` | Every line of SQL in the package. `user_memory.document` holds the rendered page itself, so `psql` shows the bytes the model got; `parseMemoryDocument` inverts the render, losslessly *only* because of the no-heading rule below. |
| `src/document/tool.ts` | `update_memory` — the sole model-facing write. |
| `src/telemetry.ts` | Redaction-safe metric/span names and helpers. |
| `src/limits.ts` | Turn-loop bounds (`MAX_TOOL_STEPS`, history/retention token budgets). |

## Rules
- May import only `@tulipfarm/schema`, `authz`, `audit`, `storage`, `observability` — see
  [dependency rules](../../docs/architecture/dependency-rules.md). Anything needing `constants` or
  `agent-runtime` stays in `apps/api/src/memory`.
- **A Tool may only apply a delta.** `applyDelta` touches only entries the caller named, so it
  cannot destroy a concurrent writer's line, and no version or hash exists to get wrong.
  `replaceSection` overwrites, so it demands the current section hash and a writer type excluding
  `"tool"` — a DB CHECK enforces that again, because a caller-supplied `writer` is not evidence.
- `canonicalMemoryLine` is the one canonicalization rule — dedupe, removal matching, hashing and
  render all use it. A second lets a fact be "present" for an add and "absent" for a remove.
- One fact per line, no heading at any level inside a section: removal matches whole entries, so a
  multi-line fact could be half-deleted into a different, false statement. Enforced at storage
  time, not only at render, so no writer can forge or split a section.
- An over-budget mutation is **rejected** and the previous document survives — never truncated,
  because a silent truncation loses a fact the user was told was remembered.
- Telemetry labels/attributes are bounded enums or counts only — never document text, section
  content, or any principal/business/conversation/Run id.
