# AW Program — Composition Status

Where the AW-001…AW-099 program actually stands in the **running product**, as opposed to in the
task plan. The plan files (`one/TASKS.md`, `one/SPEC.md`) are planning contracts and are never
edited to record status; this file is the status record.

All 14 phases were executed and merged. The gap this file tracks is not "were the tasks done" but
"is the code they produced reachable from a real request or process boot". Phase gates
(`pnpm lint && pnpm typecheck && pnpm test && pnpm build`) pass on code that nothing imports —
they never checked reachability.

Last verified: 2026-08-01.

## How a verdict is derived

A subsystem is **composed** only if a production code path reaches it from an app entrypoint
(`apps/api/src/index.ts`, `apps/worker/src/index.ts`,
`apps/integration-worker/src/index.ts`) — not merely if it has passing unit tests.

Reproduce the package-level evidence:

```bash
# Non-test app files importing each governed package.
for p in sandbox validation testkit audit observability knowledge memory agent-runtime \
         tool-broker run-kernel routine-engine integrations authz storage surface; do
  printf '%s: %s\n' "$p" \
    "$(grep -rl "@tulipfarm/$p" apps/*/src | grep -cv '\.test\.')"
done

# Route areas gated on an optional buildApp opt.
grep -n 'opts\.' apps/api/src/app.ts
```

The gate that keeps this honest is `apps/api/src/app.composition.test.ts`: it compares every
route-gating option in `app.ts` against the options actually passed to `buildApp` in `index.ts`,
and fails unless a missing option is listed in `DEFERRED_OPTIONS` with the PR that lands it.

## Systemic defects

| ID | Defect | Status |
| --- | --- | --- |
| D1 | API route options gated on optional `buildApp` opts were never passed, so whole route areas did not exist on the running server | **Partly fixed** — `operationalApi` and `runEvents` composed; five opts deferred with named owners; regression test added |
| D2 | `apps/worker` and `apps/integration-worker` are export barrels with no `main()`, dispatch loop, or signal handling | **Partly fixed** — `apps/worker` boots (PR 1) and now executes Chat and Integration Runs end to end (PR 3); `apps/integration-worker` is still a barrel — PR 6 |
| D3 | Governed packages have zero runtime consumers while parallel `apps/api` implementations serve traffic | Open — PR 6 (direction decided: packages win, locals get migrated then deleted) |
| D4 | Phase 14 legacy removal was largely renames; `legacy-inventory.test.ts` asserts filenames, not behavior | Open — PR 8 |

## Route areas

| `buildApp` opt | Composed | Note |
| --- | --- | --- |
| `operationalApi` | yes | `/api/v1/runs`, `/admin/operations`, `/inbox`, `/roles`, `/guardrails` |
| `runEvents` | yes | `/api/v1/runs/:id/events`, and the same reader behind `POST /api/v1/chat` — the worker writes the events as of PR 3 |
| `internalTurns` | yes | `/api/v1/internal/*` — Context, Tool dispatch, delivery classification, and Turn completion for the Worker (service principals only) |
| `triggerInvoke` | no | Chat and Integration have executors as of PR 3, but Trigger/Routine Run sources do not, so a trigger would only mint Runs to be parked — PR 4 |
| `hookIngress` | no | same: signed webhook ingress is inert until its Run source has an executor — PR 4 |
| `runReplay` | no | replay recompiles the recorded Routine; the run-event stream it reads is only half of what it needs — PR 4 |
| `routines` / `routineAuthoring` | no | `@tulipfarm/routine-engine` is being retired, not revived — PR 4 |
| `forms` | no | no form storage; `GovernedFormView` is rendered by no route — PR 6 |

## Package composition

| Package | Non-test app importers | Verdict |
| --- | --- | --- |
| `soul`, `schema`, `llm`, `secrets` | 46 / 43 / 23 / 13 | composed |
| `storage` | 16 | composed — `RunStore` / `RunEventStore` back the Run browser and every stream, and `ArtifactStore` persists every request Artifact (PR 2) |
| `run-kernel` | 17 | composed — the invocation gateway, waits, cancellation, and the `ArtifactService` publish/read path all run in production (PR 3); Routine `approval` States park on the same durable Approval waits, planned in the kernel and registered by the API (PR 4); replay does not |
| `agent-runtime` | 15 | composed — the turn engine the Worker executes: context assembly, the bounded loop, and all three guardrail stages (PR 3) |
| `surface` | 11 | composed — Artifacts are created by the `surface_*` Tools the Worker dispatches through the internal host |
| `sandbox` | 11 | composed — one isolated-vm implementation, used by the API's resource hooks and by the Worker's Integration classifier (PR 3) |
| `authz` | 6 | partly composed — principal/identity types plus the deployment role catalog (`apps/api/src/identity/roles.ts`); the policy engine (`decideEffectivePermission`, `evaluateGuardrail`, `checkDlpBoundary`) now decides Routine Tool intents through `compileGuardrailPolicy` over the Run's pinned Guardrails, but no production caller supplies authority layers yet, so it denies fail-closed. A Routine `approval` State's `approverRoles` are enforced as `role:<role>` wait principals, but the only role a deployment records is a user's own `admin`/`member` — any other authored role has no members and every decision on it is refused until a role store exists |
| `integrations` | 5 | partly composed — the Worker's Integration executor runs the manifest classifier and reply binding (PR 3); the four `apps/integration-worker` importers still never start (D2) |
| `tool-broker` | 2 | partly composed — Routine `tool` States authorize, reserve, and dispatch through the broker in the Worker (`apps/worker/src/routine/tool-port.ts`, PR 4), but with an empty adapter map and no Routine authority source, so an authorized dispatch parks instead of reaching a provider. Chat turns still dispatch over HTTP through `/api/v1/internal/tools` |
| `routine-engine` | 2 | orphan subtree, scheduled for retirement |
| `validation`, `testkit`, `audit`, `observability`, `knowledge`, `memory` | 0 | not composed |

## Correctly hooked, no action needed

Skills (bundled Skill overlay, frontmatter validation, catalog UI), Tulip Surface Protocol compile
through the `surface_*` Tools the Worker dispatches, chat streaming with cursor recovery over
`run_events`, the Soul loader, `@tulipfarm/schema` AJV validation on tool calls, the LLM provider
chain, secrets, and the editor surfaces.

## What PR 0 changed

- Replaced the `apps/api/src/admin/runtime.ts` stubs with live reads: Runs through
  `RunStore` (`admin/run-reader.ts`), health through real dependency probes
  (`admin/health.ts` — PostgreSQL, pg-boss, Soul git sync, LLM provider), and the role catalog
  through `@tulipfarm/authz`.
- Commands with no authority in this deployment (`commandRun`, `commandOperation`,
  `propose*Changeset`) return a typed `501 not_implemented` through the existing error envelope
  and name the missing capability, instead of throwing a 500 or silently accepting. Administrators
  keep every permission, so the answer is "this deployment cannot do that", never "you lack access
  to a capability that does not exist".
- Added migration `13` for the Run browser's page-order index, and keyset paging
  (`RunStore.list`) so the browser cannot shift rows while an operator pages.
- Web: added `/runs`, deleted four routes that re-exported `/operations` verbatim, made `/inbox`
  the single Approvals surface, and made Run controls go inert with the server's own reason once a
  command answers `501`.

Empty sections in the Run inspector (effects, waits, Guardrail decisions, costs) and in the
Operations console (quarantine, recovery) are empty because nothing writes them yet — not because
data is withheld. They fill in when PR 1/3/4 land their writers.

## What PR 1 changed

- `apps/worker` boots. `src/main.ts` is a composition root: config validation, a fail-closed
  preflight that refuses to start below `schema_version` 15 (the API owns migrations — the worker
  only reads), three independent loops (Run dispatch, wait sweep, outbox delivery), `/livez` +
  `/readyz` over `node:http` mirroring the API's probe names, and a `SIGTERM`/`SIGINT` drain that
  exits 0 on a clean finish and **non-zero when the drain times out**.
- The Dockerfile emits a second entrypoint (`worker.cjs`) from the same image, and compose runs it
  as a `worker` service gated on `app` being healthy, so an API and a worker sharing a tag can
  never disagree about the schema.
- No Run source has an executor yet. An unmatched Run releases to `needs_reconciliation` with the
  missing executor named — never a silent success, and never a failure with no recorded cause.
  Executors arrive in PR 3; the outbox delivery registry is likewise empty until PR 6.
- **The chat path now completes the Runs it mints.** Before this PR every chat message inserted a
  `queued` Run that nothing ever executed, so `/runs` accumulated orphans and enabling the worker's
  Run loop would have made it steal Runs the API had already run. The API now claims its Run before
  the stream opens and releases it from `TURN_FINISHED`. A human-in-the-loop pause parks the Run in
  `waiting` holding no lease — the resume path still mints a fresh Run, which PR 3 replaces with a
  durable wait. The two exits that emit no `TURN_FINISHED` — a validation failure and a
  guardrail-blocked input — release the Run themselves, so an ordinary bad request never turns into
  reconciliation work a lease expiry later.
- Pre-existing orphan `queued` rows were deliberately left in place. A data migration would have to
  guess at the outcome of Runs nobody recorded, and a guessed status is worse than a visible one.

## What PR 2 changed

- **Every request that mints a Run is now a persisted Artifact.** Before this PR all three gateway
  call sites satisfied the "protected input crosses this boundary only by Artifact reference" check
  with a `payloadRef` naming nothing, so killing the API mid-turn left a Run whose input existed
  only in the dead process's memory. `DurableInvocationGateway.start` now takes the payload plus the
  schema ref it claims to satisfy, validates it **before** minting a `runId`, and commits the
  Artifact, the Run, and its first State in one transaction. The State's `payloadRef` resolves to
  `artifact:${runId}:request`, and the ACL names `service:run-executor` — the principal PR 3's
  worker reads as. Artifacts are append-only, so that ACL had to be right on the first write.
- An unregistered schema ref or a schema-invalid payload is denied `invalid_payload` and inserts no
  `runs` row at all. A replayed idempotency key returns the stored `runId` and publishes no second
  Artifact.
- **Chat submissions are durable Turns.** Migration `16` adds `conversation_turns` plus
  `messages.turn_id`, and `PgConversationStore` implements the `ConversationStore` port
  `ConversationService` was written against (previously an interface with no implementation and no
  callers). One `ChatTurnSubmitter` port is the single place a request is persisted — the turn
  pipeline itself no longer writes the user Message — so the HTTP route and the headless caller
  cannot drift into two submission paths.
- A client-supplied `Idempotency-Key` (minted once per turn by the web client) makes a replayed
  request resolve to the Turn and Run that already answer it: `409 { error, runId }`, refused
  before the turn prepares, so a retry creates no conversation, no title, no Message, no Run.
  Requests carrying no key fall back to `req.id`, which is unique per delivery. The stored Turn key
  is scoped to the submitting principal: the header value is whatever a client chose to send and Turn
  keys are unique deployment-wide, so an unscoped key would let one caller's key claim another's turn
  and answer it with a Run id that is not theirs.
- Two *simultaneous* requests sharing one key are not handled: both pass the pre-check, and the loser
  hits the `conversation_turns.idempotency_key` unique constraint after its Message was appended — a
  500 plus one orphan `messages` row. Sequential replay, which is what a retry actually is, resolves
  correctly. Closing the race needs `appendMessage` and `saveTurn` in one transaction, which the
  `ConversationStore` port does not currently express.
- Channels submit through the same boundary. A verified Slack/Telegram delivery is stored as the raw
  `{slug, body, headers}` envelope — normalizing it needs the manifest classifier, which is
  isolated-vm work that does not fit inside Slack's ~3s ack window — attributed to
  `integration:${slug}` because no human has been resolved yet.
- **Slack and Telegram still cannot reply.** Their submissions are durable and their Runs are
  reconstructable, but nothing executes them: `parseDecision` (the ingress classifier),
  `IngressIdentityResolver` (sender identity), and `postReply` (delivery) remain written, tested,
  and unwired. PR 3 owns all three, plus the derived chat-request Artifact that carries
  `derived_from` lineage back to the raw envelope.
- `ConversationService.streamHandle` stays unwired: it resumes over `run_events`, which has no
  writer until PR 3. Web still resumes over `stream_resume`.
- Pre-existing `messages` rows keep `turn_id` NULL. They predate Turns, and inventing a Turn for
  them would be a guess.

## What PR 3 changed

- **The turn moved.** `apps/api/src/runtime/chat-run.ts` and `chat/producer.ts` are deleted; the
  model loop, context assembly, compaction, the system prompt, and all three guardrail stages now
  live in `@tulipfarm/agent-runtime`, and `apps/worker/src/turn/` drives them. The API authenticates,
  submits durably, and reads events back — it executes nothing. That is what makes Slack and
  Telegram equal to web rather than second-class: `TurnDriver` holds no channel policy, so one code
  path answers all of them. Enforcement moved with it — guardrails that ran in the API guarded web
  and nothing else.
- **`run_events` is the one stream.** `@tulipfarm/schema`'s `RUN_EVENT_DEFINITIONS` fixes a
  channel-neutral vocabulary, each type bound to an audience, and every payload is validated on the
  way in. `POST /api/v1/chat` submits the turn and then reads that Run's persisted events —
  frame for frame the stream `GET /api/v1/runs/:id/events` serves — so a dropped connection
  reattaches by cursor and loses nothing, and an operator can read a finished turn back. Migration
  `18` drops `stream_resume`, and `chat/stream-hub.ts` + `chat/stream-resume.ts` survive only as the
  contract Routines still use.
- **Operator evidence is withheld from participants, per event, at the source.** `context.assembled`,
  `tool.dispatched`, `guardrail.decision`, and `delivery.classified` carry digests and decision
  records; the reader re-checks the grant on every poll. Tool arguments reach a participant only as
  `canonicalHash` — a secret passed as an argument cannot appear in a stream the conversation reads.
- **Approvals are kernel waits.** The Run parks in `waiting` holding the bound Tool intent and
  resumes at the same State on the same `runId` — PR 1's resume-mints-a-fresh-Run path,
  `approvals/chat-gate.ts`, and `chat/pending-interactions.ts` are gone, so a resumed turn can no
  longer duplicate its Message.
- **A worker attempt is bookkept.** Migration `17` adds `turn_completions` keyed `(turn_id, attempt)`
  and `messages.attempt`, so a worker killed mid-turn is retried under a new attempt without
  colliding with the dead one. The worker's schema floor moves 15 → 17.
- **Channels resolve to people.** An inbound sender is matched against `external_identity_mappings`
  (reused, not duplicated — a second table would be a second authority for the same question),
  then against the manifest identity binding, which auto-links a provider-verified email. An
  unmatched sender never reaches the model: the Run is recorded as denied and the reply carries a
  single-use, 15-minute HMAC bind link that only an authenticated session can redeem
  (`identity/channel-link.ts`, `channel_bind_tokens`).
- **One sandbox.** `packages/sandbox` holds the isolated-vm executor; the API's resource hooks and
  the Worker's Integration classifier are both callers. The classifier runs in the Worker because it
  is untrusted per-Integration code and the API is the process holding every credential — the two
  entrypoints grant different capabilities and must keep different bundle basenames.

### Deviations from the PR 3 plan

- **Tool dispatch does not go through `@tulipfarm/tool-broker`.** The Worker's `ToolDispatchPort`
  is served over HTTP by `/api/v1/internal/tools`, which runs the API's existing `ToolRegistry`.
  The port is the contract, so PR 4 can swap the implementation, but the broker's approval and
  reconciliation logic is still uncomposed today.
- **`triggerInvoke`, `hookIngress`, and `runReplay` are still deferred.** Chat and Integration have
  executors; Trigger/Routine Runs do not, so composing those opts would mint Runs nothing executes.
  They move with the Routine work in PR 4.
- **NOTIFY is installed but nothing listens.** Migration `17` creates the `run_events` trigger;
  the API has no `LISTEN` connection yet, so streams still wake on the 500ms poll. This was always
  a latency hint, never correctness — the reader re-reads by cursor regardless.
- **Web chat lost two behaviors.** Surface Artifacts are created but not rendered in chat (the web
  mapper emits nothing for `surface.emitted`), and model-resolution errors that used to answer
  synchronously (`400 UnknownModelError`, `503 LlmNotConfiguredError`) now surface as a failed Run.
  Approval cards no longer show a countdown — no `expiresAt` is on the wire — and are released by
  the Tool's result rather than a dedicated event.
- **`POST /api/v1/chat`'s wire event names changed.** The plan said the route keeps its contract;
  it does not. It streams the raw run-event vocabulary and `apps/web/app/lib/chat/sse-client.ts`
  projects it, so the web is one reader of a shared stream rather than the shape the stream is
  built for.

## Remaining work

See [`aw-program-blockers.md`](aw-program-blockers.md) for the blocker inventory and the PR
sequence (workers → durable Chat → jobs/effects → Soul authoring gateway → governed package
composition → load harness → cutover verification).
