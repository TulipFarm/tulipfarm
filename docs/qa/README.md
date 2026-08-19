# QA playbooks

Agent-driven manual QA for TulipFarm. Runbooks an AI agent (or a person) follows against the
**running local dev app** in a real browser, producing findings with evidence and a triage list.

## Why this exists

Every change currently needs manual click-through. The automated layers do not cover it:

| Layer | Covers | Does not cover |
| --- | --- | --- |
| `pnpm test` (Vitest, jsdom) | Units, route modules | Real browser, real rendering, real streaming |
| `scripts/test/browser-smoke.mjs` (CI, real Chromium) | Boot, CSP and secure-context regressions, plus the Knowledge access-control denial spine, against the shipped container image | Product breadth, UI polish, a11y, exploratory checks |
| `scripts/test/browser/*.spec.ts` (Playwright) | **Local-only — never runs in CI.** Deterministic critical journeys and the full Knowledge ACL matrix against an installed instance | Anything in CI; product breadth, UI polish, a11y, exploratory checks |
| **This** | 13 feature areas end-to-end in the product UI, including visual and a11y issues | Anything in CI — this layer is interactive and local |

Nothing here runs in CI or generates Playwright specs.

## Run it

Start the dev servers yourself — the agent will not:

```bash
pnpm dev     # :4000 web · :4010 api · :4020 worker · :4030 integration-worker
```

Be signed in to the app in Chrome. Then:

**Claude Code**

```
/tulipfarm-qa smoke     # ~10–15 min, critical path — after any change
/tulipfarm-qa chat      # one area in full
/tulipfarm-qa full      # everything, ~60–90 min
```

**Codex** — `Use $tulipfarm-qa to run the smoke suite.`

**A person** — open `playbooks/index.md`, pick a playbook, follow the steps. They are written to be
human-runnable.

## Layout

```
docs/qa/
  README.md            you are here
  conventions.md       binding rules — read before running or authoring
  known-issues.md      suppressions
  playbooks/
    index.md           area -> file, suite membership, preconditions, duration
    00-preflight.md    always runs first; aborts on a bad environment
    <area>.md          one per feature area
  runs/<run-id>/       gitignored: findings.md, report.md, evidence/
```

The agent entry point is `.agents/skills/tulipfarm-qa/SKILL.md`, symlinked to
`.claude/skills/tulipfarm-qa`. Playbooks are tool-agnostic; the skill is the only tool-specific part.

## What it does to your environment

It runs against your **real dev database and soul repo**, using your **signed-in session**.

- Creates artifacts prefixed `qa-<run-id>-`. Full CRUD on those only.
- Never touches data it did not create, never logs you out, never deletes users or rotates secrets.
- Never completes a real third-party OAuth handshake — Integrations is UI-only.
- Never writes to `soul/` directly; Soul artifacts go through Chat or the UI, per `AGENTS.md`.
- **Does not clean up.** `qa-*` artifacts are left for you to remove.

Full rules in [`conventions.md`](conventions.md).

## What you get

Findings are logged as they occur and triaged at the end — severity-ordered, each with repro steps,
expected vs actual, a screenshot, and console/network excerpts. Per finding you choose:

- **Fix now** — a subagent diagnoses the root cause with `file:line` evidence and waits for your
  approval before editing anything.
- **File issue** — deduped against open `qa-agent`/`bug` issues, then filed to
  `TulipFarm/tulipfarm` with the full record.
- **Known issue** — added to `known-issues.md`, never reported again.
- **Ignore**.

Severity: **P0** flow dead / data loss / security · **P1** major functional · **P2** minor
functional or a11y · **P3** visual, copy, polish. Everything is reportable, down to small UI issues.

## Adding a playbook

See the authoring rules at the end of [`conventions.md`](conventions.md), then register it in
[`playbooks/index.md`](playbooks/index.md).
