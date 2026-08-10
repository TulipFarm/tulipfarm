---
id: auth
area: Auth
suites: [smoke, full]
routes: ["/login", "/setup", "/accept-invite", "/settings/auth", "/business/people"]
preconditions: [fresh incognito context available]
blast_radius: creates at most one qa-<run-id>-* invited user (admin session only); never completes
  that invite's account creation; never enters or changes the operator's real password; never logs
  the operator out, revokes their session, or touches pre-existing tokens
est_minutes: 8
smoke_scenarios: [S1, S2]
---

# Auth

Auth covers sign-in, first-run setup, invite redemption, and self-service password change. Every
unauthenticated flow (`/login`, the `/setup` gate, `/accept-invite`) runs in a **fresh incognito
context** — never the operator's signed-in tab. `/settings/auth` runs in the operator's own
signed-in tab, because it is only reachable authenticated, and its real password mutation is deliberately never completed by this playbook. API-token creation is exercised only for a `qa-<run-id>-*` token that is revoked before leaving the scenario.

This is the first playbook in `full` for a reason: a broken session here invalidates every later
result. Every scenario stands alone — a failure in one does not block the next.

## S1 — Unauthenticated redirect and the redirectTo param

Incognito context, no session cookie.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /chats` | Redirected to `/login?redirectTo=%2Fchats` within 5s |
| 2 | `expect` the login form renders: heading `tulipfarm`, text "Sign in to this tenant.", fields `email` and `password`, button `Sign in` | Present |
| 3 | `navigate /setup` | `/setup`'s own gate only checks first-run status, not auth — on an already-set-up instance it redirects to `/`, which then re-redirects (unauthenticated) to `/login?redirectTo=%2F` | Final URL is `/login?redirectTo=%2F` |
| 4 | `expect` no console error was produced by either redirect chain | Clean |
| 5 | `capture` screenshot, console delta, failed requests | — |

The client-side open-redirect guard in `login.tsx` (rejecting a `redirectTo` starting with `//` or
`/\`) only runs *after* a successful login. This playbook cannot complete a login without owning
real credentials, so the guard's actual behavior is not exercised here — see "Notes for the
runner." A `redirectTo` value that is preserved verbatim but visibly unescaped in the URL bar, or a
redirect to a bare `/login` that silently drops the param, is a P2.

## S2 — Login form validation and wrong-credential error state

Incognito context. Continues from S1 or starts fresh at `/login`.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /login` | Form renders as in S1.2 |
| 2 | `expect` `Sign in` is disabled while either field is empty | No request fires on click |
| 3 | `type` `email` `qa-<run-id>@example.invalid`, `type` `password` `qa-<run-id>-wrong-pw` | Both accepted |
| 4 | `click` `Sign in` | Button reads "Signing in…" while busy |
| 5 | `wait-until` the request settles (max 10s, form-submit budget) | An error alert renders: "error: invalid credentials" |
| 6 | `expect` the URL is still `/login` (or `/login?redirectTo=…` if arrived via S1) | Not navigated away |
| 7 | `expect` the 401 on `/api/v1/auth/login` is the only new network entry, and it is not flagged — this step declares it | Expected, not a finding |
| 8 | `capture` console delta and failed requests | — |

Do not attempt this with a real user's email — the API returns the identical "invalid credentials"
message for an unknown email and a wrong password by design (no user enumeration), so a made-up
`qa-<run-id>@example.invalid` exercises the same path without touching any real account. A
different-looking error for "unknown user" vs. "wrong password" would itself be a finding (P2,
enumeration leak) — the app is explicitly designed to avoid it.

## S3 — `/setup` gate on an already-set-up instance

Run once signed in (main tab) and once incognito; both are covered by S1.3 for the incognito half.
This scenario covers the signed-in half and the conditional wizard-reachability check.

| # | Action | Expected |
| --- | --- | --- |
| 1 | In the operator's signed-in tab, `navigate /setup` | Redirected to `/` (Chat) within 5s — `needsSetup` is false on an instance with an existing admin |
| 2 | `expect` no partial flash of the wizard UI before the redirect completes | Clean |

`note`: if `getSetupStatus` ever reports `needsSetup: true` (a fresh, never-provisioned instance),
the wizard becomes reachable. In that case only verify step-gating, never submit:

- Step "Admin account": `expect` `Continue` stays disabled until email, an 8+ character password,
  and a matching confirm are all filled; `type` mismatched password/confirm and `expect` "Both
  passwords must match." renders. **Do not click `Continue`** — submitting calls the real
  `setupAdmin` API and mints an actual admin account, which this playbook cannot undo (deleting
  users is forbidden).
- `expect` the step heading receives focus on entry (`tabIndex={-1}` heading, per source) — tab
  order should start from there, not reset to the top of the page.

Treat an unreachable wizard (the normal case) as a pass for this scenario, not a skip — the gate
redirecting correctly *is* the assertion.

## S4 — Invite creation and the accept-invite preview (admin session only)

Invite links are minted from `/business/people`, the only product surface that produces one —
`/accept-invite` cannot be exercised end-to-end without it.
**Skip this scenario with a `note` if the signed-in session is not an admin** (the sidebar hides
the People link and the route shows an admin-only error); S5 covers the invalid/expired-token states without needing a
fixture, so it still runs.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/people` | Heading `People`; existing people list renders |
| 2 | `type` `email` `qa-<run-id>@example.invalid` | Accepted |
| 3 | `click` `Send invite` | Button reads "Inviting…", then a panel appears: "Invite link for **qa-<run-id>@example.invalid**. Share it yourself — it is not shown again and it expires \<date>." with the invite link field |
| 4 | `expect` the URL contains `/accept-invite#token=` (fragment, not `?token=`) | Fragment-only — a token in the query string would land in server logs, a P1 |
| 5 | `capture` the invite URL as evidence (read the copy field; do not rely on `Copy`/clipboard) | Recorded |
| 6 | `expect` the new row appears in the People list with status "Invite pending" | Present |
| 7 | `note` every other row in the list — never click `Disable`, `Enable`, `New invite link`, or `Reset password link` on a user this run did not create | Observed only |
| 8 | In a **fresh incognito context**, `navigate` to the captured invite URL | `/accept-invite` loads |
| 9 | `expect` a brief "Checking this link…" loading state, then heading "Choose your password" and text "Setting the password for **qa-<run-id>@example.invalid**." | Renders within 5s |
| 10 | `expect` fields `password` and `confirm password`, button `Set password and sign in` (disabled while either is empty) | Present |
| 11 | `type` mismatched values into `password` and `confirm password`, `click` `Set password and sign in` | Inline alert "passwords do not match" — client-side, no API call |
| 12 | **Stop here.** Do not enter a matching password pair or submit one | Account creation is never completed by this playbook |

The `qa-<run-id>@example.invalid` user is left in "invite pending" status for the operator to
finish, re-invite, or leave alone — deleting it is forbidden by the blast-radius rules, and this
playbook has no delete action to offer even if it were.

## S5 — accept-invite: dead and missing tokens

No fixture required — runs standalone in a fresh incognito context.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate` to `/accept-invite#token=qa-<run-id>-not-a-real-token` | Loads |
| 2 | `expect` a brief "Checking this link…" state, then an alert containing "no longer valid" | Dead-link state, no password form shown |
| 3 | `expect` the explanatory text "Invite links are single-use and expire. Ask an admin for a new one." | Present |
| 4 | `navigate /accept-invite` with no fragment at all | Loads |
| 5 | `expect` an alert "this link is missing its invite token" **without** any request to the invite-preview endpoint | No network call fired — the empty-token case is caught client-side |
| 6 | `capture` console delta and failed requests | — |

A dead-link page that still renders the password form, or that reveals *why* a token failed
(expired vs. spent vs. never valid), is a P1 — the product deliberately collapses all three into
one message so a link holder can't learn anything from the failure shape.

## S6 — `/settings/auth`: password validation and API-token lifecycle

Signed-in tab (the operator's real session). **This is the highest-risk scenario in the
playbook — read it fully before running it.**

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /settings/auth` | Heading "Auth"; panels "Password" and "API tokens" render; fields `Current password`, `New password`, `Confirm new password`; button `Change password` (disabled while any field is empty) | Renders within 5s |
| 2 | `type` any value into `Current password`, and **mismatched** values into `New password` / `Confirm new password`, `click` `Change password` | Inline alert "These do not match." — client-side, no API call |
| 3 | `type` a value into `Current password` that is **not** the operator's real password (e.g. `qa-<run-id>-wrong-current`), and a matching pair into `New password` / `Confirm new password`, `click` `Change password` | `wait-until` settled (max 10s) — alert "current password is incorrect" (401); no session rotation, no state change |
| 4 | `expect` the 401 on `/api/v1/auth/change-password` is expected and not flagged (this step declares it) | Expected |
| 5 | Type `qa-<run-id>-token` into `New token name`, `click` `Create` | A copy-once panel appears: `Copy “qa-<run-id>-token” now`; the full token is visible only there |
| 6 | `expect` the token list row shows only the token prefix and created date, never the full token | Secret material is not redisplayed |
| 7 | `click` `Revoke` on the QA token row | Row is removed; no pre-existing token is touched |
| 8 | `capture` screenshot, console delta, failed requests | — |

**Never** type the operator's actual current password into this form, and never submit a valid
current-password + new-password pair — that call succeeds, rotates the session (still valid, per
the product's own copy: "This session stays signed in; any other is not affected"), and genuinely
changes the sign-in credential this whole run depends on, with no undo. Step 3 is chosen
specifically because a wrong current password is rejected *before* any write happens.

A "Password updated" success status appearing after step 3 (a wrong current password) is **P0** —
it means the API is not actually verifying the current password, a real account-takeover-adjacent
regression, not a UI quirk.

## S7 — Keyboard access and focus

| # | Action | Expected |
| --- | --- | --- |
| 1 | On `/login` (incognito), Tab from the top of the page | Order: `email` → `password` → `Sign in`, each with a visible focus ring |
| 2 | On `/accept-invite` with a dead token (S5), Tab through the page | Focus reaches nothing interactive beyond the alert — no phantom tab stop into a hidden form |
| 3 | On `/settings/auth`, Tab through the form | Order: `Current password` → `New password` → `Confirm new password` → `Change password` → `New token name` → `Create` → token row actions, each focus-visible |
| 4 | `expect` exactly one `h1` on each page visited this run, and no skipped heading level | `tulipfarm` (login), `Choose your password` (accept-invite), `Auth` (settings) |
| 5 | If S4 ran (admin), Tab through the `/business/people` invite form and the invite-panel `Copy`/`Dismiss` buttons | Both reachable, both labeled by their visible text — not icon-only |

## S8 — Both themes

Standalone auth pages (`/login`, `/setup`, `/accept-invite`) render outside the app shell and carry
no theme-toggle control of their own — they only inherit whatever theme is already active for that
browser context. `/settings/auth` is the one route in scope with a working toggle
(`Toggle dark mode`, in the signed-in app shell).

| # | Action | Expected |
| --- | --- | --- |
| 1 | Record the current theme on `/settings/auth` before touching it | Baseline noted |
| 2 | `click` `Toggle dark mode` | Theme flips; persists across a reload |
| 3 | `expect` all text on `/settings/auth` (labels, alert, status message) is legible in the new theme | Legible, no invisible-on-background text |
| 4 | `click` `Toggle dark mode` again to restore the recorded baseline | Restored — this is a persisted preference on the operator's real session, so it must not be left flipped |
| 5 | `note` whatever theme `/login`, `/setup`, and `/accept-invite` happened to render in during S1–S5 (from the incognito context's default) and confirm text was legible there too — no forced toggle is possible on those pages | Recorded |

## Notes for the runner

- **Everything in this playbook that touches an unauthenticated route must run in the fresh
  incognito context**, never the operator's signed-in tab — reusing that session for `/login` or
  `/accept-invite` risks tripping the app's own "already authenticated" paths in ways this playbook
  doesn't model.
- **S6 is the one scenario with real teeth.** It is written so that every step that reaches the API
  is expected to fail (wrong current password). If a runner is tempted to "just verify the happy
  path too," don't — there is no way to undo a real password change against the operator's own
  account from inside this playbook.
- The safe-redirect guard (`redirectTo` starting with `//` or `/\` falling back to `/`) cannot be
  exercised here without a completed login, and this playbook is deliberately unable to complete
  one without owning real credentials. **Gap for the human dry-run**: if a disposable QA account
  with known credentials exists (or is created and finished manually, outside this playbook), the
  runner can extend S1 to actually submit a crafted `redirectTo=//evil.com` and confirm the landing
  page is `/`, not `evil.com`. Until then this is a code-reviewed guarantee, not a QA-verified one.
- **`/settings/auth` now has a real API-token UI.** S6 creates one QA token, verifies the copy-once
  value is not redisplayed in the list, and revokes it immediately. The page still has no session
  list, so do not invent a session-management step or verify sessions with `curl`.
- Invite creation (S4) lives on `/business/people`, which belongs to the Admin & RBAC playbook.
  Auth borrows it only as a fixture source and only touches the one row it creates.
- If the signed-in session is not an admin, S4 skips with a `note`; every other scenario still runs
  — S5 in particular needs no fixture at all.
