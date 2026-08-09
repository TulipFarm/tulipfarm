---
id: audit-compliance
area: Audit & Compliance
suites: [smoke, full]
routes: ["/settings/activities"]
preconditions: [signed-in session]
blast_radius: none — read-only audit log verification
est_minutes: 10
smoke_scenarios: [S1]
---

# Audit Log & Cryptographic Hash Chain Compliance

The Audit Log surface at `/settings/activities` (backed by `@tulipfarm/audit`) records tamper-evident, cryptographically hash-chained audit events across all system operations (Resources, Chats, Routines, Knowledge, Skills, Integrations, Auth, and Admin actions).

Every scenario stands alone — a failure in one does not block the next.

## S1 — Audit log activity feed and category filtering

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/activities` | Page loads within 5s; heading `Activities` |
| 2 | `expect` category filter chips render: `All`, `Resources`, `Chats`, `Routines`, `Knowledge`, `Skills`, `Integrations`, `Jobs`, `Soul` | Filter chips visible |
| 3 | `click` category chip `Resources` | Feed filters instantly to show resource-related audit events |
| 4 | `click` category chip `All` | Unfiltered feed restored |
| 5 | `expect` activity entries display timestamp, actor ID/email, action type, target entity, and status badge (e.g. `success`, `denied`, `failed`) | Entry attributes present |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S2 — Event detail inspection & cryptographic hash chain verification

| # | Action | Expected |
| --- | --- | --- |
| 1 | `click` any audit log entry row | Detail drawer/sheet opens |
| 2 | `expect` detail panel displays event ID, sequence number, actor principal, action payload JSON, and **Hash Chain Status** | Detail fields present |
| 3 | `expect` Hash Chain Verification badge displays `Verified (Chain Intact)` or SHA-256 seal status | Tamper-evident seal verified |
| 4 | Close detail panel with `Escape` or Close button | Panel closes; focus returns to triggered row |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S3 — Export audit events and pagination

| # | Action | Expected |
| --- | --- | --- |
| 1 | `click` `Export audit log` (if present) | Options for JSON or CSV format appear |
| 2 | Select JSON export | Browser triggers file download or displays export modal; no 500 error |
| 3 | If `Load more` button exists, `click` it | Additional historical audit records load |
| 4 | `expect` pagination maintains chronological order without duplicate sequence numbers | Clean pagination |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S4 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through category chips and audit rows | Keyboard focus rings visible on every interactive element |
| 2 | Toggle between Light and Dark themes | Status badges, timestamps, and JSON code blocks remain legible |
| 3 | Resize viewport to 375px mobile width | Category chips wrap; feed rows scale cleanly without page overflow |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- Audit logs are append-only and immutable by design.
- Verify hash chain integrity badges to ensure tamper-evident seal contracts hold.
