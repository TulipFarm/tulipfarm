---
name: agent-forge
description: "Forge an Agent (AGENT.md): define its persona, model, autonomy, and UI guidance."
category: forge
tools: [agent_list, agent_get, agent_create, agent_update, validate_artifact, present, request_input]
---
# Agent Forge Workflow

Guides creating or editing an **Agent** — a persona (not code) with a system-prompt body and
frontmatter that define how it operates. Agents use AGENT.md: frontmatter (label, domain,
description, model, autonomy, capabilityRestrictions, placeholder, suggestions) + a markdown body
that becomes the system prompt.

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

**Every "must never" answer becomes `capabilityRestrictions`, not prose.** Body text is advice the
model may talk itself out of; `capabilityRestrictions` is checked by the server before the Tool
runs, so a forbidden call is refused even when the model is persuaded to make it. Write the
constraint in the body *as well*, so the Agent can explain itself — but the frontmatter is what
enforces it.

| The user said | Frontmatter to emit |
| --- | --- |
| "read-only", "may only look things up", "never changes anything" | `tools: { allowMutating: false }` |
| "must never delete records" | `records: { actions: { deny: [delete] } }` |
| "must never delete a Ticket" | `records: { resourceTypes: [ticket], actions: { deny: [delete] } }` |
| "may only list and view records" | `records: { actions: { allow: [list, search, read] } }` |
| "must not define new resource types" | `resourceTypes: { actions: { deny: [create, update] } }` |
| "must never use `record_delete`" | `tools: { deny: [record_delete] } }` |

Keys and values, all optional:

- `tools.allow` (Tool names — everything else is refused), `tools.deny` (Tool names),
  `tools.allowMutating: false` (refuses every Tool that writes).
- `records.actions.allow` / `records.actions.deny` over `list`, `search`, `read`, `create`,
  `update`, `delete`; `records.resourceTypes` narrows those actions to the named types only.
- `resourceTypes.actions.allow` / `.deny` over `list`, `read`, `create`, `update`;
  `resourceTypes.names` narrows them to the named types only.

`allowMutating: false` never removes the Agent's ability to finish its work — `present`,
`request_input`, `complete_task` and `complete_state` always stay available. It *does* remove
`delegate_to_agent`, which is the point: a read-only Agent must not be able to hand a mutation to
a laxer one. Omit `capabilityRestrictions` entirely for an Agent with no hard limits; an absent
field means unrestricted.

### Step 3 — Model & autonomy

- **model**: `fast` | `balanced` | `thorough` (default `balanced`). The old tier names
  `quick`/`standard`/`complex` are still accepted for one release and translated to these effort
  presets, but new Agents should be authored with the preset names.
- **autonomy**: `supervised` (default) | `full` | `approval-required` | `manual`.
  `approval-required` gates every mutating Tool behind human Approval; `supervised`/`full` run
  without per-action gates; `manual` gates every Tool call.

### Step 4 — UI

Optional: 2–3 cycling input **placeholder** hints and 3–6 **suggestion** chips for quick starts.

### Step 5 — Generate AGENT.md

Body: a Role section, Decision Principles, Communication Style, and Constraints. Frontmatter: name,
label, domain, description, model, autonomy, `capabilityRestrictions` for every hard limit from
Step 2, and optional placeholder/suggestions.

Example for "a read-only reporting agent that may never delete records":

```yaml
label: Reporting
domain: reporting
description: Lists and views records without changing them.
autonomy: full
capabilityRestrictions:
  tools:
    allowMutating: false
  records:
    actions:
      allow: [list, search, read]
      deny: [create, update, delete]
```

### Step 6 — Validate, preview, write

1. If `validate_artifact` is available, validate the assembled AGENT.md.
2. Present the draft concisely and ask for approval. State the enforced limits in plain words —
   "it will be refused by the server if it tries to delete a record" — so the user can correct
   them before they are committed.
3. On approval call `agent_create` with `name` (kebab-case) and `body` plus `frontmatter`
   ({ label, domain, description, model?, autonomy?, capabilityRestrictions?, placeholder?,
   suggestions? }). This commits `agents/<name>/AGENT.md` and reloads the registry, so the new
   Agent is immediately selectable. An unknown frontmatter key is rejected — fix it and retry
   rather than dropping the restriction.
4. Confirm in one line and suggest follow-ups (e.g. "create a Skill tailored for <name>"). Do not
   call `complete_task` — the master flow owns session completion.

## Edit Flow

`agent_list`/`agent_get` → interview → describe the diff in plain language → `agent_update`.
`agent_update` replaces frontmatter wholesale, so carry `capabilityRestrictions` forward unless the
user asked to change it. Dropping it silently widens what the Agent may do.
