---
id: preflight
area: Preflight
suites: [smoke, full, area]
routes: [/, /chats, /resources, /knowledge, /inbox, /settings]
preconditions: [dev servers running, operator signed in to Chrome]
blast_radius: none — read-only
est_minutes: 3
---

# Preflight

Runs before **every** QA run, including single-area runs. Establishes that the environment is
testable and records the baseline every later assertion is measured against.

A preflight failure **aborts the run**. It is the only playbook that does not log-and-continue —
there is no point collecting findings against a broken environment.

## S1 — Server health

| # | Action | Expected |
| --- | --- | --- |
| 1 | Check `http://localhost:4010/health` | Responds OK |
| 2 | Check `http://localhost:4000` responds | Responds OK |
| 3 | Check worker `http://localhost:4020` responds | Responds OK |
| 4 | Check integration worker `http://localhost:4030` responds | Responds OK |

If any is down, **abort** and tell the operator exactly which, with the command to start it:

```
pnpm dev                        # all four
pnpm dev:api                    # :4010
pnpm dev:web                    # :4000
pnpm dev:worker                 # :4020
pnpm dev:integration-worker     # :4030
```

Do not start them. Do not fall back to `curl`-ing the API to work around a dead web server.

## S2 — Run identity

| # | Action | Expected |
| --- | --- | --- |
| 1 | Record `git rev-parse --short HEAD` and the current branch | Captured |
| 2 | Record whether the working tree is dirty | Captured |
| 3 | Derive the run id `<YYYYMMDD>-<HHMM>-<suite>` | Captured |
| 4 | Create `docs/qa/runs/<run-id>/evidence/` | Directory exists |
| 5 | Read `docs/qa/known-issues.md` | Suppression list loaded |

The SHA, branch, and dirty flag go into every finding record.

## S3 — Session

| # | Action | Expected |
| --- | --- | --- |
| 1 | Open a **new tab** for the run — never reuse an operator tab | New tab is the run tab |
| 2 | `navigate /` | App shell renders; not redirected to `/login` or `/setup` |
| 3 | `expect` the sidebar renders with Build / Knowledge / Operate / Settings groups | Present |
| 4 | `note` whether the signed-in user is an admin (the `Users` item under Settings is admin-only) | Recorded |

If redirected to `/login`, **abort**: the session expired and this QA layer does not log in. Ask the
operator to sign in.

If redirected to `/setup`, **abort**: the instance has no users. That is a different environment than
these playbooks assume.

Admin status determines whether `admin-rbac.md` can run. A non-admin session skips it with a `note`,
not a finding.

## S4 — Console and network baseline

The dev console's noise level is unknown, so it is measured rather than assumed.

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /` and let it settle | — |
| 2 | `navigate /chats`, `/resources`, `/agents`, `/skills`, `/routines`, `/knowledge`, `/inbox`, `/business/activities`, `/integrations`, `/operations`, `/settings` | Each renders |
| 3 | `capture` every console message seen across all of the above into `evidence/console-baseline.txt` | Baseline recorded |
| 4 | `capture` every failed request seen across all of the above into `evidence/network-baseline.txt` | Baseline recorded |

**The baseline is not a pass.** Anything in it is still a real problem — it is recorded as a single
P2 finding titled "pre-existing console/network noise on load", listing the distinct messages, and
then excluded from per-step reporting so it does not repeat on every screen.

During playbook execution, only messages **absent from the baseline** are candidate findings.

## S5 — Theme baseline

| # | Action | Expected |
| --- | --- | --- |
| 1 | `note` the current theme (light or dark) | Recorded |
| 2 | `expect` the theme toggle is reachable and labeled | Present |

Playbooks check both themes on their key screens. The run restores the operator's original theme at
the end.

## Abort report

On abort, report only:

- Which check failed and its exact output.
- The command to fix it.
- That no playbooks ran and nothing was created.
