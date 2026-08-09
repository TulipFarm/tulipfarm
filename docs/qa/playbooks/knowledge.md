---
id: knowledge
area: Knowledge
suites: [smoke, full]
routes: ["/knowledge", "/knowledge/spaces/*", "/knowledge/pages/*", "/knowledge/tags/:tag"]
preconditions: [signed-in session]
blast_radius: creates spaces and pages named qa-<run-id>-*; never edits or deletes spaces/pages it did not create
est_minutes: 12
smoke_scenarios: [S1]
---

# Knowledge

Knowledge is the product's Notion/Confluence-style wiki surface. Features space creation, hierarchical page tree rail, rich markdown page editor, tag organization, interactive graph view, and keyboard search command palette (`Cmd+K` / `Ctrl+K`).

Every scenario stands alone — a failure in one does not block the next.

## S1 — Landing page and empty state

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /knowledge` | Layout loads with tree rail on left and main content outlet on right |
| 2 | `expect` heading `Knowledge` or `Spaces` is present | Present, labeled |
| 3 | If no spaces exist, `expect` empty state message: "Pick a page from the tree on the left, or create a new space to start a wiki." with `New space` button | Empty state visible |
| 4 | If spaces exist, `expect` grid of spaces showing page count and relative timestamp, plus a `Recently edited` list | Space cards rendered |
| 5 | `expect` `New space` link/button is present and keyboard reachable | Present |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S2 — Space creation

| # | Action | Expected |
| --- | --- | --- |
| 1 | `click` `New space` (or `navigate /knowledge/spaces/new`) | Space creation form loads |
| 2 | `expect` fields `Name`, `Description`, and `Icon` (optional) are present | Form fields visible |
| 3 | `expect` `Create space` primary button is disabled while `Name` is empty | Validation holds |
| 4 | `type` `Name` `qa-<run-id>-space` | Name entered |
| 5 | `type` `Description` `qa-<run-id> test knowledge space for manual QA` | Description entered |
| 6 | `click` `Create space` | Form submits, `wait-until` navigated to `/knowledge/spaces/:id` (max 10s) |
| 7 | `expect` space header shows `qa-<run-id>-space` and the left tree rail reflects the new space | Space created |
| 8 | `capture` screenshot, console delta, failed requests | — |

## S3 — Page authoring and navigation

| # | Action | Expected |
| --- | --- | --- |
| 1 | On `/knowledge/spaces/:id`, `click` `New page` (or `+` icon on space rail) | Navigates to `/knowledge/spaces/:id/pages/new` |
| 2 | `expect` `Title` field and markdown content editor render | Form ready |
| 3 | `type` `Title` `qa-<run-id>-page-one` | Title entered |
| 4 | `type` content editor `# QA Heading\n\nThis is a test page with **bold** text and a [link](https://example.com).` | Content entered |
| 5 | `click` `Save page` (or `Publish`) | `wait-until` page renders in reader view at `/knowledge/pages/:pageId` (max 10s) |
| 6 | `expect` rendered page displays `# QA Heading`, bold text, link, and appears under `qa-<run-id>-space` in tree rail | Page persisted and rendered correctly |
| 7 | `click` the page link in the left tree rail | Navigation succeeds without full page reload |
| 8 | `capture` screenshot, console delta, failed requests | — |

## S4 — Tagging, Graph view, and Search Command Palette

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /knowledge/pages/:pageId/edit` for `qa-<run-id>-page-one` | Editor loads |
| 2 | `type` tags field `qa-tag-<run-id>` and submit tag | Tag pill added |
| 3 | Save page and navigate to `/knowledge/tags/qa-tag-<run-id>` | Tag page loads listing `qa-<run-id>-page-one` |
| 4 | `navigate /knowledge/spaces/:id/graph` | Interactive graph view renders with node for space and pages |
| 5 | `expect` graph canvas or SVG nodes render without console WebGL/canvas errors | Clean render |
| 6 | Trigger Command Palette (`Cmd+K` / `Ctrl+K` or search button) | Search modal opens with focus inside input |
| 7 | `type` search query `qa-<run-id>` | Instant search results list `qa-<run-id>-page-one` |
| 8 | Press `Escape` | Command Palette closes, returning focus to trigger element |
| 9 | `capture` screenshot, console delta, failed requests | — |

## S5 — Page editing and revision history

| # | Action | Expected |
| --- | --- | --- |
| 1 | On `/knowledge/pages/:pageId`, `click` `Edit` | Navigates to edit form |
| 2 | Append text `\n\nUpdated by QA run id qa-<run-id>` to content | Content modified |
| 3 | `click` `Save page` | Page updates; new text visible in reader view |
| 4 | `expect` `updatedAt` timestamp updates to "just now" | Relative time updated |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S6 — Cleanup of test data

| # | Action | Expected |
| --- | --- | --- |
| 1 | On `qa-<run-id>-space` space view (`/knowledge/spaces/:id`), open space actions menu | Menu opens |
| 2 | `click` `Delete space` (or `Delete page` for created pages) | Confirmation modal opens |
| 3 | `click` `Confirm delete` | `wait-until` space/page is deleted and user redirected to `/knowledge` (max 10s) |
| 4 | `expect` `qa-<run-id>-space` no longer appears in the left tree rail or spaces grid | Successfully deleted |
| 5 | `expect` no errors in console or network tab during deletion | Clean deletion |

## S7 — Accessibility, themes, and responsiveness

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through space view and tree rail | Focus ring visible on space links, page items, and action buttons |
| 2 | `expect` heading hierarchy has exactly one `h1` per page | Semantic HTML valid |
| 3 | Toggle theme between Light and Dark | Tree rail, editor, markdown output, and graph stay legible |
| 4 | Resize window to 375px mobile width | Tree rail collapses or stacks above content without horizontal overflow |
| 5 | `capture` console delta and failed requests for entire playbook | Baseline check clean |

## Notes for the runner

- Only edit or delete spaces and pages prefixed with `qa-<run-id>-`.
- Never touch pre-existing documentation spaces or root team wikis.
- If graph view uses canvas/SVG, confirm no uncaught exceptions are thrown during rendering.
