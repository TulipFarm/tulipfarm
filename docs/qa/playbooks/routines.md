---
id: routines
area: Routines
suites: [full]
routes: ["/routines", "/routines/:slug", "/routines/:slug/edit", "/routines/:slug/runs/:runId"]
preconditions: [worker running]
blast_radius: >
  creates and triggers only routines named qa-<run-id>-*, through Chat or the routines UI — never a
  direct write to soul/; never touches a pre-existing routine (trigger, edit, disable, or delete);
  the qa-<run-id>-* routine itself is built to have no external side effects — a single inject state
  that returns a literal object and ends, no tool call, no agent call, no outbound message
smoke_scenarios: []
---

# Routines

Routines are Soul artifacts: scheduled or triggered workflows made of states (operation, branch,
wait, approval, …) authored and published through the same Soul pipeline as other artifacts. This
playbook only creates, triggers, or edits artifacts named `qa-<run-id>-*`, and only through Chat or
the web UI — never a direct `soul/` write.

**Reality check — read before running.** Source inspection turned up three findings that bound what
this playbook can actually exercise. They are stated once here so every scenario below can reference
them by name instead of re-deriving them:

- **No backend for list/detail/run.** `apps/api/src/routines/` contains only `authoring.ts` and
  `authoring-routes.ts`. There is no route registration anywhere in `apps/api/src` or
  `apps/worker/src` for `GET /api/v1/routines`, `GET /api/v1/routines/:slug`, `GET|POST
  /api/v1/routines/:slug/runs`, `GET /api/v1/routines/:slug/runs/:runId`, `GET
  .../runs/:runId/events`, or `POST .../runs/:runId/cancel` — every one of these is called by
  `apps/web/app/lib/routines.ts` but has no server-side implementation. `/routines`,
  `/routines/:slug`, and `/routines/:slug/runs/:runId` are expected to error, not render, until this
  is filled in. **This is the finding, not a blocker to skip the scenario** — run each scenario as
  written and record exactly where it breaks.
- **The authoring routes are dead too, even though they exist.** `registerRoutineAuthoringRoutes`
  (`apps/api/src/app.ts`) is gated behind an optional `opts.routineAuthoring` dependency. The real
  boot file, `apps/api/src/index.ts`, never constructs or passes one in — unlike sibling optional
  deps (`routineApprovals`, `ingress`, `hookIngress`), which are wired at startup. So
  `/routines/:slug/edit` is also expected to fail on load in a real `pnpm dev` instance.
  `apps/web/app/routes/_app.routines.$slug_.edit.tsx` calls `getRoutineAuthoringBase(slug)`, which
  hits the unregistered route.
- **The two schemas that exist can't talk to each other.** `routine_forge` — the only reachable
  routine-creation path, via Chat — writes the legacy CNCF-workflow schema
  (`packages/schema/src/routine.ts`) straight to `soul/routines/<name>/routine.yaml`, with no
  approval step (its own tool description says so). `trigger_routine`'s execution path
  (`apps/api/src/runtime/invocation-definitions.ts`, `ActiveRoutineInvocationResolver`) explicitly
  documents that it resolves "only from the verified active Soul bundle" and that "the live Git
  checkout and the legacy Routine registry are deliberately not consulted." A `routine_forge`-created
  routine is therefore never triggerable via `trigger_routine`, by design, not by bug. Separately,
  the Authoring Studio's "Propose changeset" writes the *other*, canonical schema
  (`packages/schema/src/definitions/routine.ts`) to that same file path — a successful publish there
  would make the file unparseable by the legacy loader `listRoutines`/`getRoutine` uses.

No disable, enable, or delete affordance for a routine exists in the web UI or in the Chat tool set
(`apps/api/src/platform/tools.ts` exposes only `trigger_routine`, `routine_forge`,
`routine_picker` for routines). Per the product-testing rule, that is a gap to record, not a state to
fabricate.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Routine list, empty state, and schedule display

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /routines` | Either the list renders, or `error: <status> …` renders via the shared error state — record which |
| 2 | If the list is empty | `<EmptyState>` shows title `Routines` and hint `No routines yet. Ask the assistant to forge one, or add soul/routines/<slug>/routine.yaml.` |
| 3 | If routines exist, `expect` each row is a link to `/routines/<slug>` showing the routine's name (or slug if unnamed) and description | Present |
| 4 | `expect` each valid row shows a trigger badge: `cron <schedule>` for a cron trigger, `on <event>` for an event trigger, or the raw trigger type (e.g. `manual`) otherwise | Present, matches the routine's actual trigger |
| 5 | If any routine failed to load, `expect` its row reads `invalid: <loadError>` and is **not** a link | Distinct from a healthy row, no dead link |
| 6 | `capture` screenshot and any failed requests | — |

If step 1 shows a 404/500 rather than a list, that confirms the Reality check's first finding — file
it as a finding with the exact status/message and move on to S2 rather than treating the playbook as
blocked.

## S2 — Creating a qa-<run-id>-* routine through Chat

There is no `/routines/new` route. The only reachable routine-creation surface is Chat's
`routine_forge` tool, so this scenario drives it from there.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /` | Chat renders |
| 2 | `type` composer: `qa-<run-id> create a routine named qa-<run-id>-routine with a manual trigger and exactly one inject state named Done that returns {"ok": true} and ends immediately. No tool calls, no agent calls, no other states.` | Text appears in the editor |
| 3 | `submit` (send) | Turn starts |
| 4 | `wait-until` streaming stops (max 60s) | Non-empty reply, no error banner |
| 5 | `expect` the transcript (open the debug drawer if the tool call isn't rendered inline) shows a completed `routine_forge` call for name `qa-<run-id>-routine` | Present — a P1 if the prompt's intent (create a routine) is clearly unmet |
| 6 | `navigate /routines` | Depends on the list route actually working (S1) |
| 7 | `expect` a row for `qa-<run-id>-routine` appears if the list renders at all | If the list route 404s per the Reality check, this step cannot pass — record it as blocked by the known finding, not as a new one |

**Assert on shape, not wording** — the exact state name and JSON payload matter here only because
they are load-bearing for S4's "no external side effects" requirement, not because the model must
phrase anything a particular way.

## S3 — Routine detail: trigger config, steps, run history

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /routines/qa-<run-id>-routine` | Detail renders, or an error state — record which |
| 2 | `expect` `<h1>` shows the routine's name (or slug) | One `h1`, matches S2's routine |
| 3 | `expect` an `author` link to `/routines/qa-<run-id>-routine/edit` is present | Present |
| 4 | `expect` a `triggers: manual` line is shown | Matches the manual trigger requested in S2 |
| 5 | `expect` a region named **Routine canvas** renders the graph read-only | `getByRole("region", {name: /Routine canvas/})`-equivalent; nodes are present, not draggable |
| 6 | `expect` a **manual trigger** section is shown, since the routine has a manual trigger | Present |
| 7 | `expect` a **run now** button is present (no form fields needed — the routine takes no inputs) | Present |
| 8 | `expect` a "run history" section below, with a **refresh** button | Present, empty on first visit |
| 9 | If the routine instead shows `invalid: <loadError>`, `expect` no canvas region renders | Consistent — an invalid routine must not show a broken partial canvas |

If S1/S2 already showed the list/detail backend is unreachable, this scenario will fail at step 1 —
record the same underlying finding rather than filing a duplicate.

## S4 — Manual trigger and poll to terminal state

This run is the fixture `inbox-approvals-runs.md` (playbook 09) inspects later in a `full` suite —
do not delete or retrigger it before 09 runs.

| # | Action | Expected |
| --- | --- | --- |
| 1 | On `/routines/qa-<run-id>-routine`, `click` `run now` | Button reflects a submitting state (`starting…`) |
| 2 | `wait-until` navigation to `/routines/qa-<run-id>-routine/runs/<runId>` (max 10s) | Navigated — this is the "form submit / CRUD write" budget from conventions.md |
| 3 | `wait-until` the run reaches a terminal state — status badge reads `succeeded`, `failed`, or `cancelled` (max 60s) | This is the "Routine run" budget from conventions.md. **Never settling is P1.** Record elapsed time and last-seen state as evidence |
| 4 | If the run succeeds within budget but takes noticeably long, `note` the measured duration | An over-budget success is a **P2 perf finding**, not a silent pass — do not invent a longer budget for "routine runs take a while," conventions.md sets 60s |
| 5 | `expect` no new console error or unintended failed XHR was produced by the SSE stream (`useRunEvents`) | Baseline-relative, per conventions.md |
| 6 | `note` the run id for cross-reference by playbook 09 | Recorded |

If S3 already showed `/routines/:slug` is unreachable, `run now` cannot be reached either — record
once and treat S4 as blocked by the same root finding rather than a fresh one.

## S5 — Run detail: step states, timings, inputs/outputs, failed-step error

| # | Action | Expected |
| --- | --- | --- |
| 1 | On the run from S4, `expect` the full (untruncated) run id renders in monospace | Present |
| 2 | `expect` a `RunStatusBadge` shows the terminal status, and `at <currentState>` if the API returned one | Present |
| 3 | `expect` a region named **Run canvas** renders the graph with per-node overlay state | Nodes reflect `running`/`completed`/`retrying`/`sleeping`/`waiting_approval`/`failed`/`cancelled` as appropriate |
| 4 | `click` the `Done` state node | Opens a complementary region titled **State details** |
| 5 | `expect` the panel shows the state's input and output as JSON (`Input {…}` / `Output {…}`) matching `{"ok": true}` | Matches the literal payload requested in S2 — confirms the state actually ran rather than being inferred |
| 6 | `expect` a start/complete timestamp range is shown | Present |
| 7 | `click` the **Journal** toggle (`aria-expanded`/`aria-controls="run-journal"`) | Expands an ordered list of raw SSE events (seq, type, payload), or "No events yet" |
| 8 | If the run failed, `expect` the state-details panel shows the error name and message text, **not a blank panel** | A blank panel on a failed step is **P1** — the error must surface, not just the badge |
| 9 | If `run.output` is non-null, `expect` an "output" heading and a `<pre>` JSON block at the bottom of the page | Present |
| 10 | If a cancel affordance is shown (only while the run is live), `expect` `cancel run` does **not** trigger a native `confirm()` dialog | A native browser confirm here is out of scope for this playbook — do not click through one if it appears; record it as a finding and back out |

## S6 — Retry behavior and child runs

The qa routine has a single `inject` state with no `x-autonomy-level`/approval gate and nothing to
retry, so this scenario is necessarily best-effort against what's observable, not a guaranteed
reproduction.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `expect` (from S5's Journal) whether any `state.retrying` event occurred | None expected for this routine — if one *did* occur, `expect` the state node shows a `retrying` status and an attempts count in State details |
| 2 | `note` whether any child-run concept (a nested/linked run) is surfaced anywhere on the run page | Source inspection (`apps/web/app/lib/routines/run-overlay.ts`, the run route) found no child-run concept in the UI at all — if none appears here either, that confirms the gap rather than being a new finding; if one *does* appear, that's new information worth flagging |

## S7 — Approval-gated step round-trip (best-effort)

This is the scenario least likely to complete end-to-end, and that likelihood is itself the finding
to confirm or refute. The legacy schema's `x-autonomy-level: human_approval` marker is the only
in-Chat-reachable way to mark a state as approval-gated, but `apps/worker/AGENTS.md` describes the
worker's actual approval mechanism as bound to the canonical schema's distinct `approval` state type
— and per the Reality check, `trigger_routine` only ever resolves the canonical, published bundle
(never a `routine_forge` legacy write) in the first place. Attempt only as far as it goes.

| # | Action | Expected |
| --- | --- | --- |
| 1 | Via Chat, ask `routine_forge` for a **new**, separate routine `qa-<run-id>-approval-routine`: manual trigger, one `operation` state marked `x-autonomy-level: human_approval` calling a read-only tool operation (e.g. a resource search), then an end state. No side-effecting operation | `routine_forge` reports success (`committed: true`) or a validation error — record whichever happens |
| 2 | `navigate /routines/qa-<run-id>-approval-routine` and attempt `run now` | Per the Reality check, expect this to fail to trigger at all (unresolvable bundle) — record the exact error surfaced, not just "it failed" |
| 3 | If a run is somehow created, `wait-until` an item appears in `/inbox` for it (max 60s) | If it appears, `expect` its `canDecide`-gated **Approve**/**Deny** buttons are present and labeled |
| 4 | If reached, `click` **Deny** (never leave a real decision half-made against a qa fixture — deny it rather than approve, since there is no real downstream to accept) | Run reflects a denied/rejected outcome, distinct from a generic failure |
| 5 | `note` the exact point of failure if the round-trip could not complete | This is expected to be the outcome — the point of failure is the useful QA signal, not a blocker |

## S8 — Authoring studio: edit, validation, invalid-graph rejection, save

The routine "editor" is **not** a node-and-connect canvas — the read-only `RoutineCanvas` component
used on the detail and run pages explicitly disables dragging, connecting, and deletion. The actual
editable surface is `RoutineAuthoringStudio`, a three-tab form (**Simple** / **Graph** / **YAML**)
that edits the *canonical* schema, published via a changeset, not saved in place.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /routines/qa-<run-id>-routine/edit` | Per the Reality check (unregistered `routineAuthoring` dependency), expect this to fail to load — record the exact error |
| 2 | If it loads, `expect` the heading reads `Author <displayName>` and body text reads `Draft version <N>. Publication remains behind validation and Approval.` | Present |
| 3 | `expect` a tablist named **Authoring mode** with tabs **Simple**, **Graph**, **YAML** | Present; arrow keys move focus between tabs and update `aria-selected` |
| 4 | On **Simple**, `expect` labeled fields **Display name** and **Owner** | Present |
| 5 | On **Graph**, `expect` a labeled textarea **Routine states** and an **Apply graph** button | Present |
| 6 | `type` invalid JSON (or a JSON object instead of an array) into **Routine states**, `click` **Apply graph** | `expect` a `role="alert"` list shows `Graph must be a JSON array of canonical Routine states.` — a clear message, not a silent no-op or a stack trace |
| 7 | On **YAML**, `expect` a labeled textarea **Routine YAML** and an **Apply YAML** button | Present |
| 8 | `type` a minimal valid canonical routine YAML for `qa-<run-id>-routine`, `click` **Apply YAML** | Issues list clears if valid, or shows `<path>: <message>` entries if not |
| 9 | `click` **Validate and simulate** | A `<dl>` populates: `Validation: <state>`, `Risk: medium|high`, `Approval: required`, `Publication: draft`, `Simulation: <status> · <N> step(s) · <M> effects` |
| 10 | `expect` **Propose changeset** is disabled until step 9's analysis exists | Present, correctly gated |
| 11 | `click` **Propose changeset** | `role="status"` text reads `Changeset <id> is <status>` (e.g. `awaiting approval`) |
| 12 | `note` that per the Reality check, a successful publish here writes canonical-schema YAML to the same `routines/<slug>/routine.yaml` path the legacy loader reads for S1/S3 — if both this scenario and S1–S3 run in the same suite pass, check whether the routine's list/detail rendering broke afterward | This is a real cross-schema collision risk worth confirming, not a hypothetical |

If step 1 confirms the route is dead, steps 2–12 cannot be exercised — record the one root finding
and do not fabricate a pass for the unreachable steps.

## S9 — Disable, enable, delete (unreachable surfaces)

No disable, enable, or delete control exists for a routine in the web UI (`_app.routines.*` routes)
or in the Chat tool set (`trigger_routine`, `routine_forge`, `routine_picker` — no delete/toggle
tool). Per the product-testing rule, this is recorded as a product gap rather than worked around with
a direct `soul/` edit.

| # | Action | Expected |
| --- | --- | --- |
| 1 | On `/routines` and `/routines/qa-<run-id>-routine`, `expect` no disable/enable toggle or status control is present | Confirms the gap — not itself a new finding if absent, since none was expected |
| 2 | On the same pages, `expect` no delete action is present | Confirms the gap |
| 3 | Ask Chat directly: `qa-<run-id> disable the routine qa-<run-id>-routine` | `expect` the assistant explains it cannot (no tool for it), rather than claiming success with no effect — a claimed-but-fake success here is **P1** |
| 4 | `note` this as a standing product gap for the operator, distinct from anything broken by this run | Recorded, not filed as a fresh bug unless the assistant in step 3 falsely claims success |

## S10 — Unknown slug/runId and loading states

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /routines/qa-<run-id>-does-not-exist` | `expect` a friendly error state, not a blank page or an unhandled stack trace — the routines `ErrorBoundary` renders `error: <status> <message>` via the shared error component |
| 2 | `navigate /routines/qa-<run-id>-routine/runs/00000000-0000-0000-0000-000000000000` | Same — friendly error, not blank |
| 3 | On a slow network throttle, `navigate /routines` | `expect` route content paints within 5s (conventions.md budget) and no permanent spinner — a spinner that never resolves is **P1** even if the request eventually succeeds |
| 4 | `capture` screenshots of both error pages | — |

## S11 — Keyboard access, both themes, 375px

| # | Action | Expected |
| --- | --- | --- |
| 1 | On `/routines/qa-<run-id>-routine`, Tab into the **Routine canvas** region and reach a state/edge node | Node/edge receives visible focus; `Enter`/`Space` opens **State details** — the canvas has no drag/connect affordance to test in the first place (S8), so keyboard coverage here means node selection and the details panel, not graph editing |
| 2 | Tab through **run now**, **author**, and run-history rows | Every control reachable, visible focus ring on each |
| 3 | If S8's Authoring Studio loaded, Tab through the **Authoring mode** tablist using arrow keys | Focus moves between tabs, `aria-selected` updates — a canvas or tab surface with no keyboard path at all is **P2 a11y** |
| 4 | Toggle to the other theme and re-check `/routines`, `/routines/qa-<run-id>-routine`, and the run page | Text legible, no invisible/clipped elements in either theme |
| 5 | Resize to 375px width | List, canvas, and run journal remain usable; nothing overflows horizontally |
| 6 | `capture` console delta and failed requests for the whole playbook | — |

## Notes for the runner

- Expect this playbook to surface mostly Reality-check findings, not per-scenario bugs: the list,
  detail, run, and authoring routes are all plausibly unreachable in a live `pnpm dev` boot today
  (`apps/api/src/index.ts` never wires `routineAuthoring`, and no route file implements
  list/get/runs at all). Run every scenario anyway — where it breaks, and how cleanly, is the
  finding.
- The routine created in S2/triggered in S4 (`qa-<run-id>-routine`) is deliberately inert: one
  `inject` state, no tool/agent action, manual trigger only. Do not substitute a routine with a real
  side effect even to "get further" in a scenario.
- The run triggered in S4 is the fixture `inbox-approvals-runs.md` (playbook 09) inspects — leave it
  in place.
- S7's approval round-trip is expected to fail early per the Reality check's schema-mismatch finding
  (legacy `x-autonomy-level` vs. canonical `approval` state type); the exact failure point is the
  useful signal, not a pass/fail on the round-trip completing.
- S9 documents disable/enable/delete as unreachable by design today — do not attempt a `soul/`
  filesystem workaround to force the state; that violates the blast-radius rules and defeats the
  point of recording it as a gap.
- Never trigger, edit, disable, or delete any routine not prefixed `qa-<run-id>-`. Never curl the
  API. Never click through a native `confirm()` dialog if one unexpectedly appears (e.g. on cancel
  run) — back out and record it.
