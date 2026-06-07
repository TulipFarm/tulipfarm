# memory/ — per-user working memory + platform tools

Durable, **per-user** working memory (MEM-V1-002/003/004): a tiny, always-relevant set of personal
facts the agent reads every turn and writes via two platform tools. Facts are keyed per user
(tenant-wide), so they follow the user across agents. Tenant/business data does **not** belong here
— that is knowledge.

## Layers

- **`working-memory.ts`** — `WorkingMemoryDoc`, the `WorkingMemoryRepo` interface, and
  `MongoWorkingMemoryRepo` (collection `working_memory`). `assertValidEntry` is the hard write-time
  guard. Mirrors `chat/messages.ts`.
- **`service.ts`** — `WorkingMemoryService` owns the write policy: oversize rejection, last-write
  LRU, and the dual cap (≤30 entries **and** ≤~2k total chars; oldest-written evicted first). The
  repo stays a dumb CRUD store.
- **`tool-result.ts`** — the `ToolCallResult` contract (`ok`/`err`). Handlers always resolve, never
  throw, so a bad call is returned to the model for self-correction.
- **`tools.ts`** — `update_memory` / `delete_memory` `PlatformTool` defs: plain JSON Schema +
  LLM-facing guidance + handlers. Exported as `MEMORY_TOOLS`.
- **`ai-toolset.ts`** — `buildMemoryToolSet(ctx)` adapts the tools to the Vercel AI SDK tool loop;
  `execute` closes over the per-request user.

## Caps (`limits.ts`)

`MAX_ENTRIES=30`, `MAX_VALUE_CHARS=1024` (a larger single value is "document-sized" → rejected
toward `create_knowledge_document`), `MAX_TOTAL_CHARS=2048`, `MAX_TOOL_STEPS=25`.

## Wiring

`index.ts` builds `MongoWorkingMemoryRepo` + `WorkingMemoryService` and passes them into `buildApp`,
which threads the service into `registerChatRoutes`. The chat turn (`chat/routes.ts`) binds
`buildMemoryToolSet(ctx)` as `streamText` `tools` and persists tool-call/tool-result steps via
`onStepFinish`. Tools are scoped to the authenticated user (`user._id`).

Schema migration: `migrations/index.ts` v6 creates the unique `{userId,key}` index plus
`{userId,lastWrittenAt}` for per-user LRU listing.

## Out of scope (here)

`<memory>` block injection into the system prompt (CONTEXT-ENGINE), the knowledge tools, and the
broader tool-runtime execution dynamics (parallel-read/sequential-write, result truncation) live
elsewhere. This module is the store + the two write tools.
