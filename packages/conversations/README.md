# Private conversation store

This package persists private chats and processes durable model replies in an isolated workspace schema. Authenticated HTTP routes and the persistent browser UI use it. See the [HTTP contract](../../docs/conversation-http-contract.md) and [aggregate acceptance](../../docs/conversation-delivery-evidence.md).

## Implementation map

Entry points inspected on 2 October 2026 at `937f21eb`:

- [`index.ts`](src/index.ts) owns human chat commands and history.
- [`runtime.ts`](src/runtime.ts) owns turn claims, model context, tool execution receipts, and publication.
- [`source-access.ts`](src/source-access.ts) checks retained source permissions.
- [`requests.ts`](src/requests.ts) owns information-request records.
- [`conversation-activities.ts`](../../apps/worker/src/conversation-activities.ts) composes the model responder, provider tools, and credit reservation/settlement.
- [`private-conversations.tsx`](../../apps/web/src/features/chat/private-conversations.tsx) renders the chat and sends REST commands.

The runtime is implemented in this package, not a separate `conversation-runtime`
package. [Verification](../../docs/verification.md) distinguishes service, HTTP,
compiled-worker, and browser tests.

## Domain operations

`createConversations(runtime)` accepts the existing workspace runtime and exposes `create`, `send`, `read`, `history`, `list`, `rename`, and `archive`. Each operation takes a workspace UUID and a server-authenticated user ID. The store resolves current membership under the authorization lock. It requires both the chat's user ID and membership incarnation. Workspace admins have no ownership bypass.

Create takes `{ chatId, commandId }`. Send takes `{ messageId, commandId, parts }`. Human parts accept `{ kind: 'text', text }` and `{ kind: 'attachment', attachmentId }`. Text is stored exactly, including whitespace and ordered part boundaries. Attachment binding requires a ready same-chat upload. Humans cannot submit runtime authors or arbitrary interaction cards.

Since 5 October 2026, send also accepts one `{ kind: 'skill', skillId, revision }` part. `createConversations(runtime, skills)` takes the `ChatSkills` port from [`skill-invocations.ts`](src/skill-invocations.ts), and `@tulipfarm/agents/chat-skills` implements it with the exact-revision rule that agents use. Send rejects a project chat, or a revision the sender cannot use now, with `ConversationConflict('skill-unavailable')` and stores no message. The stored `skill` part keeps the resolved skill name, so history never reads agent tables.

Commands have membership-scoped UUIDs shared across operations. Exact retries return the original outcome after current authorization. Changed input, reused message identity, or a stale title revision conflicts. A removed and rejoined member cannot recover prior chats or command outcomes.

History returns up to 50 messages in ascending sequence, with `nextBefore` for older messages. Lists return 50 chats in descending activity order. The returned cursor preserves PostgreSQL microseconds and uses UUID as a tie breaker. Title search is a literal case-insensitive substring. `%` and `_` are not wildcards. Rename and archive do not change activity order. Archived chats remain readable and accept sends without automatic restoration.

## Migration admission

`workspaceResourceMigrations` composes domain migration streams. The aggregate
composer and each service's transaction admission own the current receipt set and
version bounds. Retry and cancel additionally require the controls migration.

The maintenance worker, production database readiness, packaged smoke checks,
and release gate use that aggregate composer. Applied SQL checksums remain unchanged.

Rollout uses atomic drain-or-refuse. The common runner quiesces in-flight runtime and maintenance transactions under its existing locks, then refuses advancement if preparing authoring or unfinished resource jobs remain. Existing readers, confirmations, and controls continue on the old stream after refusal. Operators must let jobs finish or explicitly reject them, then retry rollout. No approval or cancellation is invented. A persistent authoring pause is not implemented; on a busy workspace rollout may keep refusing rather than invalidate a plan. This chooses safety over guaranteed rollout progress.

Deploy compatible API and ordinary-worker binaries before advancing the common stream with maintenance. Roll back entry points rather than downgrade populated tables or restore binaries that reject the installed stream. Existing production release images and evidence are historical and must be regenerated before deployment. Local acceptance does not establish deployment readiness.

## Reply processing

A successful send commits the message, ordered parts, one queued turn, one ID-only outbox row, command receipt, sequence allocation, title, and activity together. The turn pins the selected model family in `responder`; sends without `model` use `gpt-sol`. Before migration `0030_conversation_models.sql`, turns keep the legacy `reverse-text-v1` responder and the executor replies with `gpt-sol`. Its accepted sequence has a composite foreign key to the source message sequence.

`createConversationExecutor(runtime)` locks authorization and the private root, requires the original membership, and claims only the earliest unfinished turn. A waiting, reconciling, or failed predecessor blocks later replies. A claim increments the epoch and persisted attempt count and receives a 60-second lease. Takeover after lease expiry invalidates old epochs even if their computation finishes later.

The executor calls the injected `ConversationReply` outside the transaction, then
rechecks authorization, head identity, lease, epoch, and generation before publishing.
The worker's [metered reply](../../apps/worker/src/conversation-activities.ts) connects
model routing, tools, source checks, and credit accounting. Inspect that composition
and [model configuration](https://docs.tulipfarm.ai/self-hosting/models/) for supported
families and limits rather than the original deterministic responder behavior.

`createConversationExecutor` takes the same `ChatSkills` port as its last argument.
For a message with a `skill` part, the executor resolves the skill before the model
call and again before publication. If either check fails, the turn fails with
`skill-unavailable` and no reply is published. The model receives the procedure in
one `<system-reminder>` turn after the request. The reply starts with a `skill-use`
part only when the model ran with that procedure.

The executor persists at most five attempts, including abandoned leases. A transient failure releases the lease, advances generation, and schedules exponential delays of 2, 4, 8, and 16 seconds. The fifth failure becomes failed-blocking. Explicit retry/cancel commands require the expected generation and stable command identity. Generic controls refuse waiting and reconciling turns. The deterministic responder has no external effects to reconcile. This retry policy must not be reused for unknown tool effects without domain reconciliation.

Membership removal at claim, source read, or publication marks unfinished work blocked and prevents publication. Rejoining cannot restore its owner incarnation. Archive changes neither queue state nor the archived flag when a reply finishes.

The API's independent conversation dispatcher scans ready workspaces in pages of 100 and discovers up to 50 due head turns per workspace. Unmigrated or incompatible workspaces yield no work. Workflow IDs bind workspace, turn, and generation. Acknowledgement defers rediscovery for 30 seconds but never marks a reply complete. Expired claims and lost dispatch acknowledgements are rediscovered from the database. Dispatch failure in one workspace does not prevent the next workspace.

The ordinary worker registers `conversationReply` and `processConversationReply`. The workflow runs one activity with a 90-second timeout and no SDK activity retry; persisted state owns retry attempts. Arguments contain only UUIDs and generation. Activity results contain only bounded statuses. The activity replaces thrown diagnostics with `conversation-reply-unavailable`. No private text enters workflow history. API and worker Docker build inputs include this package.

The API dispatcher also expires information requests, invokes the protected approval resolver for due requests, and cleans expired unbound attachments when the byte adapter is configured. The persistent browser UI uses bounded polling and explicit same-command recovery.

Messages, parts, and command receipts are insert-only for the ordinary runtime. Ownership and source identities have no update grants. The trusted runtime's database login still spans a workspace. Human privacy is enforced by the domain service, not per-human PostgreSQL roles.

Internal conversations and tool publication use the ordinary worker's `createInternalAgentComposition`. Raw internal history has no human API. [Information requests](../../docs/conversation-requests.md), [protected approvals](../../docs/conversation-approvals.md), and [attachments](../../docs/conversation-attachments.md) retain separate durable records and authority. Private-chat metering and saved-agent model continuity have distinct composition paths.

## Verification

Run `pnpm --filter @tulipfarm/conversations test` for input and title behavior. Build dependencies, then run `TEST_ADMIN_DATABASE_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres pnpm --filter @tulipfarm/conversations test:integration` against disposable local PostgreSQL.

The integration test calls the service with restricted workspace logins. It checks concurrent retries, ordered sends, restart persistence, pagination, literal search, archive/restore, stale title revisions, admin denial, cross-workspace denial, removal/rejoin denial, immutable grants, and the single-active-turn constraint. These are domain and database proofs, not HTTP, worker, or browser acceptance.

`test/integration/executor.test.mjs` proves accepted-order execution, duplicate publication, stale epoch denial, database-failure rollback, bounded retries, exhausted abandoned leases, revoked membership, and large replies. Run the API discovery proof with `TEST_ADMIN_DATABASE_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres node --test apps/api/test/conversation-dispatch.integration.mjs` from the repository root. That proof substitutes the Temporal start transport while retaining the real database and executor.

After `pnpm build`, run `TEST_ADMIN_DATABASE_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres pnpm --filter @tulipfarm/worker test:conversations` with local Temporal on port 7233. It uses compiled ordinary workflow exports and activity composition, restarts the worker, verifies persisted replies, and decodes actual Temporal input/result payloads. It does not launch the complete ordinary-worker process or test a deployed service.
