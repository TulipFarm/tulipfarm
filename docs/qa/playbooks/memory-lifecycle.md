---
id: memory-lifecycle
area: Memory Engine
suites: [smoke, full]
routes: ["/settings/memory"]
preconditions: [signed-in session]
blast_radius: full CRUD only on qa-<run-id>-* memory assertions created this run; never deletes or modifies pre-existing memories
est_minutes: 10
smoke_scenarios: [S1]
---

# Scoped Memory Lifecycle & Supersession

The Memory Engine (`/settings/memory`, backed by `@tulipfarm/memory`) manages durable, versioned facts across chat turns and runs. Features scoped assertions (`user_private`, `agent_private`, `team_role`, `business`), trust tiers (`user_stated`, `agent_inferred`), memory types (`fact`, `preference`, `procedural`), contradiction resolution, valid-time intervals, procedural corrections, and pending memory extraction review.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Memory list and scope navigation

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/memory` | Page loads within 5s; heading `Memory` |
| 2 | `expect` sections for `Saved Memories` and, if suggestions exist, `Suggested Memories (Pending)` | Sections visible |
| 3 | `expect` each saved memory row displays key/subject, value/statement, scope badge (e.g. `user_private`, `agent_private`), trust tier badge (`user_stated` / `agent_inferred`), and action buttons (`Edit`, `Delete`) | Memory metadata rendered |
| 4 | If list is empty, `expect` empty state message "No saved memories yet — add one above, or the assistant saves them as you chat." | Empty state rendered |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S2 — Adding, updating, and superseding a qa-<run-id>-* assertion

| # | Action | Expected |
| --- | --- | --- |
| 1 | In the "Add Memory" form, `type` `Key` `qa-<run-id>-pref`, `type` `Value` `User prefers dark theme and bullet points` | Form filled |
| 2 | `click` `Set` (or `Save`) | `wait-until` settled (max 10s); new row `qa-<run-id>-pref` appears in list |
| 3 | `expect` badge shows Trust Tier `user_stated` and scope `user_private` | Attributes verified |
| 4 | Edit `qa-<run-id>-pref` value to `User prefers dark theme, bullet points, and concise code` and save | Value updates in list |
| 5 | **Supersession Check**: `expect` exact single row remains for `qa-<run-id>-pref` (server-side valid-time interval updated, old version tombstoned) | Single row rendered |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S3 — Pending memory suggestions & procedural corrections

| # | Action | Expected |
| --- | --- | --- |
| 1 | Inspect **Suggested Memories (Pending)** section if present | Shows agent-inferred candidate memories awaiting user review |
| 2 | `expect` each suggested memory card displays `Suggested Fact`, `Inferred From (Turn / Source)`, `Confidence Score`, and actions `Keep` / `Discard` | Suggestion details rendered |
| 3 | `note` pre-existing suggestions — do not click `Keep` or `Discard` on operator suggestions | Observed only |
| 4 | In Chat (`/`), send procedural correction: `qa-<run-id> remember to always write code comments in English` | Turn completes |
| 5 | `navigate /settings/memory` | `expect` new procedural correction appears with `type: procedural` |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S4 — Deletion & Forget vs. Erase audit trail

| # | Action | Expected |
| --- | --- | --- |
| 1 | `click` `Delete` (or `Forget`) on `qa-<run-id>-pref` | `ConfirmModal` opens: "Delete Memory: Forget 'qa-<run-id>-pref'? This cannot be undone." |
| 2 | `click` `Delete` in modal | `wait-until` settled (max 10s); row removed from UI |
| 3 | `expect` no pre-existing saved memories were modified or deleted | Data isolation maintained |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S5 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through memory forms, key inputs, and action buttons | Focus rings visible on all elements |
| 2 | Toggle between Light and Dark themes | Memory statement text, trust badges, and code snippets remain legible |
| 3 | Resize viewport to 375px mobile width | Form fields and memory rows scale without page body overflow |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- Full CRUD is restricted strictly to `qa-<run-id>-*` memory assertions created during the run.
- Do not keep or discard pre-existing operator pending memory suggestions.
