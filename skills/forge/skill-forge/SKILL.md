---
name: skill-forge
description: "Forge a Skill (SKILL.md): a stateless single-task unit, then audit and activate it."
category: forge
---
# Skill Forge Workflow

Guides creating or editing a **Skill** — a stateless, atomic unit carrying instructions for a
single well-defined task (SKILL.md = `name` + `description` + markdown body). Skills are loaded by
Agents on demand via `load_skill`. They have no identity and no Memory.

{{FORGE_EXECUTION_CONTRACT}}

## Decide first: Skill or Agent?

If the request needs to remember state across Turns, own a persona, or coordinate other Skills, it
is an **Agent** — stop and use `agent-forge` instead. Proceed only for a single repeatable task
("write release notes", "triage a ticket", "format a report").

## Create Flow

### Step 1 — Purpose & duplicates

Call `skill_list` to show existing Skills (avoid duplicates, anchor naming). Confirm the single
task this Skill performs and which Agents will use it.

### Step 2 — Identity

- **name**: `^[a-z0-9][a-z0-9._-]*$` (maximum 64 characters), equal to the Skill's directory name.
- **description**: one sentence written as a trigger condition for an LLM reader — specific Tool
  names, 3–5 task types, synonyms, and action verbs. A vague description never fires; this is the #1
  reason Skills do not activate.

### Step 3 — Instruction body

Write the markdown body as direct instructions to an Agent: a one-line purpose, numbered steps,
input/output examples, and edge-case/failure handling. Keep it lean (push bulky material into
`references/`). Put gotchas inline next to the relevant step — they are the highest-value content.
Only declare `requires` Tools that actually exist; the registry skips a Skill whose `requires`
are not in the Agent's Tool set.

### Step 4 — Safety anti-patterns (will fail the audit)

Do not write unbounded autonomy ("never ask the user"), data-exfiltration (auto-POST user data to
external URLs), or dangerous commands as direct instructions (`rm -rf`, `--force`, `DROP TABLE`).
Scope any autonomy narrowly. Skills inform; they do not override the Agent's judgment.

### Step 5 — Validate, preview, write

1. If `validate_artifact` is available, validate the assembled SKILL.md first.
2. Present the draft concisely (name + description + a short body summary) and ask for approval.
3. On approval call `skill_create` with `name`, `body`, and `frontmatter` ({ name,
   description, tags?, requires? }). The frontmatter name must equal the Skill name. This commits
   the Skill in a **pending-audit** state and runs the SkillAudit reviewer, returning a safety
   report. (If no LLM is configured the Tool returns `audit_required` — tell the user to configure
   a provider, then retry.)
4. Show the user the audit's risk rating + summary. The audit is **advisory** — the operator still
   confirms. On confirmation, call `skill_activate` with the `name` to make the Skill live.
5. Confirm in one line: "the `<name>` Skill is now live". Do not call `complete_task` — the
   master flow owns session completion.

## Edit Flow

`skill_list` → read the target → interview → describe the diff in plain language → `skill_update`.
Bundled forge Skills use copy-on-write: editing materializes a Soul override while the bundled
source stays read-only.
