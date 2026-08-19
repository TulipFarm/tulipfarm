---
id: journey-new-hire-onboarding
area: Journeys
suites: [journeys]
routes: ["/", "/resources/:type", "/routines", "/business/soul"]
preconditions: signed-in session
blast_radius: creates a qa-journeys-s6-* Resource type, one sample record, and an (unpublished)
  Routine, left in place
est_minutes: 15
smoke_scenarios: []
---

# Journey: HR new-hire onboarding checklist (generated story)

Analogous to the compliance-sheet story but exercising a **triggered** (on-record-create) Routine
with a human-confirm-each-step gate, rather than a scheduled one. A small agency wants: create a
`new-hire` record -> Routine walks welcome-doc / IT-provisioning / manager-intro steps -> pauses for a
human to confirm each actually happened, rather than assuming completion.

## S1 — Build and trigger

| # | Action | Expected |
| --- | --- | --- |
| 1 | In chat, ask for the resource type, the on-create Routine with human-confirm gates per step, one
  sample record, and to actually trigger the routine | `wait-until` terminal turn (max 120s) |
| 2 | `navigate /routines` | `expect` the routine listed — **known gap**, same as
  `journey-compliance-sheets.md`: `routine_forge`-created routines are frequently invisible here
  (#406). If reproduced, comment on #406 rather than filing again |
| 3 | `navigate /resources/qa-journeys-s6-new-hire` | `expect` the sample record exists regardless of
  the routine outcome |
| 4 | `navigate /business/soul` | `note` whether a git remote is configured — this run found none
  configured on staging, and the chat's own final message attributed the routine's
  `unpublished_definition` state to `soul_repo_push` no-op'ing with no remote. If a remote genuinely
  isn't configured, treat the routine-invisibility finding as **possibly environment-specific**
  rather than purely product code, and say so explicitly rather than re-filing |
| 5 | `capture` screenshot, console delta | — |

## Notes for the runner

- This journey is a lighter-weight duplicate probe for issue #406 (routine create/publish
  discoverability), run against a *triggered* rather than *scheduled* routine to check the bug isn't
  schedule-type-specific. It reproduced identically.
- New root-cause lead surfaced here, not previously in #406: `soul_repo_push` returned `pushed:
  false` because `/business/soul` shows no git remote configured on this staging tenant — flagged as
  a comment on #406 for the maintainer to confirm or rule out.
