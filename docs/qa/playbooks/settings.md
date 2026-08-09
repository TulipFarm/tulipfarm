---
id: settings
area: Settings
suites: [smoke, full]
routes:
  ["/settings/llm", "/settings/secrets", "/settings/security", "/settings/observability",
  "/settings/soul", "/settings/activities", "/settings/memory", "/settings/about"]
preconditions: [restore-after required on any change]
blast_radius: full CRUD only on qa-<run-id>-* secrets and qa-<run-id>-* memory assertions this run
  creates; every other setting is read, then any prior value touched is recorded and restored in the
  same scenario; never rotates the encryption key, never edits or deletes a pre-existing secret or
  token, never enters a real credential anywhere, never clicks "Sync now" or submits the soul
  git-remote form, never breaks the live LLM provider config
est_minutes: 15
smoke_scenarios: [S1, S8]
---

# Settings

Settings is the **only playbook allowed to mutate configuration**, and it runs late in `full` for
exactly that reason. Every scenario that changes a setting records the prior value before touching
it and restores it immediately afterward, inside that same scenario — never deferred to a cleanup
step at the end of the file. A restore that fails to reflect in the UI is a **P0**, reported to the
operator immediately, not folded into the run's end-of-run findings batch.

Two things make this playbook stricter than the others: it is the one place secrets and provider
credentials appear in the UI at all (masking failures here are P0 by definition), and several of
its controls perform a real, hard-to-undo side effect outside the app's own database — a live git
sync against whatever remote is configured. Those controls are called out explicitly below and are
never exercised beyond field-level inspection.

## Reality check

Verified against source before writing any scenario below — not assumed from the route list.

**All eight routes share one shell and one heading.** `_app.settings.tsx` renders
`<h1>{active.label}</h1>` once, inside a `<header>`, and every `/settings/*` child route renders
into its `<Outlet />`. Unlike the sibling Auth/Resources playbooks (which found no `<h1>` at all on
their routes), **every Settings route has exactly one `<h1>`** — text is the active section label
("LLM", "Secrets", "Security", "Observability", "Soul", "Activities", "Memory", "About"). Panel-level
subheadings inside a page (e.g. Observability's "Reliability", "Spend over time") are `<h2>`, so
heading order does not skip. Record this as a pass, not a gap — it would be wrong to copy the other
playbooks' finding here.

**Every endpoint the web layer calls is real, implemented, and registered in the normal dev boot.**
Traced each `apps/web/app/lib/{settings,observability,soul,activities,memory,system}.ts` call to its
Fastify route and confirmed both the route file defines it and `apps/api/src/app.ts` /
`apps/api/src/index.ts` register it unconditionally for a plain `pnpm dev` boot (memory, activity,
and observability services are all constructed without an opt-in flag). No dead endpoint calls, no
UI control pointing at a route that doesn't exist — this area does not have the "seven endpoints
`apps/api` never defines" problem found elsewhere in the app.

**`/settings/security` has no session list or API token UI — password change only.** The route
(`apps/web/app/routes/_app.settings.security.tsx`) renders exactly one form: current/new/confirm
password. This matches and reconfirms the gap already documented in `auth.md`'s "Notes for the
runner" (the API fully supports tokens/sessions — `apps/api/src/auth/routes/tokens.ts`,
`.../session.ts` — there is simply no product surface for them). S4 below tests only what exists;
it does not attempt a token create/revoke flow because there is no control to drive it from.

**No `window.confirm()` anywhere in this surface.** Secrets delete, Memory delete, and the Soul
git-config form all use the in-app `ConfirmModal` (native `<dialog>`, focus-trapped), not the
browser-native dialog. Unlike Resources' delete flows, no scenario here needs a "stop before the
native-confirm step" carve-out — every destructive control can be driven to completion or cancelled
from the DOM.

**P0 — every soul git route is missing authorization, not just under-documented.** Read
`apps/api/src/soul/routes.ts` directly (not just the web wrapper): **every route in the file uses
`preHandler: requireAuth` with no `requireAdmin` and no `actor.role` check anywhere in a handler
body** — `POST /commit` (line 34), `POST /push` (line 72), `GET /tree` (line 96), `GET /file` (line
129), `POST /reload` (line 179), `GET /git-config` (line 204), `POST /sync` (line 265), `PUT
/git-config` (line 291). The `PUT /git-config` handler body (lines 313–331) has no role gate, and its
response schema declares `400`/`401` but no `403` — the omission looks intentional, not accidental.

This is a **missing-authorization / privilege-escalation defect**, exploitable by any authenticated
user including a plain `member`, not merely a UI copy issue:

1. `PUT /api/v1/soul/git-config` with an attacker-controlled `remoteUrl` — the handler calls
   `patchSoulConfig`, optionally stores the attacker's credential via `secretsService.set`, then
   `gitSync.configureRemote(...)` and syncs immediately.
2. `POST /api/v1/soul/push` — pushes the entire soul repo (agents, skills, routines, resources,
   integrations config) to that attacker-controlled remote.

That chain is both **exfiltration of the whole soul repo** and a **destructive overwrite of the
org's real remote pointer**, reachable by the lowest-privilege authenticated role. This is a P0
finding for run #1 regardless of whether this playbook's live run happens to reproduce it — it is
already confirmed statically, see "Notes for the runner."

Separately, and much more minor: the web component
(`apps/web/app/components/soul/soul-git-config.tsx`) maps a 403 to "admin only — only admins can
change the git remote," but no code path can ever produce that 403 given the above — dead error
copy implying a protection that doesn't exist. Note this as its own **P3** (error-copy mismatch) if
observed; it is real but is a symptom, not the defect.

Because these routes can exfiltrate the soul repo and overwrite the operator's real git remote with
no rollback path once a sync or push has run, **S6 never clicks "Sync now" and never submits the
git-config form** — not out of role uncertainty, but because the exploit path above is real and
confirmed, and this playbook must not be the thing that triggers it.

**Admin-gating map** (confirmed by reading each route handler's `actor.role !== "admin"` check):

| Route | Read | Write |
| --- | --- | --- |
| `/api/v1/llm-providers`, `/provider-config`, `/llm-config`, `/resolve-spec`, `/model-options` | any authenticated user | `PUT /llm-config` — admin only |
| `/api/v1/secrets/status` | any authenticated user | `PUT`/`DELETE /secrets/:key` — admin only |
| `/api/v1/observability/*` (all four: summary, config, recent, trace) | **admin only** | no write endpoints exist |
| `/api/v1/soul/tree`, `/file`, `/git-config` (GET) | any authenticated user | `POST /sync`, `PUT /git-config` — **not admin-gated** (see above) |
| `/api/v1/activities` | any authenticated user | no write endpoints |
| `/api/v1/memory`, `/memory/pending` | any authenticated user | `PUT`/`DELETE /memory/:key`, `POST /memory/pending/:id` — any authenticated user |

If the run's signed-in session is not an admin: S5 (Observability) will 403 at the loader —
`expect` the `ErrorState` fallback (`section="settings"`), not a blank page, and note that its
copy is generic ("The resource API could not be reached...") rather than admin-specific — a
loader-level 403 and a down API currently render identically, worth a P3 finding if observed. S2's
Save and S3's provider-config edits will also 403; script both to expect the alert text "admin only
— only admins can change..." rather than skip, since a non-admin session can still read every page
in this playbook.

**Memory has no visible supersession UI.** `packages/memory/AGENTS.md`: "Edits supersede rather than
overwrite; forgetting keeps a tombstone, not text" is server-side behavior. The `/settings/memory`
page is a flat current-value list with no version history control. S9 verifies supersession
indirectly — edit a key and confirm the list still shows exactly one row for it, not two — rather
than walking through a history feature that isn't there.

## S1 — Settings shell, navigation, and per-page heading (smoke)

Signed-in tab, either role.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings` | Redirects to `/settings/secrets` within 5s |
| 2 | `expect` the sidebar's settings navigation (`aria-label="settings navigation"`) lists eight items: Secrets, Security, LLM, Observability, Soul, Activities, Memory, About | All present, in that order |
| 3 | For each of the eight `/settings/*` routes, `click` its nav item (or `navigate` directly) | Each loads within 5s; content replaces in the outlet without a full page reload |
| 4 | `expect` exactly one `h1` on each of the eight pages, text matching the active nav item's label | One `h1` each — see Reality check |
| 5 | `expect` no new console error on any of the eight navigations (baseline from preflight) | Clean |
| 6 | `capture` screenshot of each page, console delta, failed requests | — |

## S2 — `/settings/llm`: provider routing, tiered fallback chain, validation-only (no save)

Signed-in tab, admin session preferred (Save is admin-gated; a non-admin run still does steps 1–6).

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/llm` | Heading "LLM"; if any provider secret is configured, "Effort Presets" section renders four ModelProfile targets (labelled "Auto default ModelProfile", "Fast ModelProfile", "Balanced ModelProfile", "Thorough ModelProfile"); if `hasProviderChains`, a "Provider chains" section renders three fieldsets (Fast / Balanced / Thorough) | Renders within 5s |
| 2 | `expect`, for each configured provider row, the field labelled `<chain label> provider <n> api key ref` contains a short reference name (e.g. `anthropic-api-key`), **never** a value that looks like a raw key (long random token, `sk-`/`AKIA`-style prefix, etc.) | Reference-only — **P0 if a raw key value renders in any field or badge on this page** |
| 3 | `expect` each provider row shows spec badges (cost, context, capabilities) sourced from `resolveModelSpec`, and a "Provider Connection <name>" badge — no field on the page accepts or displays a secret value directly | Present |
| 4 | If no provider secret is configured, `expect` the banner "No provider secrets yet — add one in the Secrets tab to enable a provider here." | Present, no chain UI |
| 5 | `click` "+ Add provider to fallback chain" on one fieldset | A new row appears with an empty `provider` select and empty `model` field |
| 6 | Leave the new row's `model` field empty, `click` "Save" | Client-side validation error surfaces (no `PUT /api/v1/llm-config` fires) — `expect` the request log shows no new write to `/api/v1/llm-config` for this click |
| 7 | `click` "Remove" on the row added in step 5 to cancel out | Row removed, form matches its original loaded state |
| 8 | `expect` no unsaved-changes prompt blocks navigating away now that the form is back to its loaded state | Clean navigation |
| 9 | `capture` screenshot, console delta, failed requests | — |

**Never click Save with a genuinely modified, valid chain.** A successful save reloads the live LLM
service against whatever is in the form at that moment — the only way this playbook can guarantee it
never breaks the live provider config is to never complete a real write here. Step 6 exists
specifically because the validation error fires before any network call.

## S3 — `/settings/secrets`: masking, and full CRUD on one `qa-<run-id>-*` custom secret

Signed-in tab, admin session required for create/edit/delete (401/403 otherwise — see step 8).

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/secrets` | Heading "Secrets"; provider rows list (each with an "Edit"/"Delete" pair) plus a custom-secrets list |
| 2 | `expect` no secret **value** renders anywhere on initial load — provider fields that hold a secret role show blank inputs with helper text "leave blank to keep", not the stored value | Masked — **P0 if any existing secret value is visible in the DOM** |
| 3 | `click` "Edit" on any pre-existing provider row **without changing anything**, then `click` the row's collapse/"Close" toggle to back out | No `PUT` fires; row collapses; nothing altered on a secret this run did not create |
| 4 | In "Add a provider", select `secret provider` = "Custom…" | Fields `secret key` and `secret value` appear |
| 5 | `type` `secret key` = `qa-<run-id>-token`, `type` `secret value` = `qa-<run-id>-fake-value` (obviously fake — never a real credential), `click` "Save provider" | `wait-until` settled (max 10s, CRUD-write budget) — new custom-secret row `qa-<run-id>-token` appears |
| 6 | `click` "Edit" on the `qa-<run-id>-token` row, `expect` the value field renders **blank**, not the value just saved | Masked immediately after save, not only on reload |
| 7 | `type` a new value `qa-<run-id>-fake-value-2` into that field, `click` "Save provider" (or the row's save action) | `wait-until` settled (max 10s) — no error; reopening Edit again still shows blank |
| 8 | If the session is not admin, `expect` steps 5–7 instead surface the alert "admin only — only admins can change secrets" and no row is created — skip 6–7 with a `note` | 403, no mutation |
| 9 | `click` "Delete" on the `qa-<run-id>-token` row | `ConfirmModal` opens: title "Delete secrets", description `Remove all secrets for "qa-<run-id>-token"? This cannot be undone.` |
| 10 | `click` "Delete" in the modal | `wait-until` settled (max 10s) — row removed from the custom-secrets list |
| 11 | `expect` no other provider's rows changed during this scenario | Untouched |
| 12 | `capture` screenshot, console delta, failed requests | — |

Full CRUD in this scenario is scoped entirely to the `qa-<run-id>-token` secret this run creates.
Step 3 exists to prove the Edit affordance can be entered and exited on a real provider row without
mutating it — never save that row.

## S4 — `/settings/security`: password-change validation, never completion

Signed-in tab (operator's real session). **Read this scenario fully before running it — it is the
one place in this playbook closest to a real account-affecting action, per the pattern already
established in `auth.md` S6.**

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/security` | Heading "Security"; fields `current password`, `new password`, `confirm new password`; button "Change password" (disabled while any field is empty) |
| 2 | `expect` no session-list or API-token control exists on this page | Confirmed absence — see Reality check; this is expected, not a defect to report again here (already tracked via `auth.md`) |
| 3 | `type` any value into `current password`, **mismatched** values into `new password` / `confirm new password`, `click` "Change password" | Inline error "passwords do not match" — client-side, no API call |
| 4 | `type` a value into `current password` that is **not** the operator's real password (e.g. `qa-<run-id>-wrong-current`), a matching pair into `new password`/`confirm new password`, `click` "Change password" | `wait-until` settled (max 10s) — `role="alert"` "error: {message}" (401, current password rejected); no session change |
| 5 | `capture` screenshot, console delta, failed requests | — |

**Never** enter the operator's actual current password here, and never submit a valid current/new
pair — that call succeeds and rotates the real sign-in credential this whole run depends on, with no
undo available to this playbook. A success status appearing after step 4 (a deliberately wrong
current password) is **P0** — the API would not be verifying the current password.

## S5 — `/settings/observability`: metrics, reliability, trace redaction (read-only)

Signed-in tab, **admin session required** — all four endpoints 403 for a non-admin actor.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/observability` | Heading "Observability"; range buttons "24h"/"7d"/"30d"; metric cards "Spend", "Tokens", "Turns", "Unpriced calls" |
| 2 | If the session is not admin, `expect` the `ErrorState` fallback instead (per Reality check, its copy does not distinguish 403 from a down API — note this if seen), and **skip the rest of this scenario** with a `note` | 403 handled, no partial dashboard |
| 3 | `click` each range button in turn | Metric cards and charts update; `wait-until` settled (max 5s, page-render budget) each time |
| 4 | `expect` panels "Reliability" (Turn errors / Fallbacks / Tool errors / Step latency p95), "Spend over time", "Spend by agent", "By model", "Recent turns", "Grafana Cloud export" — each its own `<h2>` | Present |
| 5 | If "Spend over time" has no data in range, `expect` "No activity in this window yet." | Correct empty state, not a blank chart |
| 6 | In "By model", `expect` any "unpriced" cell carries a tooltip referencing `observability.config.yaml` rather than a silent `$0` | Present if any unpriced row exists |
| 7 | `click` a row in "Recent turns" | `Sheet` "Turn trace" opens; `wait-until` settled (max 5s) |
| 8 | **Redaction check**: `expect` trace entries show only structured metrics — tokens in/out, cost, duration, model name, tool name — and **no** raw prompt/response text, no secret values, no `api_key_ref` resolved to a real key, anywhere in the sheet | **P0 if any raw content, PII, or secret value is visible** — cross-reference the "Grafana Cloud export" panel's "Content capture: On/Off" row to know whether content-in-trace is even expected to be off by design |
| 9 | In "Grafana Cloud export", `expect` "OTLP metrics export is On/Off", endpoint, and config rows "Retention" / "Content capture" / "Spend alert" render **read-only** — no edit control on this page (config is authored in `soul/observability.config.yaml`, not editable here) | Confirmed no write control exists — this whole page has no mutating action, so no restore is needed for this scenario |
| 10 | `capture` screenshot, console delta, failed requests | — |

## S6 — `/settings/soul`: git status is read-only here — never sync, never reconfigure

Signed-in tab, either role. **Every control on this page that writes anything is off-limits for a
confirmed P0 reason, not a role-uncertainty one — see Reality check.** `POST /sync`, `PUT
/git-config`, and `POST /push` are unauthenticated-by-role (any `requireAuth`'d session, including
`member`) and chain into exfiltrating the soul repo to an attacker-controlled remote plus overwriting
the org's real remote pointer. This scenario exists to verify the read surface only.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/soul` | Heading "Soul"; git status panel and, below it, a two-pane tree/file viewer (or empty state "The soul repo is empty or not initialized.") |
| 2 | If a remote is configured, `expect` a status badge (one of: not connected / sync failed / up to date / "N ahead, M behind"), the remote URL, "last synced {date}" or "never synced", and buttons "Sync now" and "Edit" | Present |
| 3 | **Do not click "Sync now."** It calls `POST /api/v1/soul/sync` — a real `gitSync.syncNow()` against the operator's configured remote, reachable by any authenticated role (P0 missing-authz, see Reality check) | Assert its presence and label only |
| 4 | If no remote is configured, the "Connect a git remote" form is already expanded by default (fields `soul git remote url`, `soul git credential`, button "Save") | `expect` the fields and their placeholders render — **do not type into or submit this form** |
| 5 | If a remote is configured, `click` "Edit" to open the form, `expect` the remote URL field is pre-filled and the credential field is blank (write-only, never redisplayed) | Present |
| 6 | **Do not submit the edit form**, with real or fake values — `PUT /api/v1/soul/git-config` rewrites the remote, stores the credential, and syncs immediately, with no role check gating it (P0, see Reality check). `click` "Cancel" (only present when a remote is already configured) to back out; if no "Cancel" exists (no-remote case), simply navigate away without submitting | Form dismissed, nothing sent |
| 7 | In the tree pane, `click` into two or three files across different soul artifact kinds (e.g. an agent, a resource, `soul.yaml`) | File contents render read-only in the viewer; no edit affordance on this page |
| 8 | `capture` screenshot, console delta, failed requests | — |

This is the one scenario in the playbook where "read-only" is enforced by never touching two
specific controls, not by the absence of a write path. Neither is safe to exercise because both are
part of a confirmed exfiltration/overwrite exploit chain (see Reality check) — this is not a role- or
gating-uncertainty precaution, it is avoidance of a known P0.

## S7 — `/settings/activities`: feed, filtering, pagination (read-only)

Signed-in tab, either role.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/activities` | Heading "Activities"; category chips: All, Resources, Chats, Routines, Knowledge, Skills, Integrations, Jobs, Soul |
| 2 | If the account has no activity yet, `expect` "No activity yet." | Correct empty state |
| 3 | `click` a non-"All" category chip | List filters; URL reflects the selection (`nuqs`-synced) |
| 4 | `click` "All" to restore the unfiltered view | List returns to unfiltered — this is a URL/query-state change, not a setting, so no restore-after bookkeeping is needed beyond leaving the filter as found |
| 5 | `click` a list row | `Sheet` opens with a definition list: Action, Category, Actor, Target, Status, When, and optionally a `Details` JSON block |
| 6 | If a "Load more" button is present (a `cursor` exists), `click` it | Button reads "Loading…" while busy, then appends further rows; `wait-until` settled (max 5s) |
| 7 | `capture` screenshot, console delta, failed requests | — |

No control on this page writes anything — pure read/filter/paginate.

## S8 — `/settings/about`: version and update check (smoke)

Signed-in tab, either role.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/about` | Heading "About"; text "TulipFarm" and "Version {version}" |
| 2 | `wait-until` the update check resolves (max 5s) | Either "You are up to date." (with a check-circle icon) or "Version {latest} is available." |
| 3 | `click` "Check for updates" | Button reads "Checking…" with a spinning icon while busy, then resolves to one of the two states in step 2 |
| 4 | `expect` the footer text "Installation and update controls will live here when in-app updates are available." | Present — confirms no install/update action is actually offered yet, nothing to avoid clicking |
| 5 | `expect` exactly one `h1` ("About") | Present |
| 6 | `capture` screenshot, console delta, failed requests | — |

Nothing on this page mutates state; it is a smoke scenario purely for load/render health.

## S9 — `/settings/memory`: full CRUD on one `qa-<run-id>-*` assertion, supersession check

Signed-in tab, either role (memory read/write is not admin-gated).

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/memory` | Heading "Memory"; if any pending suggestions exist, "Suggested memories (N)" section renders above the saved list |
| 2 | `note` every pending suggestion's subject and statement — **never click "Keep suggested memory: …" or "Discard suggested memory: …"** on any of them; these are the operator's real inferred memories, not artifacts this run created, and resolving one is irreversible | Observed only, never resolved |
| 3 | If the saved list is empty, `expect` "No saved memories yet — add one above, or the assistant saves them as you chat." | Correct empty state |
| 4 | `type` `new memory key` = `qa-<run-id>-note`, `type` `new memory value` = `qa test value`, `click` "Set" | `wait-until` settled (max 10s) — new row `qa-<run-id>-note` appears, badge "you" (no `writtenByAgentId`) |
| 5 | Re-enter the same key `qa-<run-id>-note` in the add row and `click` "Set" again | Inline error `"qa-<run-id>-note" already exists — edit it in the list instead.` — no duplicate row, no API call |
| 6 | In the saved list, edit the `value for qa-<run-id>-note` field to `qa test value v2`, `click` "Save" on that row | `wait-until` settled (max 10s) — value updates |
| 7 | **Supersession check**: `expect` exactly one row for `qa-<run-id>-note` after step 6, not two | Server-side supersession (per `packages/memory/AGENTS.md`) does not surface as a second row or a visible history entry in this UI — this is the only observable signature of it here |
| 8 | `click` "Delete qa-<run-id>-note" | `ConfirmModal` opens: title "Delete memory", description `Forget "qa-<run-id>-note"? This cannot be undone.` |
| 9 | `click` "Delete" in the modal | `wait-until` settled (max 10s) — row removed |
| 10 | `expect` no pre-existing saved memory row was altered during this scenario | Untouched |
| 11 | `capture` screenshot, console delta, failed requests | — |

## S10 — Cross-cutting: unsaved changes, validation, loading states, both themes, 375px, keyboard

Signed-in tab.

| # | Action | Expected |
| --- | --- | --- |
| 1 | On `/settings/llm`, make a field-level change (e.g. add a fallback row per S2.5) without saving, then attempt to `navigate` to another settings tab | Either a native/in-app unsaved-changes prompt blocks the navigation, or the change is silently discarded — `note` which behavior is observed; silent discard of an in-progress edit is a P2 if no warning is given |
| 2 | Resize the viewport to 375px width on `/settings/secrets` and `/settings/memory` | Layout remains usable — no horizontal overflow, controls remain reachable and legible |
| 3 | Record the current theme, `click` "Toggle dark mode", `expect` all settings pages visited this run remain legible (labels, alerts, badges, code/tree view on `/settings/soul`) in the new theme, then `click` it again to restore the original theme | Restored — this is a persisted preference on the operator's real session |
| 4 | On `/settings/secrets`, Tab from the top of the "Add a provider" form | Order follows visual order: `secret provider` → (conditionally) `secret key` → `secret value` → "Save provider", each with a visible focus ring |
| 5 | Open the "Delete memory" `ConfirmModal` from S9.8 (or re-open a fresh one on a `qa-<run-id>-*` row) and Tab | Focus is trapped inside the dialog; Escape or "Cancel" closes it and returns focus to the triggering "Delete" button |
| 6 | `expect` every icon-only button encountered this run (modal Close `aria-label="Close"`, per-key "Delete {key}" buttons, theme toggle) has an accessible name — not just a visual icon | Present |
| 7 | `capture` screenshot at 375px for both themes on at least one page | — |

## Notes for the runner

- **Record-then-restore is not optional and not deferred.** Every scenario above that changes a
  setting (S3's provider-edit dry-run in step 3, S9's memory edit in step 6, S10's theme toggle in
  step 3) records the prior value as its own step and restores it before the scenario ends — not at
  the end of the file. If a restore step does not visibly take effect in the UI, stop and report a
  **P0** to the operator immediately; do not continue to the next scenario assuming it will resolve
  itself.
- **Never break the live LLM provider config.** S2 exists specifically to exercise the LLM settings
  form's validation and rendering without ever completing a save — no scenario in this playbook
  submits a modified provider chain, an effort-preset change, or anything else that would call
  `PUT /api/v1/llm-config` with real content. If the operator wants that save path verified, it needs
  a disposable non-production LLM config to test against, outside this playbook's blast radius.
- **Plaintext-secret checks are load-bearing, not optional flourishes.** S2 step 2 (LLM api-key-ref
  fields), S3 steps 2/6/7 (Secrets masking), and S5 step 8 (Observability trace redaction) are each
  written as an explicit `expect` with a stated P0 consequence — treat a failure on any of them as
  the single highest-priority finding of the run, ahead of anything else observed.
- **`/settings/soul`'s "Sync now" button and its git-config form are permanently off-limits** in
  this playbook, not just in S6 — if a later scenario's `note` step surfaces a reason to want a live
  sync (e.g. confirming a status badge updates), do not click it. Neither is admin-gated at the API
  layer (see Reality check), so there is no role-based safety net stopping an accidental click either.
- No control anywhere in this playbook triggers a native `window.confirm()` — every destructive
  action goes through the in-app `ConfirmModal`, so no scenario needs a "stop before this because it
  can't be cancelled from the DOM" carve-out the way Resources' delete flows do.
- The `/settings/security` session/token gap is documented once, authoritatively, in `auth.md`'s
  "Notes for the runner." S4 here re-confirms the absence but does not duplicate that finding as a
  new one — if a session/token UI ships later, extend both playbooks' relevant scenario rather than
  adding new ones.
