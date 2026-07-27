---
name: agent-forge
description: "Forge an Agent (AGENT.md): define its persona, model, autonomy, and UI guidance."
category: forge
---
# Agent Forge Workflow

Guides creating or editing an **Agent** — a persona (not code) with a system-prompt body and
frontmatter that define how it operates. Agents use AGENT.md: frontmatter (label, domain,
description, model, autonomy, placeholder, suggestions) + a markdown body that becomes the system
prompt.

{{FORGE_EXECUTION_CONTRACT}}

## Create Flow — interview, don't guess

Conduct a short step-by-step interview before proposing the Agent, even if the initial prompt gives
the role. Walk the decision tree one question at a time, giving your recommended answer for each. If
a question can be answered from the Soul, explore it first (`agent_list`, `resource_type_schema`).

### Step 1 — Role

What role does the Agent fill (e.g. "support triage", "sprint planner") and its one-sentence
purpose? Call `agent_list` to show existing Agents.

### Step 2 — Personality & constraints

Communication style (formal/casual/technical/friendly), what it optimizes for, and what it must
never do.

### Step 3 — Model & autonomy

- **model**: `quick` | `standard` | `complex` (default `standard`).
- **autonomy**: `supervised` (default) | `full` | `approval-required` | `manual`.
  `approval-required` gates every mutating Tool behind human Approval; `supervised`/`full` run
  without per-action gates; `manual` gates every Tool call.

### Step 4 — UI

Optional: 2–3 cycling input **placeholder** hints and 3–6 **suggestion** chips for quick starts.

### Step 5 — Generate AGENT.md

Body: a Role section, Decision Principles, Communication Style, and Constraints. Frontmatter: name,
label, domain, description, model, autonomy, and optional placeholder/suggestions.

### Step 6 — Validate, preview, write

1. If `validate_artifact` is available, validate the assembled AGENT.md.
2. Present the draft concisely and ask for approval.
3. On approval call `agent_create` with `name` (kebab-case) and `body` plus `frontmatter`
   ({ label, domain, description, model?, autonomy?, placeholder?, suggestions? }). This commits
   `agents/<name>/AGENT.md` and reloads the registry, so the new Agent is immediately selectable.
4. Confirm in one line and suggest follow-ups (e.g. "create a Skill tailored for <name>"). Do not
   call `complete_task` — the master flow owns session completion.

## Edit Flow

`agent_list`/`agent_get` → interview → describe the diff in plain language → `agent_update`.
