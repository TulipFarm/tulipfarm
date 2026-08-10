---
id: audit-compliance
area: Audit & Compliance
suites: [smoke, full]
routes: ["/business/activities"]
preconditions: [signed-in session]
blast_radius: none — read-only audit log verification
est_minutes: 10
smoke_scenarios: [S1]
---

# Activities Audit Feed

The Activities surface in Operate → Work at `/business/activities` records activity across system
operations (Resources, Chats, Routines, Knowledge, Skills, Integrations, Auth, and admin actions).

Every scenario stands alone — a failure in one does not block the next.

## S1 — Activity feed and category filtering

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/activities` | Page loads within 5s; heading `Activities` |
| 2 | `expect` category filter chips render: `All`, `Resources`, `Chats`, `Routines`, `Knowledge`, `Skills`, `Integrations`, `Jobs`, `Soul` | Filter chips visible |
| 3 | `click` category chip `Resources` | Feed filters instantly to show resource-related audit events |
| 4 | `click` category chip `All` | Unfiltered feed restored |
| 5 | `expect` activity entries display summary, actor type, timestamp, and status when present | Entry attributes present |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S2 — Activity detail inspection

| # | Action | Expected |
| --- | --- | --- |
| 1 | `click` any activity row | Detail drawer/sheet opens |
| 2 | `expect` detail panel displays Action, Category, Actor, Target, Status, When, and optional Details JSON | Detail fields present |
| 3 | Close detail panel with `Escape` or Close button | Panel closes; focus returns to triggered row |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S3 — Pagination

| # | Action | Expected |
| --- | --- | --- |
| 1 | Confirm no export control is present on this page | Current UI is read/filter/paginate only |
| 2 | If `Load more` button exists, `click` it | Additional historical activity records append |
| 3 | `expect` pagination maintains chronological order without duplicate visible rows | Clean pagination |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S4 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through category chips and audit rows | Keyboard focus rings visible on every interactive element |
| 2 | Toggle between Light and Dark themes | Status text, timestamps, and Details JSON code blocks remain legible |
| 3 | Resize viewport to 375px mobile width | Category chips wrap; feed rows scale cleanly without page overflow |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- This page does not expose hash-chain verification badges or export controls in the current UI; do not invent those steps.
