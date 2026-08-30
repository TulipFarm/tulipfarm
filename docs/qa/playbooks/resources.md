---
id: resources
area: Resources
suites: [smoke, full]
routes: ["/resources", "/resources/:type", "/resources/:type/new", "/resources/:type/:id",
  "/resources/:type/:id/edit", "/resources/:type/schema", "/resources/new"]
preconditions: []
blast_radius: creates and fully manages qa-<run-id>-* resource types and records; the qa-<run-id>-*
  type this run creates is deliberately left in place (not deleted) as a fixture the Agents/Skills/
  Routines playbooks reference; pre-existing types and records are read-only — never edited or
  deleted, including qa-* artifacts from earlier runs; this playbook never clicks a control that
  triggers a native browser confirm() dialog
est_minutes: 12
smoke_scenarios: [S1, S3]
---

# Resources

Resources is the schema-driven CRUD surface: a JSON Schema a resource type ships (`schema.yml` in
soul, edited here as YAML text) drives a zero-per-resource-code list, detail, create, and edit UI
(`apps/web/app/lib/schema.ts`). Resource **types** are themselves Soul artifacts — created only
through `/resources/new`'s wizard or by hand-editing the generated schema at `/resources/:type/schema`,
both product surfaces, never through a direct write to the runtime `soul/` repo.

Every scenario stands alone — a failure in one does not block the next. S3 in particular must not
assume S2 has already run: in a smoke-only invocation it hasn't, so S3 falls back to any pre-existing
type and stays entirely read-only.

**Cross-cutting a11y note, checked once here instead of once per scenario:** `PageShell` — the
shared frame for every route in this file — renders a breadcrumb `nav` (`aria-label="Breadcrumb"`)
and exactly one `<h1>` from its `title`, with the last crumb dropped because that crumb *is* the
title. Every scenario below asserts "exactly one `h1`, no skipped level" per convention, and it
should now **pass** on every page in this section. A page with zero `h1`, or with a second one
inside the content, is a regression in the shell — report it once for the area, not per scenario.

## S1 — Resource type list and empty state

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /resources` | Breadcrumb `resources` renders within 5s |
| 2 | `expect` exactly one `h1` on the page | See the cross-cutting note above — record once, don't re-file |
| 3 | If at least one type exists: `expect` a count line "`N` types" (or "1 type"), a `+ New type` link, and a list where each row shows the type name, a "`N` fields" (or "1 field") count, and a `hooks` pill **only** on types with a hooks.ts | Present |
| 4 | If zero types exist: `expect` the text "No resource types defined yet. Create one here, or ask the assistant to build one in chat." and a `+ New type` link — this is a literal inline empty state, not the shared `EmptyState` component used elsewhere in the app | Present |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S2 — Create a resource type through the UI: field types, validation, the generated schema

Creates `qa-<run-id>-widget`. This type is **not deleted** by this or any later scenario — it is
the fixture the Agents/Skills/Routines playbooks reference.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /resources`, `click` `+ New type` | `/resources/new` renders within 5s: fields `type name * (singular, kebab-case)` and `description`, one field row (`field 1 name`, `field 1 type` defaulted to `text`, `field 1 required`, `remove field 1`), `+ add field`, and `Create type` / `Cancel` |
| 2 | Leave `type name` blank, `click` `Create type` | Inline "error: Type name must be lowercase kebab-case (e.g. support-ticket)." — no request fires |
| 3 | `type` `type name` `QA_Bad_Name` (uppercase), `click` `Create type` | Same kebab-case error — the regex rejects case as well as blanks |
| 4 | `type` `type name` `qa-<run-id>-widget`, leave `field 1 name` blank, `click` `Create type` | Inline "error: Add at least one field." — a name-only field row doesn't count |
| 5 | Fill `field 1 name` `title`, check `field 1 required`. `click` `+ add field` six times and fill: `count`→number, `qty`→integer, `active`→boolean, `dueDate`→date, `startsAt`→datetime, `status`→enum with `field N choices` = `open, closed, done` (check `field N required` on `status` too) | Each row accepts its value; the choices input only appears for the `status` row |
| 6 | `expect` the `field N type` select offers exactly: text, number, integer, boolean, date, datetime, "enum (choices)" | No array, object, or relation (x-links) option — the wizard's ceiling. Covered by hand-editing the schema, next |
| 7 | `note` `number` and `integer` render and behave identically in this UI (both become a plain HTML number input; only the generated schema's `type` differs) — not a bug, just a UI/schema granularity mismatch worth knowing before reading "each field type" results later | Recorded |
| 8 | `click` `Create type` | Button reads "Creating…", then `wait-until` navigated to `/resources/qa-<run-id>-widget` (max 10s, form-submit budget) |
| 9 | `expect` the new type's list page shows "0 results" and toolbar buttons `New qa-<run-id>-widget`, `Edit type`, `Delete type` | Present |
| 10 | `click` `Edit type` | `/resources/qa-<run-id>-widget/schema` renders within 5s: a `schema` textarea pre-filled with the **exact** JSON Schema generated from step 5 — properties for all seven fields, `required: [title, status]`, `additionalProperties: false`. There is no separate live-preview panel in the wizard itself; this route, visited immediately after creation, **is** the schema preview |
| 11 | Hand-edit the textarea to add three more properties: `relatedTo` with `x-links: { target: <an existing type from S1's list> }` (if S1 found none, `note` and skip only this sub-field — reading another type's records for the combobox is fine, this repo has none to link to yet), `tags` (`type: array`), `metadata` (`type: object`). `click` `Save schema` | Button reads "Saving…", then `wait-until` navigated back to the list page (max 10s) |
| 12 | `capture` screenshot, console delta, failed requests | — |

## S3 — Per-type record list: search, filter, sort, pagination, empty state

Standalone — use `qa-<run-id>-widget` if S2 already ran this session, otherwise pick any type from
S1's list. This scenario is entirely read-only regardless of which type is used.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /resources/<type>` | Breadcrumb `resources / <type>`; toolbar `New <type>`, `Edit type`, `Delete type` within 5s |
| 2 | If zero records: `expect` "0 results" and no table | Terminal empty state, not a skip |
| 3 | If records exist: `expect` a `filter records` search input and a table with sortable column headers (`aria-sort` present on the active one) | Present |
| 4 | `type` `filter records` with text matching nothing | "0 results" replaces the table |
| 5 | `expect` this is the identical "0 results" copy as the true-empty state in step 2 | `note` (P3): a filtered-to-zero result and a genuinely-empty type are visually and textually indistinguishable — no differentiating hint like "no matches for …" |
| 6 | Clear the filter | Table reappears; the count line reads "`N` of `M`" while filtered, "`N` results" when not |
| 7 | `click` a sortable column header by its name | `aria-sort="ascending"`, rows reorder; click again → `"descending"` |
| 8 | If more than 25 records are loaded: `expect` `prev`/`next` buttons and "page `X` of `Y`" | Present; `prev` disabled on page 1, `next` disabled on the last page |
| 9 | If a next server page exists: `expect` a `Load more` button (reads `loading…` and is disabled mid-fetch) | `wait-until` settled (max 10s) |
| 10 | `note` filter/sort/pagination-within-a-page all operate only on records already fetched into the client — a query that would match a record on an unloaded page returns nothing until `Load more` brings it in | Recorded |
| 11 | `capture` screenshot, console delta, failed requests | — |

## S4 — Create a record: required-field validation, every field kind, relation via link-combobox

Depends on `qa-<run-id>-widget` existing (S2).

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /resources/qa-<run-id>-widget`, `click` `New qa-<run-id>-widget` | Form renders: one control per non-system field in schema order — text (`title`), number (`count`, `qty`), checkbox (`active`), date/datetime inputs (`dueDate`, `startsAt`), a `status` select with a blank `—` option plus `open`/`closed`/`done`, JSON textareas (`tags`, `metadata`), and a `relatedTo` combobox (role `combobox`, placeholder `search <target>…`) if S2 added the link field. `title` and `status` show a trailing `*` |
| 2 | `click` `Create` with every field blank | `note`: the form has `noValidate` set, so the browser's native required-field UI never engages — validation is entirely server-driven. `wait-until` settled (max 10s) — a 422 maps an inline message onto `title` (the first required field) |
| 3 | `type` `title` `qa-<run-id>-first-record`, select `status` `open`, leave everything else blank, `click` `Create` | `wait-until` settled (max 10s) — succeeds: optional blanks are omitted from the payload, not sent as empty strings. Navigates to `/resources/qa-<run-id>-widget/<id>` (a server-assigned UUID — this type has no `x-id-strategy`) |
| 4 | Return to `New qa-<run-id>-widget`. Fill every kind this time: `title` `qa-<run-id>-full-record`, a `count` and `qty` number, check `active`, pick a `dueDate` and `startsAt`, select `status`, valid JSON in `tags` (e.g. `["a","b"]`) and `metadata` (e.g. `{"k":"v"}`) | Accepted |
| 5 | In `relatedTo`, `type` a query | `expect` a live-filtered dropdown of the target type's existing records, each row showing a label plus its id; `select` one |
| 6 | `expect` the same combobox with no query open shows up to the target type's first 50 loaded records, or "no `<target>` records" if it has none | Present |
| 7 | Break the `tags` JSON (delete a bracket), `click` `Create` | Inline "invalid JSON" under `tags`, submission blocked client-side — the one check this form performs itself |
| 8 | Fix the JSON, `click` `Create` | `wait-until` settled (max 10s) — navigates to the new record's detail page |
| 9 | `capture` screenshot, console delta, failed requests | — |

## S5 — Detail view

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate` to the `qa-<run-id>-full-record` detail page from S4 | Renders within 5s: a definition list of every schema field in declared order, then a `[system]`-labeled block (`id`, `version`, `createdAt`, `updatedAt`) |
| 2 | `expect` `deletedAt` is **absent** from the system block | Only shown when a record is soft-deleted |
| 3 | `expect` `active` renders as a `✓` glyph, and any blank optional field renders as `—` | Present |
| 4 | `expect` `tags`/`metadata` render inside a `<pre>` block as raw JSON | Present |
| 5 | `expect` `relatedTo` renders as a link labeled with the target record's display name — `recordLabel` resolves a `name`/`title`/`label`/`summary` field on the target, else its first non-system string field, else its id — not the raw UUID | `click` it → navigates to the target's own detail page (read-only visit only — do not edit or delete it there, even if it is `qa-*` from an earlier run) |
| 6 | `expect` `Edit` and `Delete` buttons are present and labeled | Present |
| 7 | `capture` screenshot, console delta, failed requests | — |

## S6 — Edit a record: persisted state

| # | Action | Expected |
| --- | --- | --- |
| 1 | From S5's detail page, `click` `Edit` | `/resources/qa-<run-id>-widget/<id>/edit` renders within 5s, pre-filled with current values. Any `x-immutable` field would render disabled with an "(immutable)" label — none in this fixture unless added by hand in S2 |
| 2 | `type` `title` `qa-<run-id>-full-record-edited`, change `status` | Accepted |
| 3 | `click` `Save` | Button reads "saving…", `wait-until` settled (max 10s) — navigates back to the detail page |
| 4 | `expect` the new values render immediately, no manual reload needed | Present — this is the persistence assertion |
| 5 | Reload the detail page (full navigation) | `wait-until` settled (max 5s) — the edited values survive a fresh `clientLoader` fetch, confirming the write, not just client state |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S7 — The schema view: preview, edit, cancel, invalid input

Revisits `/resources/qa-<run-id>-widget/schema` (already exercised functionally in S2) to check the
route's own mechanics in isolation.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /resources/qa-<run-id>-widget/schema` | Breadcrumb `resources / qa-<run-id>-widget / schema`; helper text "The full JSON Schema (YAML). Editing here is lossless — relationships (x-links), id strategy, and other extensions are preserved. id/createdAt/updatedAt/version are managed by the platform."; `schema` textarea pre-filled with the current schema |
| 2 | Make a trivial edit (e.g. tweak the `description` key), `click` `Cancel` | Navigates back to the type's list page; `note`: this is a plain link, not a dirty-state guard — a real accidental navigation away would silently discard edits too, worth knowing though not itself a finding |
| 3 | Return to the schema page, replace the whole textarea with syntactically broken YAML (e.g. an unmatched `{`) | Accepted as typed — no client-side syntax check |
| 4 | `click` `Save schema` | `wait-until` settled (max 10s) — inline "error: invalid YAML: …" (or the JSON-Schema-meta-validation equivalent), the page stays put, no crash |
| 5 | Restore valid YAML (the schema from step 1, unedited), `click` `Save schema` | `wait-until` settled (max 10s) — navigates to the list page |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S8 — Delete a record this run created

**This is the highest-risk scenario in the playbook — read it fully before running.**

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate` to a record this run created (e.g. `qa-<run-id>-first-record` from S4) | Renders within 5s; `Delete` button present and labeled |
| 2 | **Do not click `Delete` under automated browser control.** | Its handler calls `window.confirm(...)` synchronously — a native, unstyled browser dialog with no in-app equivalent to intercept. This playbook's global constraint forbids ever triggering it, since it freezes the automation tooling. Treat step 1 as the boundary of this scenario |
| 3 | `note`, for a human dry-run only | Accepting the native confirm sends `DELETE .../resources/<type>/<id>` with `If-Match: <version>`, removes the record from the list, and 404s its detail page afterward — a code-reviewed guarantee, not a QA-verified one under this playbook |
| 4 | `note` — candidate finding, P3, product-shape | This is the only destructive action in Resources (and the only one seen anywhere in this playbook set) that isn't an in-app confirmation — worth flagging to the operator as inconsistent with the rest of the design system, independent of the automation problem it also causes |
| 5 | `note` | `Delete type` on the type's list page has the identical `window.confirm` gate. It is never exercised on `qa-<run-id>-widget` regardless — that type is intentionally left in place as a fixture, so this constraint changes nothing there |

## S9 — Deep-link reload rehydration

| # | Action | Expected |
| --- | --- | --- |
| 1 | Take the URL of a record's detail page (e.g. `/resources/qa-<run-id>-widget/<id>`) | — |
| 2 | Reload directly (full navigation, not a client transition) | `wait-until` settled (max 5s) — identical field values and `[system]` block re-render from a fresh fetch |
| 3 | Reload `/resources/qa-<run-id>-widget/<id>/edit` directly | Form pre-fills from the reloaded record |
| 4 | Reload `/resources/qa-<run-id>-widget/schema` directly | Textarea pre-fills from the reloaded schema |
| 5 | Reload `/resources/qa-<run-id>-widget` (the list) directly | Columns and rows re-render from a fresh fetch |
| 6 | `capture` console delta and failed requests for all four | — |

## S10 — Unknown type / unknown id → friendly 404, not a crash

The routes in this file do **not** all handle a 404 the same way — this scenario verifies each
route's actual behavior rather than assuming one uniform "friendly 404".

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /resources/qa-<run-id>-does-not-exist` (list route, type never created) | No crash. Renders the **generic** `ErrorState` frame: "error: 404 resource type not found: qa-<run-id>-does-not-exist" plus the fallback hint "The resource API could not be reached. Check that the API is running on :4010." |
| 2 | `note` (P3, copy/consistency) | The hint text in step 1 is written for a connectivity failure, not a not-found case — the API answered fine with a 404. It also doesn't match the friendlier "No record matches that id (it may have been deleted)." wording the detail/edit/schema routes use below, for the same underlying condition |
| 3 | `navigate /resources/qa-<run-id>-widget/qa-<run-id>-does-not-exist-id` (detail route, unknown id on a real type) | Renders the dedicated `NotFoundState`: "error: 404 not found" / "No record matches that id (it may have been deleted)." |
| 4 | `navigate` the same unknown id with `/edit` appended | Same `NotFoundState` — this route explicitly branches on `status === 404` |
| 5 | `navigate /resources/qa-<run-id>-does-not-exist/schema` (schema route, unknown type) | Same `NotFoundState` — also explicitly branches |
| 6 | `navigate /resources/qa-<run-id>-does-not-exist/new` (create-record route, unknown type) | Renders the **generic** `ErrorState`, same gap as step 1 — this route has no 404 branch either |
| 7 | `expect` no React error overlay and no blank white page on any of the five navigations above | The assertion throughout is "renders one of the two known states", never an unhandled crash |
| 8 | `capture` console delta and failed requests | — |

## S11 — Loading states

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /resources` and a record list/detail page, observing the moment before content paints | `note` whatever appears (a blank panel vs. a spinner) — SPA-mode `clientLoader` suspends the route until data resolves, so there may be no interstitial at all; either is acceptable as long as nothing sits in a permanent loading state |
| 2 | Open a record's create or edit form for a type with a relation field | The `LinkCombobox` fetches its target's first page on mount with **no loading affordance in the component** — no "loading…" text between mount and the options populating |
| 3 | `note` (P2, per the loading-state a11y convention) | A silent fetch window is indistinguishable from "this type genuinely has zero records" until it resolves — worth a visible pending state |
| 4 | On a paginated record list, `click` `Load more` | Button reads `loading…` and is disabled for the duration; `wait-until` settled (max 10s) |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S12 — Keyboard access, both themes, 375px

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through `/resources/new` | Order: `type name` → `description` → `field 1 name` → `field 1 type` → (`field 1 choices` if enum) → `field 1 required` → `remove field 1` → `+ add field` → `Create type` → `Cancel`, each with a visible focus ring |
| 2 | Tab through a record create form with a relation field present | Reaches the `relatedTo` combobox; `expect` its option list is operable by keyboard alone (Enter/Arrow), not mouse-only |
| 3 | `expect` (P2 if not true) | Source shows the combobox's options only handle `onMouseDown` — no `onKeyDown` for Enter/Arrow selection. If Tabbing into an open list provides no way to choose an option without a pointer, that is a keyboard-operability failure |
| 4 | On `/settings/auth` (or wherever the toggle lives in this session), record the current theme, `click` `Toggle dark mode` | Theme flips |
| 5 | Revisit `/resources`, `/resources/qa-<run-id>-widget`, a record detail page, and the schema textarea in the flipped theme | All text legible, including the `[system]` block and any disabled/immutable input |
| 6 | `click` `Toggle dark mode` again | Restored to the recorded baseline — a persisted preference on the operator's real session |
| 7 | Resize to 375px width | Breadcrumb, the `New <type>` / `Edit type` / `Delete type` toolbar (wraps rather than overflows), and the schema-driven table (scrolls inside its own container) all stay usable; no page-level horizontal scroll |
| 8 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- **Never click `Delete` (record) or `Delete type`.** Both call `window.confirm(...)` directly —
  the only native browser dialogs anywhere in this playbook set. S8 documents the intended behavior
  for a human dry-run but stops before triggering it under automation, per this playbook's global
  constraint. This is a real, reportable product-shape observation (P3), independent of the
  automation limitation it also causes.
- **`qa-<run-id>-widget` is a fixture, not scratch.** Do not delete it at the end of this run even
  though nothing stops you technically (deletion is blocked anyway, see above) — Agents, Skills, and
  Routines playbooks are written to reference it existing.
- **404 handling is inconsistent across this section's own routes**, not just against some external
  ideal: `/resources/:type` and `/resources/:type/new` fall through to the generic `ErrorState` on an
  unknown type, while `/resources/:type/:id`, `/resources/:type/:id/edit`, and `/resources/:type/schema`
  all branch explicitly to the friendlier `NotFoundState`. S10 is written to assert each route's
  *actual* behavior rather than assume uniformity — don't "fix" the expected column to make it
  consistent without confirming against the source first.
- **No page in this file renders an `<h1>`.** Recorded once, at S1, as a single P2 finding for the
  whole area rather than once per scenario — see the cross-cutting note at the top of this file.
- **The type-creation wizard cannot produce a link, array, or object field.** S2 covers this gap by
  hand-editing the generated schema at `/resources/:type/schema` immediately after creation — the
  same product surface `AGENTS.md` requires (never a direct `soul/` write), just its raw-YAML mode
  rather than the field-row wizard.
- **`LinkCombobox` only ever searches the target type's first loaded page** (its own source comment:
  "server-side search deferred"). If a relation's target type has more unindexed records than fit in
  one page, some will never appear in the picker — a known, not-yet-fixed limitation, not something
  to chase as a bug unless the operator wants it filed anyway.
- If S2 is skipped (smoke-only run), S4 through S9 have nothing to operate on and should be skipped
  with a `note` rather than failed — S1 and S3 (the smoke pair) are read-only and need no fixture.
