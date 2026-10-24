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

A successful send commits the message, ordered parts, one queued turn, one ID-only outbox row, command receipt, sequence allocation, title, and activity together. The turn pins the selected model family in `responder`; sends without `model` use the model catalog's default model. Before migration `0030_conversation_models.sql`, turns keep the legacy `reverse-text-v1` responder and the executor replies with the default model. A turn whose family the catalog no longer lists replies with the default model. Its accepted sequence has a composite foreign key to the source message sequence.

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

### Reading attached and referenced files

With the workspace's `images` flag on, the executor reads a turn's files through [`turn-files.ts`](src/turn-files.ts) instead of `file-references.ts`. It reads the current message's attachments, Files references and Google Drive references in attached order, then earlier messages' files newest first. Messages removed by compaction are skipped. Files and Google references are read only for the member who sent them, under that member's current access. A reference they can no longer open is `unavailable`, and its content is withheld.

`readFile` decides what a file is from its bytes, not from its declared type:

- Text is read as text.
- PDF and Office documents are read per page, slide or sheet with `@tulipfarm/memory-core`'s parser, and embedded images are recognised. Google Docs and Slides are exported as DOCX and PPTX so their images survive, and Sheets as XLSX.
- An image is an image part for a family whose route declares `imageInput`, prepared with `@tulipfarm/media` to the family's `maxImageBytes`. For other families it is the text the workspace's image reader recognised.
- Recognised text is labelled `[Recognised image]`. Recognition goes through memory-core's `recognise`, the same path Knowledge parsing uses: results are cached per workspace by image sha256, model and prompt version, so a later turn or a Knowledge parse of the same image does not pay again. A file gets at most 100 recognitions; the rest are named in a note. Each recognition reserves Knowledge credits first, and one that cannot is a gap for that image while the rest of the file is read. A turn runs at most 4 recognitions at once across all its reads.
- A ZIP archive is a listing of entry names and sizes.
- Audio, video, encrypted and unknown files are a named notice with the reason.

Every file yields content, recognised text or a named notice. Files share a budget of half the family's `maxInputTokens`, with text at 4 characters per token and each image at the family's `imageInputTokens`. A file cut by the budget is labelled partial. Files after the budget runs out are named with their type and size. Both point the model at `files.read`, a chat-only read tool that takes `{ source, pages?, sheet?, range? }` and reads one file of this chat under the same access checks, with at most 20,000 tokens per call.

The turn pins its family, the image reader and the image model with the catalog revision in `tf_conversation_turns.image_models` (common migration `0013_turn_image_models.sql`). The API pins them when it admits the turn. A turn admitted another way, such as from Slack, pins them the first time its files are read. With the flag off, the executor reads only referenced files as text, exactly as before.

### Reading links

Under the same flag, the executor reads files shared as links ([`links.ts`](src/links.ts)). It takes the current message's https links in order, deduplicated, and reads the first 5; the rest are named as not read. Each link is fetched once per message, at most 3 at once, inside the files stage, so the turn lease and abort apply. The fetcher is injected (`TurnFiles.links`); the worker passes `fetchPublicFile` from `@tulipfarm/agents/web-fetch`.

`keepLink` records each outcome in `tf_conversation_link_reads` (common migration `0014_conversation_links.sql`) with `ON CONFLICT DO NOTHING`:

- A file is stored through `AttachmentBytes` under the attachment quota as a bound attachment of the message, with `source_url`. It is then read like any attachment, so later turns read the kept copy without fetching it again. Link files are not taskable or readable by MCP.
- A page (HTML) is not read. The model is told to call `web.fetch` if it needs the text.
- A failure is a named notice: `sign-in-required`, `too-large`, `timed-out`, `not-public`, `unavailable` or `storage-full`. A failed fetch never fails the turn.

With web access off (no `FIRECRAWL_ENDPOINT`), nothing is fetched or kept and the model is told the links were not read because web access is off. A `<chat-links>` block in front of the message tells the model which links were read as files and what happened to the others.

Tasks read their Files and Google Drive inputs with `readFileText` and `readGoogleFileText`. Under the flag, the worker passes `recognisingExtract`, which is `readFile` without image input. Task inputs are then recognised, labelled and cached as in chat, charged to the task owner and limited to 4 recognitions at once per task. The rendered text must still fit the task's 16,000-character input.

The executor persists at most five attempts, including abandoned leases. A transient failure releases the lease, advances generation, and schedules exponential delays of 2, 4, 8, and 16 seconds. The fifth failure becomes failed-blocking. Explicit retry/cancel commands require the expected generation and stable command identity. Generic controls refuse waiting and reconciling turns. The deterministic responder has no external effects to reconcile. This retry policy must not be reused for unknown tool effects without domain reconciliation.

An automatic retry never reruns the model after tools have run, because the lost answer may already have acted on their results. Unless the turn can resume from durable execution steps, it ends `failed` with the error code of the failed attempt, such as `database-conflict`, `model-timeout` or `transient-failure`. A crashed attempt with no stored code ends with `reply-interrupted`. History keeps the completed tool receipts. The web chat maps each code to a plain-language cause and offers **Continue**. That explicit retry resumes the model with each recorded receipt marked as already done. Calls with stored steps are replayed with their results and guarded against repeated writes. Calls without stored steps are listed by receipt only.

History rechecks the sources a web or knowledge receipt retained. Each receipt keeps the whole reply context it ran in, so provenance markers (`unknown`, `unavailable`, another member's `personal-memory`, `shared-slack-turn`) conceal the receipt's URLs, query and passages but never change its outcome. A concrete retained source that is no longer readable still conceals the receipt as before.

Membership removal at claim, source read, or publication marks unfinished work blocked and prevents publication. Rejoining cannot restore its owner incarnation. Archive changes neither queue state nor the archived flag when a reply finishes.

The API's independent conversation dispatcher scans ready workspaces in pages of 100 and discovers up to 50 due head turns per workspace. Unmigrated or incompatible workspaces yield no work. Workflow IDs bind workspace, turn, and generation. A dispatcher leases each due turn before it starts the workflow: one statement locks the outbox rows (`SKIP LOCKED`) and moves `next_attempt_at` forward by the claim grace, so a concurrent send or sweep can't select the same turn while it starts. A failed start releases the lease at once. Acknowledgement records `dispatched_at` and defers rediscovery by the claim grace (`CHAT_DISPATCH_GRACE_MS`, default 5 seconds; 30 seconds for human waits) but never marks a reply complete. A turn that a worker doesn't claim within the grace, an expired claim, a lease left by a crashed dispatcher and a lost acknowledgement are all rediscovered from the database. Dispatch failure in one workspace does not prevent the next workspace.

After a send commits, the API runs the same dispatch scoped to that chat, without awaiting it, so the reply starts without waiting for the sweep. Both paths share the due gates, workflow ID, `USE_EXISTING` conflict policy and outbox acknowledgement, and the executor's claim fence admits one run per turn generation. Each start is bounded as a whole, including Temporal's lazy first connect: 2 seconds on send and 10 seconds on the sweep. A failed or timed-out start on send logs `dispatch_failed` with an error code (`timeout`, `service-unavailable` or `failed`) and leaves the outbox row for the sweep, which is now a recovery path. `cloud_chat_dispatches` counts starts by `dispatch_source` (`send` or `sweep`), `dispatch_reason` and outcome. `dispatch_reason` is why the turn was due: `undispatched` (never started), `unclaimed` (started, but no worker claimed it within the grace), `retry` (a scheduled retry), `expired` (a claim lapsed) or `waiting` (a human wait to re-check). In normal operation sweep starts are recoveries only, so `dispatch_source="sweep"` stays near zero.

The ordinary worker registers `conversationReply` and `processConversationReply`. The workflow runs one activity with a 90-second timeout and no SDK activity retry; persisted state owns retry attempts. Arguments contain only UUIDs and generation. Activity results contain only bounded statuses. The activity replaces thrown diagnostics with `conversation-reply-unavailable`. No private text enters workflow history. API and worker Docker build inputs include this package.

When a reply reaches a final state (completed, failed, blocked or cancelled), the worker records `cloud_chat_reply_duration` (unit `s`; `cloud_chat_reply_duration_seconds_*` in Prometheus) once, with one observation per `segment`, labelled `outcome` (`success`, `failed` or `cancelled`; blocked counts as failed) and `tools` (`yes` when a real tool ran; `present.choice` and plan-only steps don't count), plus the service dimensions. Buckets run from 0.1 to 300 seconds.

| Segment      | Meaning                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `total`      | `timing_requested_at` (or `timing_started_at` when not recorded) to `timing_finished_at`, minus `timing_human_wait_seconds`, `timing_external_wait_seconds` and `timing_inactive_seconds` |
| `first_text` | `timing_first_text_seconds` plus `send`; skipped when a failed reply showed no text                                                                                                       |
| `send`       | `timing_requested_at` to `timing_started_at`: request arrival to message saved; skipped when arrival was not recorded                                                                     |
| `queue`      | `timing_started_at` to the first claim, capped at `total − send`                                                                                                                          |
| `model`      | Wall time inside provider calls of every purpose                                                                                                                                          |
| `tools`      | Wall time inside real tool execution, excluding model calls the tool makes                                                                                                                |
| `db`         | Wall time inside reserve, settle, reply-start, checkpoint, `credit-*` and `storage-*` phases; nested phases count once                                                                    |
| `overhead`   | `max(0, total − queue − model − tools)`: our own time, including `send`, `db` and time re-queued between retries                                                                          |

Sums are wall-time unions, so nested or concurrent calls of one kind count once. Retried attempts on the same worker add their sums to the final record; an attempt that runs on another worker loses its sums. The same values, the attempt count and the trace ID go on one `chat.reply.summary` log line per reply. The `cloud_chat_latency_window_*` gauges remain a 24-hour snapshot published by each API instance.

Context size never stops a reply. When the measured first request crosses the workspace compaction trigger, older exchanges are cleaned up and summarised. A request that does not fit the window is compacted once even when automatic compaction is off or the circuit breaker has paused it; a failed attempt still counts toward the breaker. If no summary makes it fit (no approved summary model, a failed summary, or a summary that is still too large), the oldest messages, except the current message and the latest completed exchange, are left out of that request behind a note listing their message IDs, and the reply is offered `conversation.messages.read` to reread them. The transcript is unchanged. Slack and external-context chats keep no working summary, but their replies receive the workspace compaction policy so long tool work inside one reply compacts the same way as in a private chat.

A reply that ends `failed`, with no final answer, also logs one `call_failed` warning with `operation=chat.reply-stopped`, `outcome=failed`, `chat.stop.reason` and `runtime` (`chat` or `slack`), plus the bounded `error.code` the turn stored. Blocked and cancelled replies don't count. The reason is one of `context`, `provider-timeout`, `provider-error`, `database`, `credits` or `other`. It comes from the turn's stored error code; a generic code (`attempts-exhausted`, `transient-failure`) falls back to the bounded code of the failure that ended the last attempt on that worker. The event is a log line only, so it adds no metric series; count it in Loki with `count_over_time({service_name="tulipfarm-worker"} | operation="chat.reply-stopped" [5m])` grouped by `chat_stop_reason`. A reply that stopped after tool calls ends `failed` with the cause of its last failed attempt, so it is counted under that cause.

Request arrival is Fastify's request start, so `send` covers authentication, workspace resolution, storage admission and connection, the actor lookup and the insert, but not load balancer or TLS time. The web send handler stores it as `timing_requested_at` (common migration `0003_chat_send_timing.sql`); Slack and other senders leave it null, and workspaces below common version 3 omit it. The send request itself logs `chat.detail.send-request` (time before the handler), `actor`, `send-write` and `storage-*` phases with `chat.purpose=send`; these never count towards a reply's `db`.

The API dispatcher also expires information requests, invokes the protected approval resolver for due requests, and cleans expired unbound attachments when the byte adapter is configured. The persistent browser UI uses bounded polling and explicit same-command recovery.

Messages, parts, and command receipts are insert-only for the ordinary runtime. Ownership and source identities have no update grants. The trusted runtime's database login still spans a workspace. Human privacy is enforced by the domain service, not per-human PostgreSQL roles.

Internal conversations and tool publication use the ordinary worker's `createInternalAgentComposition`. Raw internal history has no human API. [Information requests](../../docs/conversation-requests.md), [protected approvals](../../docs/conversation-approvals.md), and [attachments](../../docs/conversation-attachments.md) retain separate durable records and authority. Private-chat metering and saved-agent model continuity have distinct composition paths.

## Verification

Run `pnpm --filter @tulipfarm/conversations test` for input and title behavior. Build dependencies, then run `TEST_ADMIN_DATABASE_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres pnpm --filter @tulipfarm/conversations test:integration` against disposable local PostgreSQL.

The integration test calls the service with restricted workspace logins. It checks concurrent retries, ordered sends, restart persistence, pagination, literal search, archive/restore, stale title revisions, admin denial, cross-workspace denial, removal/rejoin denial, immutable grants, and the single-active-turn constraint. These are domain and database proofs, not HTTP, worker, or browser acceptance.

`test/integration/executor.test.mjs` proves accepted-order execution, duplicate publication, stale epoch denial, database-failure rollback, bounded retries, exhausted abandoned leases, revoked membership, and large replies. Run the API discovery proof with `TEST_ADMIN_DATABASE_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres node --test apps/api/test/conversation-dispatch.integration.mjs` from the repository root. That proof substitutes the Temporal start transport while retaining the real database and executor.

After `pnpm build`, run `TEST_ADMIN_DATABASE_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres pnpm --filter @tulipfarm/worker test:conversations` with local Temporal on port 7233. It uses compiled ordinary workflow exports and activity composition, restarts the worker, verifies persisted replies, and decodes actual Temporal input/result payloads. It does not launch the complete ordinary-worker process or test a deployed service.
