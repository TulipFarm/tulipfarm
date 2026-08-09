---
id: soul-git-operations
area: Soul Repository
suites: [smoke, full]
routes: ["/settings/soul"]
preconditions: [signed-in session]
blast_radius: read-only repository inspection; never clicks "Sync now" or submits remote URL forms
est_minutes: 10
smoke_scenarios: [S1]
---

# Soul Repository Sync & Artifact File Lifecycle

The Soul Repository surface at `/settings/soul` (backed by `@tulipfarm/soul` and the local `soul/` Git repository) manages Git synchronization, remote repository connections, commit history, and artifact file trees (`agents`, `skills`, `routines`, `resources`, `integrations`).

Every scenario stands alone — a failure in one does not block the next.

## S1 — Soul status, remote connection, and sync indicators

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/soul` | Page loads within 5s; heading `Soul` |
| 2 | `expect` Git status panel renders showing current status badge (`Up to date`, `N ahead / M behind`, `Not connected`, or `Sync failed`) | Status badge visible |
| 3 | If remote is configured, `expect` remote URL, last synced timestamp, and action buttons (`Sync now`, `Edit`) | Remote details present |
| 4 | **Do not click "Sync now".** | Avoid triggering live Git sync calls |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S2 — Soul file tree & artifact inspector

| # | Action | Expected |
| --- | --- | --- |
| 1 | Inspect two-pane tree viewer on `/settings/soul` | File tree renders listing `soul/` directories: `agents/`, `skills/`, `routines/`, `resources/`, `integrations/`, `soul.yaml` |
| 2 | `click` `soul.yaml` in file tree | Content viewer loads `soul.yaml` YAML text read-only |
| 3 | `click` an agent file in `agents/` | System prompt and frontmatter render in content viewer |
| 4 | `expect` content viewer renders read-only; no inline edit inputs on this page (all writes go through Chat / specialized forms) | Read-only viewer verified |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S3 — Git commit history & sync log viewer

| # | Action | Expected |
| --- | --- | --- |
| 1 | Locate **Commit History / Sync Logs** section | Displays recent Git commits made to the `soul/` repository |
| 2 | `expect` commit rows show commit hash, author, message (e.g. `feat(agent): update prompt via agent_update`), and relative timestamp | Commit history rendered |
| 3 | `click` a commit row | View commit diff summary showing modified files |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S4 — Security & write-protection check

| # | Action | Expected |
| --- | --- | --- |
| 1 | `click` `Edit` on remote configuration (if remote is set) | Remote form opens |
| 2 | `expect` Remote URL field is pre-filled, and credential input field is blank (write-only) | Credential masked |
| 3 | **Do not submit the form.** `click` `Cancel` to dismiss form | Dismissed cleanly |
| 4 | `expect` no remote write or sync request fired | Clean security check |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S5 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through file tree, commit rows, and status actions | Focus rings visible on all elements |
| 2 | Toggle between Light and Dark themes | Status badges, Git commit hashes, and file tree text remain legible |
| 3 | Resize viewport to 375px mobile width | File tree and content pane stack cleanly without page overflow |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- Read-only inspection: do not click "Sync now" or alter remote URL settings.
- All artifact creation/editing must go through product UI or Chat, never direct filesystem writes.
