---
id: onboarding-setup
area: Setup & Onboarding
suites: [smoke, full]
routes: ["/setup", "/onboarding"]
preconditions: [fresh incognito context available]
blast_radius: read-only verification of wizard steps; never submits admin account creation or overwrites existing setup
est_minutes: 8
smoke_scenarios: [S1]
---

# First-Run Setup & Onboarding Wizard

The First-Run Setup Wizard (`/setup`) and Onboarding flow (`/onboarding`) govern initial tenant provisioning, admin account seeding, default LLM provider connection, database setup validation, and the getting-started checklist.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Setup wizard gate on provisioned vs unprovisioned instance

| # | Action | Expected |
| --- | --- | --- |
| 1 | In a fresh incognito context, `navigate /setup` | Setup gate checks `getSetupStatus` API |
| 2 | On an already-provisioned instance (`needsSetup: false`), `expect` instant redirect to `/login` or `/` within 5s | Redirected safely without rendering wizard form |
| 3 | On an unprovisioned instance (`needsSetup: true`), `expect` heading `Welcome to TulipFarm` and step 1 "Admin Account" | Wizard renders |
| 4 | `expect` no console errors during setup gate check | Clean console |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S2 — Admin creation step validation (unprovisioned instance only)

| # | Action | Expected |
| --- | --- | --- |
| 1 | On setup step 1, `expect` `Continue` button is disabled while `email`, `password`, or `confirm password` is empty | Validation holds |
| 2 | `type` invalid email format `not-an-email` | Validation error "Invalid email address" renders |
| 3 | `type` `password` `short` (<8 chars) | Validation error "Password must be at least 8 characters" renders |
| 4 | `type` mismatched `password` and `confirm password` | Validation error "Passwords do not match" renders |
| 5 | **Do not click Continue.** | Do not submit real admin creation against existing DB |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S3 — Getting Started checklist card in Chat shell

| # | Action | Expected |
| --- | --- | --- |
| 1 | In signed-in session, `navigate /` | Chat home loads |
| 2 | If Getting Started card is present, inspect tasks (`Create a Resource Type`, `Try an Effort Preset`, `Explore Knowledge`) | Tasks listed with completion checkboxes |
| 3 | `click` `Dismiss` on Getting Started card | Card closes |
| 4 | Reload page or `click` `+ new chat` | Dismissed state persists; card does not re-appear |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S4 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through setup wizard controls | Every field and button has visible `:focus-visible` outline |
| 2 | Toggle between Light and Dark themes | Wizard card, background gradient, and input fields remain legible |
| 3 | Resize viewport to 375px mobile width | Wizard container centers and scales without horizontal scroll |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- On an already-setup dev instance, step S2 is skipped with a `note`.
- Never submit valid admin credentials on `/setup` during automated QA runs.
