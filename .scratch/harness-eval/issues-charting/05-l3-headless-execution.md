# Establish headless Run execution for the L3 tier

Type: research
Status: resolved
Blocked by: —

## Question

Is the L3 tier actually feasible, and what exactly does it cost to run one multi-turn journey
end to end with no worker and no pg-boss?

This is the riskiest unknown on the map. L2 is nearly free — `AgentLoop` runs in-process with
injected ports and `test/security/harness.ts` is most of a runner already. L3 is not: it needs
real Postgres, a fixture Soul, a real Conversation with Turns, real Records, and an assertion on
resulting **state** ("a Resource type now exists with these fields"). If L3 turns out to need most
of `apps/worker` composed by hand, the tier may not be worth its price — and this map needs to
know that before anyone authors a journey.

Charting established that `createChatExecutor()` (`apps/worker/src/turn/chat-executor.ts`) and
`createRoutineExecutor()` (`apps/worker/src/routine/executor.ts`) are plain functions callable
in-process if you supply their ports. That is the thread to pull.

Answer, concretely and skeptically:

1. **The port bill.** Enumerate *every* port `createChatExecutor` needs, and for each say whether a
   real implementation, an in-memory fake, or nothing exists. Charting found fakes for artifacts,
   waits and soul publication, and **none** for secrets, blob or vector. Confirm and complete that
   list. Give a realistic count of how many must be written from scratch.
2. **Postgres.** Which of these ports genuinely require a live Postgres, and can migrations be run
   against a throwaway database from a test process? Migrations live in
   `apps/api/src/pg-migrations/` and run on boot — is there a programmatic entry point, or is
   booting the API the only way? Does pgvector have to be present?
3. **pg-boss.** Chat turns are durable Runs. Does driving a turn to completion require the pg-boss
   queue to actually cycle, or can the executor be stepped synchronously? If waits and timers are
   involved, say how a test process advances them.
4. **Multi-turn.** How does a second user message enter an existing Conversation without the API?
   Name the entry point.
5. **Asserting on state.** After a journey, how does the eval read what was built — the Soul
   fixture directory on disk (did the agent write files?), the Records tables, Run events? Name the
   read paths. Note the Soul is git-backed: does a headless run need a real git repo, and does it
   commit?
6. **Existing precedent.** Does *any* current test drive a full turn against real Postgres? Look in
   `apps/api/test`, `apps/worker/test` (especially `test/process/**`, which charting noted spawns a
   real worker), and `packages/testkit`. If something close exists, that is the starting point and
   this ticket's answer should say so loudly.
7. **The verdict.** Estimate the build cost in honest terms — days, not adjectives — and the
   per-journey wall-clock. Then say plainly whether L3 is worth it, or whether the map should
   reconsider. A clear "this tier is not worth its price" is a perfectly good answer.

Read `apps/worker/AGENTS.md`, `packages/run-kernel/AGENTS.md`, `packages/storage/AGENTS.md`,
`packages/soul/AGENTS.md`, and `apps/api/AGENTS.md`.

## Answer

**L3 is technically feasible but costs ~3-6 engineer-days to build and 10-60s per journey. The
recommendation is to default to L2-only unless cross-process/real-persistence regressions are
specifically what you want to catch.**

Some of it is cheaper than feared, and some is worse.

### Cheaper than expected

- **No Docker Postgres.** `runPgMigrations(q, exit, log, options)` is a plain programmatic call
  (`apps/api/src/pg-migrate.ts:38-187`), and `makeMigratedPglite()`
  (`apps/api/src/test/pglite.ts:9-33`) already runs the full migration set against an in-process
  **PGlite** database and snapshots it. Many `*.pg.test.ts` files use it today. pgvector is needed
  (`CREATE EXTENSION IF NOT EXISTS vector`, `apps/api/src/pg-migrations/index.ts:86`) and PGlite
  loads the vector extension.
- **No pg-boss for a single turn.** `createChatExecutor` is a synchronous in-process function
  (`apps/worker/src/turn/chat-executor.ts:67-156`). The worker's pg-boss consumers
  (`apps/worker/src/job-consumers.ts:67-140`) are not on the path. Durable waits, timers and
  retries *do* need either direct store writes or the sweep loop
  (`apps/worker/src/main.ts:472-480`, `packages/run-kernel/src/waits.ts:149-188`).
- **Multi-turn has a clean entry point.** `chatConversationService(...).startTurn(...)`
  (`apps/api/src/conversations/chat-turns.ts:24-57`). The HTTP route is a thin wrapper over it
  (`apps/api/src/chat/turn-submit.ts:41-56`), so the eval skips HTTP entirely.

### Worse than expected

- **The port bill is ~12.** `createChatExecutor` needs `host` (which is
  `ChatExecutorHost & TurnCompletionStore & ToolDispatchPort`), `tools`, `context`, `runs`,
  `events`, `budgets`, `transitions`, `waits`, `checkpoints`, `model`, `log`, `spend`, `now`.
  Reusable fakes exist for only two — `InMemoryLoopCheckpointStore`
  (`packages/agent-runtime/src/loop/checkpoint.ts:27`) and `MemoryWaitStore`
  (`packages/storage/src/runs/memory-wait-store.ts:21`). Existing tests use **inline stubs**
  (`apps/worker/src/turn/chat-executor.test.ts:79-120`), not reusable ones. That is
  **~6-8 fakes or wrappers to write** for a clean harness.
- **The Soul write path needs real git.** Authored-tree writes go only through `SoulWriter.apply()`
  (`apps/api/src/runtime/soul-writer.ts:1-36`), which composes commit/publish/push/reload. Any
  journey that asserts "the agent built a Resource type" needs a real git repo initialised and
  committed to — that is the product's audit trail, not an optional detail.
- **Assertions span three stores.** Disk Soul tree, Postgres tables (`conversation_turns`,
  `runs`, `artifacts`, resource tables), and Run events. Three read paths to build, not one.

### The precedent, and the actual gap

Two tests come close, and neither closes the loop:

- `apps/api/src/chat/durable-submission.pg.test.ts:92-410` — real `makeMigratedPglite()`, real
  `DurableInvocationGateway`, real `PgConversationStore` / `RunStore` / `ArtifactStore` /
  `RunEventStore`, and it asserts on `conversation_turns`, `runs`, `artifacts` and `run_events`.
  **It does not run the worker.**
- `apps/worker/test/process/worker.test.ts:47-220` — boots a **real worker process** against a
  socket-backed PGlite scratch DB (`apps/worker/test/process/scratch-database.ts:35-66`), asserting
  dispatch, probes, maintenance and lease recovery. **It does not drive a chat submission.**

The missing piece is precisely the bridge between them: API chat submission -> worker execution ->
resulting-state assertion, in one process. That bridge is the 3-6 days.

### Verdict

Build cost ~3-6 engineer-days, hardest part being a reproducible end-to-end environment across
API + worker + PGlite + Soul fixture + deterministic turn completion. Wall-clock 10-60s per
journey, which at 10 journeys x 2 models is 3-20 minutes of run time on top of L2.

**L2 delivers most of the signal at a small fraction of the cost.** L3 earns its price only if the
regressions you fear are specifically in persistence, cross-process handoff, or the Soul git write
path — which are real risks, but they are also the kind of thing integration tests catch without a
real LLM in the loop. Put to the map owner as a scope decision rather than resolved unilaterally.
