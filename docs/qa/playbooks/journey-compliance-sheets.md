---
id: journey-compliance-sheets
area: Journeys
suites: [journeys]
routes: ["/", "/resources/:type", "/routines", "/agents/:name"]
preconditions: signed-in session
blast_radius: creates a qa-journeys-s5-* Resource type, Agent, and (attempted) Routine, left in place
est_minutes: 20
smoke_scenarios: []
---

# Journey: compliance sheet automation

User story: low-incentive, high-must-do compliance paperwork (security questionnaires, vendor
due-diligence) that nobody's KPI rewards doing well or fast. Test whether Routine + Agent + Resource
+ human-approval can plausibly compose into automating it.

## S1 — Compose the primitives

| # | Action | Expected |
| --- | --- | --- |
| 1 | In chat, ask for: a `qa-journeys-s5-compliance-sheet` resource type (title, status
  draft/pending-approval/approved/submitted, dueDate, answers json), an agent that fills sheets
  from company knowledge with a human-approval gate before external submission, and a routine that
  periodically checks for new compliance work — explicitly ask it to be honest about anything
  unsupported (PDF/form filling, external calendar triggers) | `wait-until` terminal turn (max 120s) |
| 2 | `expect` the response honestly names the ceiling: no arbitrary PDF/third-party-form filling, no
  external compliance-calendar trigger, external submission stays manual | This is the story's own
  stated bar for a good-faith "what TulipFarm can and can't do" answer |
| 3 | `navigate /routines` | `expect` the created routine listed — **known gap**: `routine_forge`
  frequently reports success while the routine never appears here (#406). If reproduced, don't
  re-file — comment on #406 with this run's evidence |
| 4 | `navigate /resources/qa-journeys-s5-compliance-sheet` and `/agents/<created-agent-slug>` | Both
  render correctly regardless of the routine-visibility outcome |
| 5 | `capture` screenshot, console delta | — |

## S2 — Human-approval gate (design-level check)

| # | Action | Expected |
| --- | --- | --- |
| 1 | Read the created agent's Constraints/Decision Principles | `expect` an explicit statement that
  it never submits externally without human approval |
| 2 | If the routine is reachable (S1.3 succeeded), `note` where in its state graph the approval
  pause sits (UI approval vs. Slack, per the chat's own description) | Otherwise `note` that the
  approval step is undiscoverable, same root cause as S1.3 |
| 3 | `capture` screenshot | — |

## Notes for the runner

- This story is explicitly open-ended per the operator's brief — the point is whether Routine + Agent
  + Resource + human-in-loop composes at all, not pixel-perfect UI coverage.
- File missing-primitive gaps (PDF form-filling, external calendar triggers) as `enhancement`, not
  `bug` — they are known-absent capabilities, not defects.
