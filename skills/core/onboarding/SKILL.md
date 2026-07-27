---
name: onboarding
description: "Run guided first-time business onboarding and generate a verified starter Soul."
category: core
---
# Onboarding Workflow

Runs a guided first-time setup that generates a starter set of Soul artifacts for the user's
business. Use this when the user wants to "set up my business" / "run onboarding" / "add a new
domain". For a single incremental request ("create an invoices Resource type"), skip this and use
the matching forge directly.

{{FORGE_EXECUTION_CONTRACT}}

## Flow (sequential)

### 1. Discovery

Use `present_choices` (if available) to offer domain starting points plus Custom: Software
Development, Customer Support, Sales & CRM, HR & People Ops, General Operations, Custom. Then run a
focused 3–5 minute interview: the entities to track, the work to automate, the team roles, and the
external systems used. Use `present_choices` for structured picks and plain language for open
questions.

### 2. Plan

Summarize what you will generate (counts of Resource types, Skills, Agents) and **wait for the user
to confirm** before generating.

### 3. Generate (one at a time, in dependency order)

1. **Resource types** — for each entity: `load_skill("resource-forge")`, follow it,
   `create_resource_type`.
2. **Skills** — `load_skill("skill-forge")`, follow it, `skill_create` (+ `skill_activate`).
3. **Agents** — `load_skill("agent-forge")`, follow it, `agent_create` (reference the Resource
   types and Skills just built).

A Schema must exist before an Agent references it. If a forge hits a dead end after retries, build a
simplified version rather than skipping it.

### 4. Review & complete

Summarize everything created (with which Agents use which Skills / reference which Resource types).
Handle revise-per-artifact by rebuilding that single artifact with the matching forge. When the user
is satisfied, record completion in working Memory (`update_memory`:
`onboarding_completed` = `true`, `onboarding_domain` = `"<domain>"`) and report a
`success` summary listing what was created and relevant next steps.
