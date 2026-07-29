# AW Program — Composition Status

Where the AW-001…AW-099 program actually stands in the **running product**, as opposed to in the
task plan. The plan files (`one/TASKS.md`, `one/SPEC.md`) are planning contracts and are never
edited to record status; this file is the status record.

All 14 phases were executed and merged. The gap this file tracks is not "were the tasks done" but
"is the code they produced reachable from a real request or process boot". Phase gates
(`pnpm lint && pnpm typecheck && pnpm test && pnpm build`) pass on code that nothing imports —
they never checked reachability.

Last verified: 2026-07-29.

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
| D2 | `apps/worker` and `apps/integration-worker` are export barrels with no `main()`, dispatch loop, or signal handling | **Partly fixed** — `apps/worker` has a composition root, three loops, fail-closed preflight, probes, and a drain (PR 1); `apps/integration-worker` is still a barrel — PR 6 |
| D3 | Governed packages have zero runtime consumers while parallel `apps/api` implementations serve traffic | Open — PR 6 (direction decided: packages win, locals get migrated then deleted) |
| D4 | Phase 14 legacy removal was largely renames; `legacy-inventory.test.ts` asserts filenames, not behavior | Open — PR 8 |

## Route areas

| `buildApp` opt | Composed | Note |
| --- | --- | --- |
| `operationalApi` | yes | `/api/v1/runs`, `/admin/operations`, `/inbox`, `/roles`, `/guardrails` |
| `runEvents` | yes | `/api/v1/runs/:id/events`; the stream is legitimately empty until the worker writes events |
| `triggerInvoke` | no | the worker boots as of PR 1, but no Run source has an executor, so a trigger would only mint Runs to be parked — PR 3 |
| `hookIngress` | no | same: signed webhook ingress is inert until a Run source has an executor — PR 3 |
| `runReplay` | no | replays events no writer produces yet — PR 3 |
| `routines` / `routineAuthoring` | no | `@tulipfarm/routine-engine` is being retired, not revived — PR 4 |
| `forms` | no | no form storage; `GovernedFormView` is rendered by no route — PR 6 |

## Package composition

| Package | Non-test app importers | Verdict |
| --- | --- | --- |
| `soul`, `schema`, `llm`, `secrets` | 41 / 38 / 21 / 11 | composed |
| `storage` | 7 | composed — `RunStore` / `RunEventStore` back the operational Run browser |
| `run-kernel` | 6 | partly composed — the invocation gateway and Run event reader are reachable; replay is not |
| `authz` | 4 | partly composed — principal/identity types plus the deployment role catalog (`apps/api/src/identity/roles.ts`); the policy engine (`decideEffectivePermission`, `evaluateGuardrail`, `checkDlpBoundary`) still has no production caller |
| `surface` | 4 | composed — the compiler is reached from `chat/producer.ts` |
| `integrations` | 4 | not composed — all four importers are in `apps/integration-worker`, which never starts (D2) |
| `agent-runtime`, `tool-broker` | 1 each | not composed — type-only import / SQL DDL constant only |
| `routine-engine` | 2 | orphan subtree, scheduled for retirement |
| `sandbox`, `validation`, `testkit`, `audit`, `observability`, `knowledge`, `memory` | 0 | not composed |

## Correctly hooked, no action needed

Skills (bundled Skill overlay, frontmatter validation, catalog UI), Tulip Surface Protocol compile through
`chat/producer.ts`, Chat/SSE with durable resume, the Soul loader, `@tulipfarm/schema` AJV
validation on tool calls, the LLM provider chain, secrets, and the editor surfaces.

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

## Remaining work

See [`aw-program-blockers.md`](aw-program-blockers.md) for the blocker inventory and the PR
sequence (workers → durable Chat → jobs/effects → Soul authoring gateway → governed package
composition → load harness → cutover verification).
