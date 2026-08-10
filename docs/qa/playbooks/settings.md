---
id: settings
area: Settings and business configuration
suites: [smoke, full]
routes:
  ["/settings/profile", "/settings/appearance", "/settings/auth", "/settings/memory",
  "/business/profile", "/business/models", "/business/secrets", "/business/soul",
  "/business/activities", "/business/observability", "/business/guardrails",
  "/business/people", "/business/about"]
preconditions: [restore-after required on any change]
blast_radius: full CRUD only on qa-<run-id>-* secrets, tokens, and memory assertions this run
  creates; every other setting is read, then any prior value touched is recorded and restored in the
  same scenario; never enters a real credential anywhere, never clicks "Sync now" or submits the
  Soul git-remote form, never breaks the live model routing config
est_minutes: 15
smoke_scenarios: [S1, S8]
---

# Settings and business configuration

Settings is now strictly **personal**: Profile, Appearance, Auth, and Memory. Business-wide
configuration lives in **Operate** under the Work, Health, and Business groups. This playbook still
runs late in `full` because it is allowed to mutate a small number of owned QA artifacts, and every
scenario that changes a value restores or deletes it immediately inside that scenario.

## Reality check

Verified against the current routes and `apps/web/app/lib/nav.ts` before authoring these steps.

- Personal Settings contains `/settings/profile`, `/settings/appearance`, `/settings/auth`, and
  `/settings/memory`. `/settings` redirects to `/settings/profile`.
- Operate > Work contains Inbox, Runs, and Business Activities (`/business/activities`). Operate >
  Health contains Operations and Observability (`/business/observability`, admin-only read).
  Operate > Business contains Business profile, Models, Secrets, Integrations, Soul, Guardrails,
  People (admin-only read), and About.
- The retired business routes still redirect, but testers should use the new destinations so the
  script matches what is visible on screen.
- Non-admins can read write-gated business configuration in a read-only state. People and
  Observability are the only admin-only reads; a member sees "Only an admin can manage people." or
  "Only an admin can see observability." if they open those URLs directly, and the sidebar hides
  those links.
- Models is organized around effort presets: Auto, Fast, Balanced, and Thorough. The legacy wire
  aliases are intentionally not user-facing.

## S1 — Personal Settings and Operate navigation shell (smoke)

Signed-in tab, either role.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings` | Redirects to `/settings/profile` within 5s |
| 2 | Inspect the Settings sidebar | Personal items appear: Profile, Appearance, Auth, Memory |
| 3 | Click Profile, Appearance, Auth, and Memory | Each loads within 5s with exactly one `h1` matching the item label |
| 4 | Switch to Operate and inspect groups | Work, Health, and Business headings appear; Business contains Business profile, Models, Secrets, Integrations, Soul, Guardrails, People (admin only), About |
| 5 | Navigate to `/business/profile`, `/business/models`, `/business/secrets`, `/business/soul`, `/business/activities`, `/business/guardrails`, and `/business/about` | Each loads within 5s with one matching `h1` |
| 6 | If admin, also navigate to `/business/people` and `/business/observability`; if member, open each URL directly | Admin sees the page; member sees the explicit admin-only message |
| 7 | `capture` screenshot of Settings and Operate sidebars, console delta, failed requests | — |

## S2 — `/settings/profile` and `/settings/appearance`: personal settings only

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/profile` | Heading "Profile"; panels "Display name" and "Account" render |
| 2 | `expect` field labels `Name`, `Email`, `Role`, `Status`, and `User ID` | Account fields are read-only; only display name is editable |
| 3 | Record the current display name, type `qa-<run-id> tester`, `click` `Save` | Status "Display name updated." appears and the sidebar account chip updates |
| 4 | Restore the recorded display name and `click` `Save` | Original value restored before leaving the scenario |
| 5 | `navigate /settings/appearance` | Heading "Appearance"; Theme choices System, Light, Dark render |
| 6 | Record the current theme, select the other palette, then restore the recorded option | Theme changes immediately and is restored; no Save button is expected |
| 7 | `capture` screenshot, console delta, failed requests | — |

## S3 — `/settings/auth`: password validation and API tokens

Signed-in tab. Never enter the operator's real current password.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/auth` | Heading "Auth"; panels "Password" and "API tokens" render |
| 2 | `expect` password fields `Current password`, `New password`, `Confirm new password`; button `Change password` disabled until all fields are valid | Present |
| 3 | Type any current password and mismatched new/confirm values | Inline error "These do not match." appears and no API call fires |
| 4 | Type `qa-<run-id>-wrong-current` as `Current password`, matching fake new values, then `click` `Change password` | Request settles with an error for the wrong current password; no password changes |
| 5 | In "API tokens", type `qa-<run-id>-token` into `New token name`, `click` `Create` | A copy-once panel appears: `Copy “qa-<run-id>-token” now`; the full token is visible only there |
| 6 | `expect` the token list row shows only a prefix and created date, never the full token | Secret material is not redisplayed |
| 7 | `click` `Revoke` on the QA token row | Row is removed; no other token is touched |
| 8 | `capture` screenshot, console delta, failed requests | — |

## S4 — `/settings/memory`: custom instructions and saved memories

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/memory` | Heading "Memory"; panels "Custom instructions" and "Saved memories" render; "Suggested memories" appears only if suggestions exist |
| 2 | Record current Custom instructions, append `qa-<run-id> temporary instruction`, `click` `Save` | Status "Instructions updated." appears; character counter stays under 4000 |
| 3 | Restore the recorded Custom instructions and `click` `Save` | Original instructions restored before leaving the scenario |
| 4 | Observe Suggested memories without clicking `Keep` or `Discard` | Operator's real inferred memories remain untouched |
| 5 | Add saved memory key `qa-<run-id>-note` and value `qa test value`, then `click` `Set` | Row appears in Saved memories |
| 6 | Re-enter the same key | Inline duplicate-key error appears; no duplicate row |
| 7 | Edit the QA row value to `qa test value v2`, `click` `Save`, then delete it through the `Delete memory` modal | Row updates, then is removed; no pre-existing memory changes |
| 8 | `capture` screenshot, console delta, failed requests | — |

## S5 — `/business/models`: effort presets and fallback chains (validation-only)

Admin session preferred; members can read but cannot save.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/models` | Heading "Models"; panels Fast, Balanced, Thorough, and "What each effort means" render |
| 2 | If no provider is configured, `expect` the warning "No provider is configured yet" and link `Add provider credentials` to `/business/secrets` | Present; skip chain-edit steps |
| 3 | Inspect configured chain rows | Each row shows provider label, Model ID, primary/fallback order, credential status, and pricing/limit facts when pinned; no raw credential value appears |
| 4 | `click` `Add fallback` in one effort panel | A "Model" sheet opens with fields `Provider`, `Model ID`, `Pricing and limits`, and optional `Connection overrides` |
| 5 | Leave `Model ID` empty, close the sheet, and `click` `Save changes` | Client-side validation error appears; no valid model routing write is submitted |
| 6 | Remove the temporary row or otherwise restore the loaded state before navigating away | Live model routing remains unchanged |
| 7 | In "What each effort means", `expect` labels `Auto resolves to`, `Fast`, `Balanced`, and `Thorough` | Effort preset names match the current UI |
| 8 | `capture` screenshot, console delta, failed requests | — |

## S6 — `/business/secrets`: masking and one QA custom credential

Admin session required for create/edit/delete; members see read-only credentials with an admin-only
message.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/secrets` | Heading "Secrets"; panels "Stored credentials" and, for admins, "Add a credential" render |
| 2 | `expect` no credential value renders anywhere; stored provider fields are blank with "Already set. Leave blank to keep it." | Masked — P0 if a secret value appears |
| 3 | `click` `Edit` on a pre-existing provider row, change nothing, then collapse it | No write fires; a credential this run did not create is never altered |
| 4 | In "Add a credential", choose `Provider` = `Custom…` | Fields `Key` and `Value` appear |
| 5 | Type `Key` = `qa-<run-id>-token`, `Value` = `qa-<run-id>-fake-value`, `click` `Save credential` | New custom row appears |
| 6 | `click` `Edit` on the row just saved | The value field is blank, not the value just typed — P0 if masking only applies after a reload |
| 7 | Delete the QA row through the `Delete credentials` modal | Row removed; no other credential changes |
| 8 | If member, `expect` "You can see which credentials exist but only an admin can change them." and skip writes | Read-only state is explicit |
| 9 | `capture` screenshot, console delta, failed requests | — |

## S7 — `/business/soul`, `/business/activities`, `/business/observability`, `/business/about`

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/soul` | Heading "Soul"; Git remote panel and a read-only tree/file viewer render |
| 2 | If a remote exists, `expect` status badge, remote URL, last sync text, `Sync now`, and admin-only `Edit`; do not click `Sync now` or submit the form | Read-only inspection only |
| 3 | If the Git form is visible, verify fields `Remote URL` and `Personal access token`; credential field is blank/write-only | Labels are sentence case; value is masked |
| 4 | Click `soul.yaml` and one artifact file in the tree | Content viewer renders read-only |
| 5 | `navigate /business/activities` | Heading "Activities"; chips All, Resources, Chats, Routines, Knowledge, Skills, Integrations, Jobs, Soul render; row sheet shows Action, Category, Actor, Target, Status, When, and optional Details |
| 6 | If admin, `navigate /business/observability`; if member, open it directly | Admin sees range buttons, metric cards, reliability panels, Recent turns, and Grafana Cloud export; member sees "Only an admin can see observability." |
| 7 | `navigate /business/about` | Heading "About"; version text and `Check for updates` button render |
| 8 | `capture` screenshot, console delta, failed requests | — |

## S8 — `/business/profile`, `/business/people`, and `/business/guardrails` (smoke)

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/profile` | Heading "Business profile"; fields Name, What it does, Website render for admins; members see read-only values and "Only an admin can change these." |
| 2 | Admin only: record existing values, make a tiny QA edit to Website or What it does, `click` `Save`, then restore the original value | Status "Business profile updated." appears and original value is restored immediately |
| 3 | If admin, `navigate /business/people` | Heading "People"; panels "Invite someone", "People", and "Roles" render; invite field label is `Email`, button `Send invite` |
| 4 | If member, open `/business/people` directly | Error message "Only an admin can manage people." renders |
| 5 | On `/business/guardrails`, inspect rows | Heading "Guardrails"; each row shows name, configured/effect text, On/Off badge, and Turn on/Turn off button; do not toggle pre-existing guardrails unless this run owns the target |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S9 — Cross-cutting: loading states, both themes, 375px, keyboard

| # | Action | Expected |
| --- | --- | --- |
| 1 | Resize to 375px on `/settings/auth`, `/settings/memory`, `/business/secrets`, and `/business/soul` | Layout remains usable, no page-level horizontal overflow |
| 2 | Record the current theme in `/settings/appearance`, switch to the other palette, revisit pages touched this run, then restore the original theme | Labels, badges, alerts, sheets, and code/tree view remain legible in both themes |
| 3 | Tab through `/settings/auth` | Order follows visible order: Current password, New password, Confirm new password, Change password, New token name, Create, token row actions |
| 4 | Tab through `/business/secrets` admin add form | Provider, then provider-specific fields or Key/Value, then Save credential; focus rings visible |
| 5 | Open a delete modal for a QA-owned memory or credential and Tab | Focus is trapped; Escape or Cancel closes and restores focus to the trigger |
| 6 | `capture` screenshot at 375px for both themes on at least one personal page and one business page | — |

## Notes for the runner

- Restore immediately. Any setting changed in this file is restored or deleted before the scenario
  ends; a failed restore is P0.
- Never save a valid modified model routing config during QA. Validation-only edits are allowed;
  successful model saves require a disposable environment outside this playbook.
- Never type real provider credentials, personal access tokens, or the operator's real current
  password. QA secrets and API tokens must be named `qa-<run-id>-*` and revoked/deleted before the
  scenario ends.
- Soul sync and git-remote writes are off-limits. Inspect their presence and labels only.
