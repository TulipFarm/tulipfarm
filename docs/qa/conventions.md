# QA playbook conventions

Binding rules for writing and executing TulipFarm QA playbooks. Read this before running any
playbook or authoring a new one.

## Scope of this layer

This is **interactive, on-demand, local QA** driven by an agent in a real browser. It is not CI and
does not replace:

- `pnpm test` — Vitest unit and route-module coverage.
- `scripts/test/browser/*.spec.ts` — deterministic Playwright journeys against an installed instance.

Nothing here is wired into CI. Nothing here generates Playwright specs.

## Environment contract

| | |
| --- | --- |
| Web | `http://localhost:4000` |
| API | `http://localhost:4010` |
| Worker | `http://localhost:4020` |
| Integration worker | `http://localhost:4030` |
| Database | The existing local dev database — **not** a fresh one |
| Soul | The existing local `soul/` repo |
| Session | The operator's already-signed-in Chrome session |
| LLM | The real configured provider |

The agent **never starts or stops dev servers**. Preflight health-checks them and aborts with
instructions if any are down.

## Blast radius — hard limits

The agent operates on a live dev environment with real data. These are not guidelines.

**Allowed**

- Create anything, named with the `qa-<run-id>-` prefix.
- Read anything.
- Edit and delete artifacts it created in this run (`qa-<run-id>-*`).
- Change a setting **only** if the prior value is recorded first and restored immediately after.

**Forbidden**

- Editing or deleting any artifact not created by this run — including `qa-*` artifacts from
  earlier runs.
- Deleting users, changing roles, rotating encryption keys, or revoking secrets.
- Logging the operator out, or ending the signed-in session in any way.
- Completing a real third-party OAuth or token handshake in Integrations. UI only.
- Writing to the runtime `soul/` repo directly — filesystem, shell redirect, patch, or script.
  Per `AGENTS.md`, Soul artifacts are created **only** through Chat or the web UI. If a playbook
  cannot reach a state through the product surface, that is a product gap and gets reported as a
  finding, not bypassed.
- Any `curl` against the dev API for feature verification. Manual QA goes through the UI.

**Cleanup is not performed.** Artifacts are left in place for the operator to remove manually. The
`qa-<run-id>-` prefix is what makes them findable.

## Run identity

A run id is `<YYYYMMDD>-<HHMM>-<suite>`, e.g. `20260809-1432-smoke`. Everything the run produces
lives under `docs/qa/runs/<run-id>/`:

```
docs/qa/runs/<run-id>/
  findings.md     # appended to as findings occur — never written only at the end
  report.md       # pass/fail matrix, written at the end
  evidence/       # screenshots, console dumps, network dumps
```

`docs/qa/runs/` is gitignored.

## Step grammar

Playbook steps use a tool-agnostic verb set so the same file works under Claude Code, Codex, or a
human. Do not write tool-specific or framework-specific instructions in a playbook.

| Verb | Meaning |
| --- | --- |
| `navigate <path>` | Go to `http://localhost:4000<path>` in the run tab |
| `click <accessible name>` | Activate the control with that accessible name or visible label |
| `type <target> "<text>"` | Enter text into the named field |
| `submit` | Submit the focused form / press the primary action |
| `expect <condition>` | Assert; a false condition is a finding, and the run continues |
| `wait-until <condition> (max <n>s)` | Poll; timeout is a finding |
| `capture <artifacts>` | Record screenshot / console delta / failed requests into `evidence/` |
| `note <text>` | Operator-facing observation, never a pass/fail assertion |

**Target elements by accessible name, visible label, or heading text** — the app exposes real ones
(`Send prompt`, `Stop response`, `Chat actions`, `search chats`). Never target by CSS class or DOM
position; those change with every design pass and produce false failures.

## Waits and performance

**No flow in this app is legitimately slow.** That is a stated property of the product, so it is
asserted, not accommodated. Exceeding a budget is a finding, not a reason to wait longer.

Poll to a terminal state — never sleep a fixed duration. Sleeps produce both false failures and
false passes.

| Flow | Wait for | Budget | Overrun |
| --- | --- | --- | --- |
| Page navigation and render | Route content painted, not a spinner | 5s | P2 perf |
| Form submit / CRUD write | Result reflected in the UI | 10s | P2 perf |
| Chat first token | Streaming begins | 10s | P2 perf |
| Chat response complete | Streaming terminates | 60s | P1 |
| Skill install | Installed state shown | 30s | P1 |
| Knowledge indexing | Page/space searchable or indexed state shown | 30s | P1 |
| Routine run | Terminal state on `/runs` | 60s | P1 |

Rules:

- **Never settling is P1.** Record the elapsed time and the last observed state as evidence.
- **Exceeding a budget while still succeeding is a perf finding at the severity above**, with the
  measured duration in the record. Do not silently pass a slow success.
- Time from the user action, not from when polling started.
- A spinner that renders forever is P1 even if the underlying request succeeded — the UI never
  reached a terminal state.

If the operator later declares a flow genuinely slow, that belongs in `known-issues.md` with a
reason, not in this table.

## Assertions against LLM output

Responses are nondeterministic. Assert on shape, not content:

- Good: response is non-empty; no error banner; streaming terminated; a tool call the prompt should
  have triggered appears in the transcript; the created artifact exists afterward.
- Bad: response equals or contains a specific sentence.

If a prompt's *intent* is clearly unmet (asked to create a resource, nothing was created), that is a
P1 finding — judged semantically, with the full transcript captured as evidence.

## Console and network baseline

Dev console noise is unknown, so it is **measured, not assumed**. Preflight visits a set of routes
and records every console message as the baseline. During playbook execution, only messages **not**
in the baseline are candidate findings.

- New console `error` → P1 by default.
- New console `warning` → P2.
- Any 4xx/5xx XHR that the step did not intend to provoke → P1.
- A step that deliberately tests an error path records the expected status in its `expect` line, and
  that response is not a finding.

## Severity

| Level | Meaning | Examples |
| --- | --- | --- |
| P0 | Flow dead, data loss, security exposure, app fails to load | Chat never sends; secret rendered in plain text; page 500s |
| P1 | Major functional defect, no workaround | Create succeeds but the item never appears; new console error; failed XHR |
| P2 | Minor functional defect, or an objective a11y violation | Missing loading state; focus not trapped in a modal; unlabeled icon-only button |
| P3 | Visual, layout, copy, or polish | Misaligned column; truncated label; inconsistent capitalization; unclear empty-state copy |

Every finding type is reportable, down to small UI issues. Severity is how noise is managed — not
by withholding the finding.

## Accessibility checks

Applied on every page a playbook visits, judged against objective criteria:

- Every interactive control has an accessible name.
- Visible focus indicator on keyboard focus (the app relies on a global `:focus-visible` outline).
- Tab order follows visual order; modals and sheets trap focus and restore it on close.
- Off-canvas panels use `inert`, not `aria-hidden`.
- One `h1` per page; heading levels do not skip.
- Images and icon-only buttons are labeled.
- Text contrast is legible in **both** light and dark themes.

## Finding record

Append to `docs/qa/runs/<run-id>/findings.md` the moment a finding is observed — never batch to the
end. A long run must survive context compaction and be resumable.

```markdown
### F-07 · P1 · Renaming a chat does not update the sidebar

- **Playbook/step**: `chat.md` S5.3
- **Repro**
  1. navigate `/chats`
  2. click `Chat actions` on `qa-20260809-1432-first`
  3. click `Rename chat`, type `qa-20260809-1432-renamed`, submit
- **Expected**: Sidebar recent-chat entry shows the new title
- **Actual**: Sidebar keeps the old title until a full page reload
- **Evidence**: `evidence/f07-sidebar.png`, `evidence/f07-console.txt`
- **Env**: `main` @ `67e6481`, `http://localhost:4000/chats`, 2026-08-09T14:41Z
```

## Triage

The run does not stop on a finding. At the end, findings are presented severity-ordered and the
operator chooses per finding:

| Choice | Behavior |
| --- | --- |
| **Fix now** | A subagent investigates and reports root cause with `file:line` evidence plus the two most likely alternative explanations and why they were ruled out. **It edits nothing until the operator approves the diagnosis.** After approval: patch, then `pnpm lint`, `pnpm typecheck`, and a scoped test run. |
| **File issue** | Search open `TulipFarm/tulipfarm` issues labeled `qa-agent` or `bug` for a match. If one exists, comment `seen again on <sha>` with fresh evidence. Otherwise open a new issue labeled `bug` + `qa-agent` containing the full finding record. |
| **Known issue** | Append to `docs/qa/known-issues.md` with a reason. Never reported again. |
| **Ignore** | Stays in the run report only. |

## Suppression

`docs/qa/known-issues.md` is checked before any finding is reported. A matching entry downgrades the
finding to a `note` in the report and excludes it from triage.

## Authoring a new playbook

1. Frontmatter: `id`, `area`, `suites`, `routes`, `preconditions`, `blast_radius`, `est_minutes`.
2. Group steps into scenarios (`## S1 — …`) that each stand alone. A failed scenario must not
   prevent the next one from running.
3. Cover, for every screen: happy path, empty state, loading state, error state, validation
   failure, and both themes.
4. Name every created artifact `qa-<run-id>-<something>`.
5. Add the playbook to `docs/qa/playbooks/index.md` with its suite membership.
6. Keep it tool-agnostic. No MCP tool names, no Playwright API, no CSS selectors.
