---
name: tulipfarm-qa
description: Run agent-driven manual QA against the running TulipFarm dev app in a real browser. Use when asked to QA, sanity-check, smoke-test, regression-test, or verify a change end-to-end in the product UI — including "/qa smoke", "/qa full", or "/qa <area>" such as chat, resources, skills, routines, agents, knowledge, integrations, settings, auth, or admin.
---

# TulipFarm QA Runner

Drive the running dev app through a real browser, follow the playbooks in `docs/qa/playbooks/`,
record findings with evidence, and hand the operator a triage list.

**Read [`docs/qa/conventions.md`](../../../docs/qa/conventions.md) first.** It is binding: blast
radius, step grammar, wait budgets, severity, and the finding format all live there. This file is
only the run protocol.

## Invocation

| Argument | Meaning |
| --- | --- |
| `smoke` | Preflight + the `smoke_scenarios` of every smoke-suite playbook. ~10–15 min. Run after any change. |
| `<area>` | Preflight + one playbook in full, e.g. `chat`, `resources`, `knowledge`. |
| `full` | Preflight + every playbook in full, serially. ~60–90 min. |

No argument: ask which. Do not guess.

## Non-negotiables

These come from `AGENTS.md` and the operator's environment. Violating one invalidates the run.

1. **Never start or stop dev servers.** Preflight health-checks and aborts if any are down.
2. **Never log the operator out.** The run reuses their signed-in Chrome session. Unauthenticated
   behavior is tested in a **fresh incognito context** only.
3. **Never write to the runtime `soul/` repo directly.** Soul artifacts are created through Chat or
   the UI. An unreachable state is a product gap and gets filed as a finding.
4. **Never `curl` the API for feature verification.** Manual QA goes through the UI.
5. **Never touch data the run did not create.** Full CRUD on `qa-<run-id>-*` only.
6. **Never complete a real third-party OAuth handshake.** Integrations are UI-only.
7. **Never stop on a finding.** Log it and continue. Triage happens at the end.
8. **No cleanup.** Artifacts are left for the operator.

## Protocol

### 1. Preflight

Run `docs/qa/playbooks/00-preflight.md` in full. It is the only playbook that aborts on failure.

It produces the run id, the git SHA/branch/dirty flag, the run tab, the loaded suppression list, and
the **console/network baseline** every later assertion is measured against.

### 2. Set up the browser

Load the browser tools in **one** call, then open a dedicated tab:

```
ToolSearch "select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__read_network_requests,mcp__claude-in-chrome__resize_window,mcp__claude-in-chrome__tabs_close_mcp"
```

Call `tabs_context_mcp` first to see the operator's tabs — then create a **new** tab for the run.
Never drive a tab the operator was using. Never reuse tab ids from a previous session.

Do not trigger `alert`/`confirm`/`prompt` dialogs: a modal dialog freezes the extension and ends the
run. If a page has a confirm-backed destructive action, note it and skip rather than risk it.

### 3. Execute playbooks

Serially — one browser means no parallelism, and no background subagents driving it.

Per playbook:

1. Read its frontmatter; skip with a `note` if a precondition is unmet (e.g. `admin-rbac` on a
   non-admin session).
2. Execute each scenario in order. A failed scenario does not block the next one.
3. Target elements by accessible name, visible label, or heading text. Never by CSS class or DOM
   position.
4. `wait-until` means poll to a terminal state within the budget in `conventions.md`. Never sleep a
   fixed duration, and never wait past a budget — no flow in this app is declared slow, so an
   overrun is a finding (perf if it eventually succeeds, P1 if it never settles). Record the
   measured duration.
5. After each scenario, read console messages and network requests, diff against the baseline, and
   record anything new.
6. Name every artifact created `qa-<run-id>-*`.

### 4. Record findings as they happen

**Append each finding to `docs/qa/runs/<run-id>/findings.md` the moment it is observed.** Never hold
them in context to write at the end — a long run must survive compaction and be resumable.

Before recording, check `docs/qa/known-issues.md`. A match becomes a `note` in the report, not a
finding.

Use the exact record format in `conventions.md`: id, severity, title, playbook/step, numbered repro,
expected vs actual, evidence paths, and env (branch, SHA, URL, timestamp). Save the screenshot and
the console/network excerpts to `evidence/` — a finding without evidence is not actionable.

Severity: P0 flow dead / data loss / security · P1 major functional · P2 minor functional or
objective a11y violation · P3 visual, layout, copy, polish. **Report every type, down to small UI
issues.**

### 5. Report

Write `docs/qa/runs/<run-id>/report.md`: run id, suite, branch/SHA/dirty, start and end time, a
playbook × scenario pass/fail matrix, the finding count by severity, and the list of `qa-*`
artifacts created so the operator can clean up.

Restore the operator's original theme. Leave the run tab open if there are findings to inspect;
close it otherwise.

### 6. Triage

Present findings severity-ordered as a compact table, then take the operator's choice **per
finding**:

| Choice | Action |
| --- | --- |
| **Fix now** | Spawn a subagent to investigate. It reports the root cause with `file:line` evidence plus the two most likely alternative explanations and why each was ruled out. **It edits nothing until the operator approves the diagnosis.** After approval: patch, then `pnpm lint`, `pnpm typecheck`, and a scoped test run (`pnpm vitest run <path>`) — never a parallel full-repo run. |
| **File issue** | First `gh issue list --repo TulipFarm/tulipfarm --state open --label qa-agent` and `--label bug`, and search for a match. If one exists, `gh issue comment` with `seen again on <sha>` plus the fresh evidence. Otherwise `gh issue create --label bug --label qa-agent` with the full finding record. |
| **Known issue** | Append to `docs/qa/known-issues.md` with a reason and the date. |
| **Ignore** | Stays in the report only. |

Do not file or fix anything before asking. Do not batch-file without a per-finding decision.

## Resuming an interrupted run

`docs/qa/runs/<run-id>/findings.md` and `report.md` are the state. On resume, read them, identify
the last completed scenario, and continue from the next one. Reuse the same run id and artifact
prefix.

## Adding a playbook

Follow the authoring rules at the end of `docs/qa/conventions.md`, then register it in
`docs/qa/playbooks/index.md` with its suite membership and estimated duration.
