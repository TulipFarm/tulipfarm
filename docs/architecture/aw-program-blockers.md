# Phase 14 Remaining Major Blockers — Handoff

## Purpose

This is the tracked inventory of implementation work that remains after the Phase 14 review. It
records blockers; it is not release evidence, and nothing here implies a blocker is resolved. For
what is composed into the running product today, see
[`aw-program-status.md`](aw-program-status.md).

The audit that established this baseline was merged by PR #257 at commit `f858075`
(`fix(cutover): make phase 14 review fail honest`) on 2026-07-26.

The original checked-in audit baseline was:

- `ops/cutover/review.ts`: six deferred MAJOR findings.
- `ops/cutover/spec-traceability.ts`: blocked SPEC sections, invariants, and cutover criteria.
- `ops/cutover/contract.ts`: fail-closed cutover contract.
- `ops/verification/phase14.ts`: verification claims that still need run-derived evidence.

PR #258 removes the entire `ops/` directory and its coupled tests, scripts, and documentation.
Those files were not production-composed and are no longer an implementation or release-status
authority. Evaluate the remaining work directly against `SPEC.md`, production code, and executable
acceptance tests.

## Guardrails for the next session

- Read the root `AGENTS.md` and every nearest app/package `AGENTS.md` before editing.
- Use the canonical terminology in `metadata/terminologies.md`.
- Do not edit `/Users/dhruv/dev/tulipfarm/one/SPEC.md` or
  `/Users/dhruv/dev/tulipfarm/one/TASKS.md`; they are planning contracts, not implementation
  status files.
- Do not turn a blocked traceability entry into `met` by changing only its label or evidence text.
  Resolve the production bypass and add acceptance evidence first.
- Do not directly edit the runtime `soul/` repository to prepare product-flow tests. Create Soul
  artifacts through Chat or the supported UI.
- Do not add another compatibility path, legacy exception, or second authority.
- Keep API handlers thin. Durable execution belongs in the Worker or Integration Worker; external
  effects belong behind the Tool Broker.
- Make this a series of scoped PRs. The remaining work is too large and coupled for one safe PR.

## Current release blockers

The following checked-in requirements remain blocked:

- SPEC sections: `5`, `8`, `9`, `10`, `11`, `14`, `15`, `20`, `22`, `25`, `26`, `28`.
- Architectural invariants: `I-05`, `I-07`.
- Cutover criteria: `C-01`, `C-02`, `C-06`, `C-09`.

The six findings from the baseline audit were:

1. Production Soul authoring bypasses the changeset validation gateway.
2. Chat records a Run but executes the Turn inline without durable worker States.
3. Legacy API-owned jobs and direct Tool execution remain authoritative.
4. Required scenario load and recovery targets have no measured load run.
5. Worker applications are libraries rather than bootable authoritative processes.
6. Checked-in Phase 14 verification evidence was self-declared instead of run-derived.

Current implementation progress:

- PR #258 deletes the self-declared record instead of replacing it with another repository-local
  operations framework. Final release verification still needs to run through the real CI and
  deployment surfaces after the runtime, load, and cutover blockers are fixed.

## Recommended implementation order

### 1. Make the Worker applications bootable

This is the prerequisite for moving authority out of the API.

Current evidence:

- `apps/worker/src/index.ts` only exports library symbols.
- `apps/integration-worker/src/index.ts` only exports library symbols.
- Their `dev` commands start those export-only files and can exit without running dispatch loops.
- `C-06` is blocked because a real Worker cannot be killed and observed through reconciliation.

Required outcome:

- Add explicit production entrypoints and composition roots for the Worker and Integration Worker.
- Compose PostgreSQL/storage ports, Run dispatch, State processing, waits, retries, outbox handling,
  effect reconciliation, Integration ingress/delivery, logging, metrics, and configuration.
- Start long-running dispatch loops and keep the processes alive.
- Expose liveness and readiness based on real dependencies and consumer readiness.
- Handle `SIGTERM`/`SIGINT`: stop accepting new work, drain within a bound, close dependencies, and
  exit non-zero when shutdown is unsafe.
- Ensure startup fails closed when mandatory dependencies or configuration are unavailable.

Acceptance:

- Starting each app produces a long-running process, not an export-only process.
- Health becomes ready only after PostgreSQL and required consumers are ready.
- A submitted Run is claimed and advanced by the Worker with persisted State transitions.
- Integration ingress/delivery is processed by the Integration Worker.
- Killing the Worker during an approved effect leaves recoverable durable evidence; restart reaches
  reconciliation without duplicating the effect.
- Container/Compose definitions run these entrypoints and have useful health checks.
- Unit tests cover lifecycle edges; process-level integration tests prove boot, dispatch, shutdown,
  restart, and reconciliation.

### 2. Route Chat through durable Run and State execution

Current evidence:

- `apps/api/src/chat/routes.ts` calls `runChatTurn`.
- `apps/api/src/runtime/chat-run.ts` performs the Turn inline.
- `apps/api/src/chat/headless-chat-turn.ts` provides a second inline path for Integration ingress.
- The invocation gateway records a Run with a synthetic request reference, but the request payload
  is not a persisted Artifact that a Worker can reconstruct.
- A Run can remain queued while the API performs the actual model and Tool work.

Required outcome:

- Persist the complete, immutable Turn input as an Artifact before dispatch.
- Create the Run and initial States transactionally with the Artifact/outbox record.
- Have the Worker load that Artifact, assemble Context, execute the bounded Agent loop, dispatch
  Tools through the Tool Broker, and persist State outputs/events.
- Make the API responsible only for authentication/authorization, durable submission, and
  streaming persisted events.
- Make headless/Integration Chat submit through the same gateway.
- Define reconnect and idempotency behavior so a retried HTTP request does not create a second
  logical Run.

Acceptance:

- `I-07` and `C-02` pass for Chat, manual Trigger, webhook, schedule, channel, and Integration
  ingress using the same durable Run/State model.
- No API request handler invokes the model loop or performs Turn effects inline.
- The Worker can reconstruct the Turn from persisted data after the API process exits.
- API death after acknowledgement does not lose the Turn.
- Worker death resumes from persisted State without duplicate Messages or effects.
- SSE reconnect replays persisted events from a cursor and does not depend on API process memory.
- Tests assert actual State records and immutable Artifact references, not only a Run ID header.

### 3. Move API-owned jobs and Tool effects to their authoritative owners

Current API-owned consumers include:

- `apps/api/src/routines/jobs.ts`
- `apps/api/src/routines/schedules.ts`
- `apps/api/src/soul-sync.ts`
- `apps/api/src/knowledge/indexing.ts`
- `apps/api/src/knowledge/connectors/sync.ts`
- `apps/api/src/observability/prune.ts`

Direct/legacy Tool execution is centered around:

- `apps/api/src/routines/action-executor.ts`
- `apps/api/src/routines/run-executor.ts`
- related approval-channel, ingress, and binding paths discovered from their callers

Required outcome:

- Move Routine scheduling, wake/sweep consumption, and Run advancement into the Worker.
- Move Integration-owned ingress, sync, delivery, retry, and reconciliation into the Integration
  Worker.
- Assign remaining maintenance consumers to the correct long-running process and document why.
- Route every Tool invocation through the Tool Broker intent/effect lifecycle.
- Persist stable idempotency keys, Approval binding, dispatch evidence, ambiguous-result state, and
  reconciliation outcomes.
- Remove API `boss.work(...)` registrations and direct external side effects. The API may enqueue
  durable work but must not own its execution.

Acceptance:

- Production API source contains no `boss.work(...)` consumer registration.
- No production Routine, Chat, channel, webhook, or Integration path bypasses the Tool Broker.
- Duplicate delivery produces one logical Run and idempotent effects.
- Approval binds the exact Tool intent and Guardrail revision that is dispatched.
- Crash-after-dispatch and timeout ambiguity converge through reconciliation.
- `C-06` and the Tool portion of `C-09` have process-level acceptance evidence.

### 4. Migrate all authored Soul writes to the changeset gateway

Known direct-write surfaces include:

- `apps/api/src/setup/routes.ts`
- `apps/api/src/setup/soul-config.ts`
- `apps/api/src/platform/tools.ts`
- `apps/api/src/soul/routes.ts`
- `apps/api/src/soul/agents/tools.ts`
- `apps/api/src/soul/skills/tools.ts`
- `apps/api/src/soul/skills/routes.ts`
- `apps/api/src/soul/resource-types/tools.ts`
- `apps/api/src/soul/resource-types/routes.ts`
- `apps/api/src/soul/llm-config/soul-yaml-io.ts`
- `apps/api/src/soul/integrations/lock.ts`

Re-run discovery; this list is evidence, not an allowlist.

Required outcome:

- Define one application-facing Soul authoring port backed by the `@tulipfarm/soul` changeset,
  validation, proposal, Approval, publication, and immutable bundle APIs.
- Migrate Agent, Skill, Resource Type, Routine, Integration, Soul Config, Onboarding, marketplace
  install/lock, and agentic authoring paths to that port.
- Validate the complete candidate tree and cross-artifact references before publication.
- Preserve optimistic concurrency and return actionable conflicts.
- Make publication atomic from the runtime's perspective; failed validation or Git operations must
  not leave a partially authoritative definition.
- Remove route/tool-level filesystem and Git mutation.

Acceptance:

- `I-05` and `C-01` pass for UI, API, Agent, import/migration, marketplace install, and Onboarding.
- No production authoring path under `apps/api` directly calls filesystem mutation or
  `gitSync.commit` for Soul.
- Invalid or conflicting multi-file changes fail before publication and leave the active bundle
  unchanged.
- Runtime loading uses only approved immutable content-hashed bundles.
- Product-flow acceptance tests create/update artifacts through Chat or the UI, never by writing
  directly to the runtime Soul repository.

### 5. Compose governed packages into production

Package-level tests are not enough while production apps keep using local/legacy implementations.
The traceability matrix specifically calls out missing production composition for Knowledge,
Memory, Audit, Integrations, and observability. Sandbox enforcement also needs to be verified at
the real Tool dispatch boundary.

Required outcome:

- Compose `@tulipfarm/audit` for production Run, State, Approval, Tool effect, identity, and
  administrative events.
- Compose `@tulipfarm/knowledge` and `@tulipfarm/memory` into Context assembly with authorization
  before candidate/content return and with provenance.
- Compose `@tulipfarm/observability` across API and both workers for shared conventions, redaction,
  metrics, health, readiness, and backpressure.
- Compose `@tulipfarm/sandbox` at Tool/Skill execution boundaries.
- Compose `@tulipfarm/integrations` through the Integration Worker rather than parallel API-owned
  implementations.
- Remove or adapt duplicate local implementations so there is one production authority per
  concern.

Acceptance:

- Production import/composition tests prove each governed package is used by the owning app.
- Security tests exercise production composition, not only isolated package fixtures.
- Knowledge authorization occurs before candidates or content are returned.
- Memory scope and confirmation rules apply to real Chat execution.
- Audit records are durable, append-only/hash-linked, correlated, redacted, and exportable.
- Tool execution cannot bypass Sandbox policy where isolation is required.
- Traceability sections `14`, `15`, and `20` can be changed to `met` using production evidence.

### 6. Replace synthetic load evidence with measured scenarios

Current evidence:

- `test/performance/load-profile.test.ts` tests an in-memory admission controller.
- It fabricates evidence with `actualMs === targetMs`.
- It does not generate real ingress, 1,000 concurrent Runs, long waits, fan-out, SSE reconnect,
  Integration/provider rate limiting, process death, or recovery.

Required outcome:

- Build a repeatable load harness against production-like API, Worker, Integration Worker, and
  PostgreSQL processes.
- Measure every scenario in `test/performance/load-profile.ts`.
- Record named hardware, build/component digests, dataset/configuration, timestamps, latency
  percentiles, throughput, error/loss counts, queue depth, recovery time, and target disposition.
- Exercise backpressure, rate limiting, reconnect, restart, and reconciliation under load.
- Store generated machine-readable results in the release-evidence mechanism chosen by the
  project; do not hand-author passed results.

Acceptance:

- All named scenarios run against real processes and durable storage.
- 1,000 accepted Runs are persisted before admission and none are lost.
- Long waits and fan-out resume correctly after worker restart.
- SSE reconnect catches up from durable events.
- Integration and model rate limits produce bounded backpressure rather than loss or retry storms.
- A missed target is a blocking variance with measured evidence, not silently changed to passed.
- Traceability section `22` is supported by generated results.

### 7. Harden legacy removal and complete real release verification

Baseline evidence:

- PR #258 removes the repository-local Phase 14 verification record and runner.
- `scripts/lib/architecture-rules.ts` still has legacy exceptions for Soul `constants` and API
  `llm`/`routine-engine`.
- Legacy-removal checks primarily detect old names/strings and can miss legacy behavior moved to a
  new filename.

Remaining outcome:

- Run independently approved acceptance checks through the actual CI and deployment surfaces
  against the cutover commit and component digests.
- Expand architecture/legacy tests to detect behavior and forbidden dependency direction, not only
  retired filenames.
- Remove legacy exceptions after their callers are migrated.
- Delete bypass routes, consumers, direct effects, and renamed legacy implementations.

Acceptance:

- Verification cannot pass by editing repository-local status constants.
- Test/lint/typecheck/build, Compose health, Chat, webhook, schedule, effect/reconciliation,
  authorization denial, load, and restore evidence are generated and validated.
- Evidence from another commit or component digest is rejected.
- Architecture rules have no release-path legacy exceptions.
- Searches and structural tests prove the API has no direct Soul-write, Tool-effect, or job-consumer
  authority.
- Traceability sections `25` and `26`, plus `C-09`, have run-derived evidence.

## Dependency map and suggested PR boundaries

1. Worker and Integration Worker boot/composition roots.
2. Persisted Chat request Artifact plus durable initial States.
3. Worker-owned Chat/Agent execution and persisted event streaming.
4. Routine/Trigger consumers and all Tool effects moved out of the API.
5. Soul authoring gateway migration, split by authoring domain if needed.
6. Governed Knowledge/Memory/Audit/observability/Sandbox/Integration composition.
7. Real load harness and recovery scenarios.
8. CI/deployment verification, legacy removal, and final cutover evidence.

Soul authoring can proceed in parallel with worker boot after the authoring port is agreed, but do
not merge partial migrations that create another permanent write path.

Each PR should update tests that exercise the production behavior. Do not claim a requirement is
met until that PR removes the production bypass it names.

## Discovery commands

Run from the repository root. Follow the local RTK instructions when issuing them through Codex.

```bash
git status -sb
git log -1 --oneline

rg -n 'boss\.work' apps/api/src
rg -n 'runChatTurn|headlessChatTurn|actionExecutor|executeAction' apps/api/src
rg -n 'gitSync\.commit|writeFile|mkdir|unlink|rm\(' \
  apps/api/src/setup apps/api/src/soul apps/api/src/platform
rg -n '"@tulipfarm/(audit|knowledge|memory|observability|sandbox|integrations)"' \
  apps packages
rg -n 'legacyExceptions|legacy|compat' scripts apps packages
```

Classify test fixtures separately from production paths, but do not assume a production match is
acceptable because a similarly named package implementation exists.

## Definition of done

All of the following must be true:

- SPEC sections `5`, `8`, `9`, `10`, `11`, `14`, `15`, `20`, `22`, `25`, `26`, and `28` have
  implementation-backed evidence.
- `I-05`, `I-07`, `C-01`, `C-02`, `C-06`, and `C-09` are genuinely `met`.
- API, Worker, and Integration Worker have singular documented ownership boundaries.
- Every authored Soul write uses the changeset gateway.
- Every Turn and automation creates durable Runs and States.
- Every external mutation uses the Tool Broker and durable effect/reconciliation evidence.
- Workers are bootable, observable, restartable, and authoritative.
- Governed packages are composed in production paths.
- Load and recovery results are measured against real processes.
- Verification is generated, commit-bound, and fail-closed.
- Legacy bypasses and architecture exceptions are removed.

Final verification should include, at minimum:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Also run the production Compose, Chat, every Trigger class, Tool effect/reconciliation,
authorization-denial, load, graceful-shutdown/restart, and backup/restore acceptance checks. Record
their generated outputs against the exact commit and component digests used for cutover.

## Known baseline caveat

During the audit, the full suite passed when the API Vitest suite was constrained to one worker.
An unconstrained `pnpm test` completed the other Turbo tasks but two API fork workers crashed near
the end without an assertion failure. Treat runner stability as a real verification concern: a
release gate must be repeatable under its documented resource profile and must distinguish test
failures from worker-process exhaustion.
