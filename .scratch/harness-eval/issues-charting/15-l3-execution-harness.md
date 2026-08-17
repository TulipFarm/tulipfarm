# Build the L3 execution harness

Type: task
Status: open
Blocked by: 02, 07

## Question

Build the bridge: one process that submits a chat message, executes the resulting Run to
completion, and reads back what the agent actually built.

[Establish headless Run execution for the L3 tier](05-l3-headless-execution.md) resolved the
feasibility question and priced this at ~3-6 engineer-days, 10-60s per journey. The map owner
accepted that cost — L3 is the only tier that measures the product promise. This ticket spends it.

The research already found the pieces; the work is assembling them.

**Database.** Use `makeMigratedPglite()` (`apps/api/src/test/pglite.ts:9-33`), which runs
`runPgMigrations()` (`apps/api/src/pg-migrate.ts:38-187`) against in-process PGlite and snapshots
the result. No Docker, no external Postgres. pgvector is required and PGlite loads it. For a
socket-backed variant see `apps/worker/test/process/scratch-database.ts:35-66`.

**The port bill.** `createChatExecutor` (`apps/worker/src/turn/chat-executor.ts:67-156`) needs
`host` (`ChatExecutorHost & TurnCompletionStore & ToolDispatchPort`), `tools`, `context`, `runs`,
`events`, `budgets`, `transitions`, `waits`, `checkpoints`, `model`, `log`, `spend`, `now`.
Reusable fakes exist only for checkpoints (`packages/agent-runtime/src/loop/checkpoint.ts:27`) and
waits (`packages/storage/src/runs/memory-wait-store.ts:21`). Existing tests use **inline** stubs
(`apps/worker/src/turn/chat-executor.test.ts:79-120`). Expect ~6-8 fakes or wrappers.

Prefer **real** DB-backed implementations over fakes wherever one exists — a fake store that
diverges from the real one turns L3 into an expensive L2. Fake only the model (pinned, per
[Pin an exact model for a whole eval run](03-pin-an-exact-model.md)) and anything genuinely
external.

**Driving turns.** `chatConversationService(...).startTurn(...)`
(`apps/api/src/conversations/chat-turns.ts:24-57`) is the entry point for both the first and
subsequent messages; skip HTTP. pg-boss is **not** needed for a single turn — the executor is
synchronous. But durable waits, timers and retries need either direct store writes or the sweep
loop (`apps/worker/src/main.ts:472-480`, `packages/run-kernel/src/waits.ts:149-188`). Decide which,
and make turn completion deterministically detectable rather than polled with a sleep.

**Soul writes need real git.** Authored-tree writes go only through `SoulWriter.apply()`
(`apps/api/src/runtime/soul-writer.ts:1-36`), which composes commit/publish/push/reload. The
fixture must be a real git repo. Decide what "push" means with no remote.

**Reading back state.** Three paths to build: the Soul tree on disk, Postgres tables
(`conversation_turns`, `runs`, `artifacts`, resource tables), and Run events. See
`apps/api/src/chat/durable-submission.pg.test.ts:92-410` for how the existing test asserts across
several of these.

**Isolation.** Each journey needs a clean database and a clean Soul repo, or journeys contaminate
each other and a failure becomes unattributable. Decide how teardown works and whether journeys
can run concurrently at all.

Deliver the harness plus one trivial end-to-end journey proving the whole path works, before
anyone authors a real corpus against it.
