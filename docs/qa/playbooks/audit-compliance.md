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

# Activity Audit Feed

The Activity surface in Operate at `/business/activities` is one merged timeline: the activity log
(Records, Chats, Routines, Knowledge, Skills, Integrations, Auth, admin actions) interleaved with
Run executions. `/runs` redirects here; `/runs/:id` is still the Run inspector.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Activity feed and source filtering

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/activities` | Page loads within 5s; heading `Activity` |
| 2 | `expect` source radio chips render: `Everything`, `Runs` (admin only), `Records`, `Chats`, `Routines`, `Knowledge`, `Skills`, `Integrations`, `Jobs`, `Soul` | Filter chips visible |
| 3 | `expect` Time range, Auto refresh, Per page, and Problems only controls render | Filter bar complete |
| 4 | `click` source chip `Records` | URL gains `?source=resource`; feed filters to Record events |
| 5 | `click` source chip `Everything` | Unfiltered feed restored; reload the URL and confirm the view survives |
| 6 | `expect` rows group under day headings and show a status badge, title, and timestamp | Entry attributes present |
| 7 | Set Time range to `Past hour`, then `All time` | URL gains `?range=`; the row count changes accordingly |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S2 — Activity detail inspection

| # | Action | Expected |
| --- | --- | --- |
| 1 | `click` any non-Run row | Detail sheet opens and the URL gains `?event=log:<id>` |
| 2 | `expect` detail panel displays a status badge, Action, Category, Actor, Target, Target id, and optional Recorded details JSON | Detail fields present |
| 3 | Reload the page on that URL | The same sheet reopens |
| 4 | `click` a Run row | Navigates to `/runs/:id`, not a sheet |
| 5 | Close detail panel with `Escape` or Close button | Panel closes; focus returns to triggered row |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S3 — Pagination, ranges, and auto refresh

| # | Action | Expected |
| --- | --- | --- |
| 1 | Confirm no export control is present on this page | Current UI is read/filter/paginate only |
| 2 | If `Load more` exists, `click` it | Older entries append; the footer count rises |
| 3 | `expect` pagination maintains newest-first order without duplicate visible rows | Clean pagination |
| 4 | Change `Per page` to 100 | URL gains `?size=100`; the feed re-reads from the top |
| 5 | Set `Auto refresh` to `Every 15s` | URL gains `?refresh=15`; the footer reports when it last checked |
| 6 | Visit `/business/activities?event=log:does-not-exist` | Page explains the entry is not in this view and offers to clear the filters |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S4 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through source chips, the selects, and the rows | Keyboard focus rings visible on every interactive element |
| 2 | Toggle between Light and Dark themes | Status text, timestamps, and Details JSON code blocks remain legible |
| 3 | Resize viewport to 375px mobile width | Chips and controls wrap at a 44px hit height; rows scale without page overflow |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- This page does not expose hash-chain verification badges or export controls in the current UI; do not invent those steps.
