---
id: admin-rbac
area: Admin & RBAC
suites: [full]
routes: ["/business/people", "/business/guardrails"]
preconditions: [signed-in session; admin required for People write scenarios]
blast_radius: creates at most one qa-<run-id>-* invited user (email only; account creation is
  never completed); disables that one invited row to revoke its link; never touches any other
  person, role, or guardrail. Roles are now a read-only panel on People, not their own destination.
est_minutes: 10
smoke_scenarios: []
---

# Admin & RBAC

Admin & RBAC covers People (`/business/people`), the read-only Roles panel on that page, and
Guardrails (`/business/guardrails`). Both live in **Operate → Business**. People is an admin-only
read; Guardrails is visible to members but writes are admin-gated by the API.

Every scenario stands alone — a failure in one does not block the next.

## Reality check

Verified against `apps/web/app/routes/_app.business.people.tsx`,
`apps/web/app/routes/_app.business.guardrails.tsx`, and `apps/web/app/lib/nav.ts`.

- People is the replacement for both the old Users and Roles destinations. It contains panels
  "Invite someone", "People", and "Roles". The Roles panel is read-only and lists grants from the
  Soul-backed role model; there is no create/edit/delete/assign role UI.
- People is `adminOnly` in navigation and its route-level `ErrorBoundary` renders "Only an admin can
  manage people." for a direct non-admin visit.
- Guardrails is under Operate → Business. It lists configured guardrails, shows an On/Off badge, and
  offers Turn on/Turn off buttons. A failed load or forbidden write is rendered as an inline error.
- Field labels are sentence case: Email, New invite link, Reset password link, Turn on, Turn off.

---

## ABSOLUTE PROHIBITIONS — read before running any scenario

- Never delete a person or complete account creation from an invite.
- Never change any pre-existing person's status or reissue their invite/reset link.
- Never weaken a guardrail. If a future run exercises a write, record first, make only a stricter
  change, and restore immediately; failed restore is P0.
- Never grant elevated authority to anything, including a `qa-<run-id>-*` person or agent.
- Never `curl` the API for feature verification. UI only, per `AGENTS.md` and conventions.

## S1 — Admin-session detection and non-admin behavior

| # | Action | Expected |
| --- | --- | --- |
| 1 | Inspect Operate → Business navigation | Admins see People; members do not see People. Guardrails is visible to both roles. |
| 2 | If People is absent, `navigate /business/people` directly | Inline error "Only an admin can manage people." renders; record `admin-rbac.md` People scenarios skipped for this member session |
| 3 | If People is present, proceed to S2 | Admin session confirmed |
| 4 | `capture` screenshot of the sidebar state | — |

## S2 — `/business/people`: list, role display, PII exposure

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/people` | Within 5s: heading "People"; panels "Invite someone", "People", and "Roles" render |
| 2 | `expect` invite form label `Email`, placeholder `name@example.com`, button `Send invite` | Present; button disabled while Email is empty |
| 3 | `expect` each person row shows name or email, role badge (`admin` or `member`), and status badge (`Active`, `Invite pending`, or `Disabled`) | Present |
| 4 | `expect` admin rows show no status or invite/reset action buttons | Admin accounts are not actionable from this list |
| 5 | `expect` no row exposes a password hash, full invite token, or another person's invite link | Clean |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S3 — `/business/people`: invite one `qa-<run-id>-*` person

Admin session only.

| # | Action | Expected |
| --- | --- | --- |
| 1 | Leave Email blank | `Send invite` is disabled |
| 2 | Type invalid Email `not-an-email`, `click` `Send invite` | HTML/server validation rejects it; inline error appears; no person created |
| 3 | Type `qa-<run-id>@example.invalid`, `click` `Send invite` | Button reads "Inviting…"; an invite panel appears for that email with a copy-once Invite link |
| 4 | `expect` the Invite link URL contains `/accept-invite#token=` | Fragment-only; query-string token is P1 |
| 5 | `expect` the new row appears with status `Invite pending` and action `New invite link` | Present |
| 6 | Repeat step 3 with the same email | Inline 409-style error; no duplicate row |
| 7 | `capture` screenshot, console delta, failed requests | — |

## S4 — `/business/people`: revoke the QA invite and inspect Roles

| # | Action | Expected |
| --- | --- | --- |
| 1 | On the `qa-<run-id>-*` row from S3, `click` `Disable` | Button disables while busy; row status changes to `Disabled`; invite-link action disappears |
| 2 | `note` that the button label is Disable, not Revoke invite | Recorded as copy/discoverability context, not a failure by itself |
| 3 | Inspect the Roles panel | Panel title "Roles"; description mentions the Soul revision when roles load; rows list role name, applicable principal kinds, and grants |
| 4 | `expect` no create/edit/delete/assign role controls exist | Confirmed absent; Roles is a panel, not a destination |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S5 — `/business/guardrails`: list and admin-gated mutation surface

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/guardrails` | Heading "Guardrails"; panel "Guardrails" renders with revision text |
| 2 | If no guardrails are configured | Empty state "No guardrails configured." renders |
| 3 | For each row, `expect` name, configured/effect text, On/Off badge, and button `Turn on` or `Turn off` | Present |
| 4 | Do not toggle a pre-existing guardrail. If the UI is exercised against a QA-owned guardrail in a disposable environment, record baseline, click the stricter action only, assert result, then restore immediately | Restore discipline captured |
| 5 | If a non-admin clicks a write button in a member session | Inline error "You do not have permission to change guardrails." is expected; no state changes |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S6 — Unknown route / loading / responsive checks

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/people/qa-<run-id>-does-not-exist` | Standard no-route/404 handling; no React error overlay or blank white page |
| 2 | Observe initial paint on `/business/people` and `/business/guardrails` | Content appears within 5s; transient blank panel is acceptable in SPA clientLoader style |
| 3 | Record current theme in Settings → Appearance, switch themes, revisit both pages, then restore | Text, badges, disabled states, and inline errors remain legible |
| 4 | Resize to 375px | Invite form and row actions wrap without page-level horizontal overflow |
| 5 | Tab through People and Guardrails | Email → Send invite → invite-panel controls → row actions; each guardrail toggle in row order; all focus-visible |
| 6 | `capture` screenshot, console delta | — |

## Notes for the runner

- People replaced the old Users and Roles destinations. Do not navigate to retired admin URLs in
  this playbook; their redirects are not the UI a tester should follow.
- Role administration has no separate page and no mutating UI. Treat that as the current product
  shape, not a missing test setup.
- Negative RBAC for People can be observed by opening `/business/people` as a member. If only an
  admin session is available, record the code/UI guarantee and skip the live member assertion.
