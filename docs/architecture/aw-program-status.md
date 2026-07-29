# AW Program — Composition Status

Where the AW-001…AW-099 program actually stands in the **running product**, as opposed to in the
task plan. The plan files (`one/TASKS.md`, `one/SPEC.md`) are planning contracts and are never
edited to record status; this file is the status record.

All 14 phases were executed and merged. The gap this file tracks is not "were the tasks done" but
"is the code they produced reachable from a real request or process boot". Phase gates
(`pnpm lint && pnpm typecheck && pnpm test && pnpm build`) pass on code that nothing imports —
they never checked reachability.

Last verified: 2026-07-27.

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
| D2 | `apps/worker` and `apps/integration-worker` are export barrels with no `main()`, dispatch loop, or signal handling | Open — PR 1 |
| D3 | Governed packages have zero runtime consumers while parallel `apps/api` implementations serve traffic | Open — PR 6 (direction decided: packages win, locals get migrated then deleted) |
| D4 | Phase 14 legacy removal was largely renames; `legacy-inventory.test.ts` asserts filenames, not behavior | Open — PR 8 |

## Route areas

| `buildApp` opt | Composed | Note |
| --- | --- | --- |
| `operationalApi` | yes | `/api/v1/runs`, `/admin/operations`, `/inbox`, `/roles`, `/guardrails` |
| `runEvents` | yes | `/api/v1/runs/:id/events`; the stream is legitimately empty until the worker writes events |
| `triggerInvoke` | no | needs a bootable worker to act on the invocation — PR 1 |
| `hookIngress` | no | signed webhook ingress is inert without a worker — PR 1 |
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

## Remaining work

See [`aw-program-blockers.md`](aw-program-blockers.md) for the blocker inventory and the PR
sequence (workers → durable Chat → jobs/effects → Soul authoring gateway → governed package
composition → load harness → cutover verification).
