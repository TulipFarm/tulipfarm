/**
 * Inbuilt forge skills (SKL-V1-005) — bundled with the app, NOT seeded into the soul repo and NOT
 * operator-editable. These are the lazily-loaded sidebar skills owned by the Information Architect
 * platform agent: it surfaces their `name` + `description` in `<available-skills>` and pulls the
 * full `body` on demand via `load_skill`. Ported from the canary forge skills, adapted to this
 * repo's tools (`create_resource_type`, `skill_create`/`skill_activate`, `agent_create`, …) and to
 * UUID record ids (RES-V1-001 — `_id` is a UUID, not a Mongo ObjectId).
 *
 * Scope: resource / skill / agent / onboarding. Routine + integration forges are deferred until
 * their `*_create` tools exist.
 */

export interface BuiltinSkill {
  name: string;
  description: string;
  body: string;
}

const RESOURCE_FORGE = `# Resource Forge Workflow

Guides building ONE resource-type schema at a time. The Information Architect's master flow decides
when the whole session is done and calls \`complete_task\` — this skill never calls it.

## Create Flow

### Step 0 — Overlap check
Call \`list_resource_types\` first. If an existing type overlaps with the request (same domain,
similar name, matching purpose), surface it and ask whether to **use it**, **edit it** (Edit Flow),
or **create a new one alongside it**. Only continue when the user wants a new type. This prevents
accidental duplicates.

### Step 1 — Identity
Establish: the singular kebab-case **name** (e.g. \`support-ticket\`), a one-sentence
**description**, and the core purpose. Infer sensible values from the request; only ask about what
you genuinely cannot determine.

### Step 2 — Fields
For each field collect: name (camelCase), type (string/number/boolean/date/enum/array/object/
reference), required-or-optional, and a short description. Declare ONLY the business fields. Suggest
sensible fields for the archetype. For a ticketing system, suggest a \`status\` field (e.g. \`todo\`,
\`in-progress\`, \`review\`, \`done\`) and an \`assignee\`/\`assigneeId\` reference.

Do NOT declare system fields — the platform auto-manages \`id\` (UUID primary key), \`createdAt\`,
\`updatedAt\`, and \`version\` on every record; declaring them just creates empty duplicate fields.
A human/display identifier (e.g. \`TICK-123\`) is a separate business field produced by
\`x-id-strategy\` (RES-V1-001), not the system id.

### Step 3 — Relationships (\`x-links\`)
Ask whether this resource references existing types. Encode each as \`x-links\`: the referencing
field points at the target type's record by \`_id\`. Links are validated on write (the target must
exist) and orphaned (not cascaded) on delete.

### Step 4 — Generate schema
Construct a JSON Schema 2020-12 object:
- \`$schema: "https://json-schema.org/draft/2020-12/schema"\`, \`type: object\` at the root.
- All fields under \`properties\`; required ones in \`required\`.
- \`x-links\` for relationships; declarative transforms (\`x-id-strategy\`, \`x-computed\`,
  \`x-normalize\`) where useful.

### Step 5 — Validate (optional)
If \`validate_artifact\` is available, validate the schema and fix any errors before presenting.

### Step 6 — Preview & approve
Summarise the type briefly (name, purpose, key fields) and ask for approval in one short sentence,
e.g. "Should I create the \`issue\` resource type?". Keep it concise — do not dump the full raw YAML.

### Step 7 — Write
On approval, call \`create_resource_type\` with the resource \`name\` and the \`schema\` (the JSON
Schema, serialised as YAML). This commits \`resources/<name>/schema.yml\` to the soul and
materialises the Postgres table.

### Step 8 — Hooks (optional)
After the resource type is created, assess whether it needs lifecycle hooks. Ask: "Does this
resource need custom before/after logic that declarative transforms can't cover?" Suggest hooks
when the schema implies cross-resource validation, conditional computation, or business-rule
enforcement. Common triggers:

- A field references another resource type and writes need to validate a value on the target (not
  just existence — \`x-links\` handles existence). Example: checking the target's balance or status.
- Status transitions need to be guarded (e.g. only \`pending\` → \`approved\` or \`rejected\`).
- A computed field depends on data from another resource (cross-resource join at write time).
- A date range needs business-day calculation or overlap detection.

If the user wants hooks, or you recommend them and the user agrees:

1. Interview for the before/after logic: what should happen before a record is saved? After?
2. Write the hook as a parenthesized object literal with \`before\` and/or \`after\` async functions.
   The sandbox provides \`ctx\` with:
   - \`ctx.record\` — the record data (pre-persist in \`before\`, post-persist in \`after\`)
   - \`ctx.patch({...})\` — merge fields into the record (**before** hook only)
   - \`ctx.resources.get(type, id)\` — read another resource from Postgres (async)
   - \`ctx.hash(str)\` — SHA-256 hex digest
   - \`ctx.uuid()\` — random UUID
   - \`ctx.now\` — fixed timestamp for the run (milliseconds)
3. **Banned patterns** (static analysis rejects these): \`require()\`, \`import()\`, \`eval()\`,
   \`Function()\`, \`process\`, \`global\`, \`Buffer\`, \`fetch()\`, \`setTimeout\`, \`setInterval\`,
   \`setImmediate\`, \`queueMicrotask\`. No network, no Node APIs — pure computation + \`ctx\` only.
4. Preview the hook source and ask for approval.
5. On approval, call \`create_resource_hooks\` with \`name\` and \`source\`.
6. To read existing hooks: \`resource_hooks_get\`. To remove: \`resource_hooks_delete\`.

Hooks fire on **Create**, **Update**, and **Delete**. The \`before\` hook can block the operation
by throwing an Error. The \`after\` hook is best-effort and never fails the request.
For Delete, the \`before\` hook receives the existing record and can prevent deletion; \`ctx.patch()\`
has no effect since no business data is persisted on delete.

### Step 9 — Report
Confirm what was created in one sentence (name + field count + whether hooks were added). Do NOT
call \`complete_task\` — the master flow owns session completion.

## Edit Flow
1. \`resource_type_schema\` to load the current schema. \`resource_hooks_get\` to check for hooks.
2. Interview the user about the change; describe it in plain language (no raw dumps).
3. Validate, then \`resource_type_update\` to apply schema changes.
4. If hooks need adding/editing: \`create_resource_hooks\`. If removing: \`resource_hooks_delete\`.
5. Report the change in one sentence.

## Error handling
Recoverable issues (bad field type, validation failure, user changes mind): fix and retry. A logical
dead end (validation fails repeatedly, impossible schema): stop and report the specific error so the
Information Architect can decide how to proceed.`;

const SKILL_FORGE = `# Skill Forge Workflow

Guides creating or editing a **skill** — a stateless, atomic capability carrying instructions for a
single well-defined task (SKILL.md = \`name\` + \`description\` + markdown body). Skills are loaded by
agents on demand via \`load_skill\`. They have no identity and no memory.

## Decide first: skill or agent?
If the request needs to remember state across turns, own a persona, or coordinate other skills, it
is an **agent** — stop and use \`agent-forge\` instead. Proceed only for a single repeatable task
("write release notes", "triage a ticket", "format a report").

## Create Flow

### Step 1 — Purpose & duplicates
Call \`skill_list\` to show existing skills (avoid duplicates, anchor naming). Confirm the single
task this skill performs and which agents will use it.

### Step 2 — Identity
- **name**: kebab-case, \`^[a-z][a-z0-9-]*$\`, equal to the skill's directory name.
- **description**: one sentence written as a trigger condition for an LLM reader — specific tool
  names, 3–5 task types, synonyms, and action verbs. A vague description never fires; this is the #1
  reason skills don't activate.

### Step 3 — Instruction body
Write the markdown body as direct instructions to an agent: a one-line purpose, numbered steps,
input/output examples, and edge-case/failure handling. Keep it lean (push bulky material into
\`references/\`). Put gotchas inline next to the relevant step — they are the highest-value content.
Only declare \`requires\` tools that actually exist; the registry skips a skill whose \`requires\`
aren't in the agent's tool set.

### Step 4 — Safety anti-patterns (will fail the audit)
Do NOT write unbounded autonomy ("never ask the user"), data-exfiltration (auto-POST user data to
external URLs), or dangerous commands as direct instructions (\`rm -rf\`, \`--force\`, \`DROP TABLE\`).
Scope any autonomy narrowly. Skills inform, they don't override the agent's judgment.

### Step 5 — Validate, preview, write
1. If \`validate_artifact\` is available, validate the assembled SKILL.md first.
2. Present the draft concisely (name + description + a short body summary) and ask for approval.
3. On approval call \`skill_create\` with \`name\`, \`body\`, and \`frontmatter\` ({ description,
   tags?, requires? }). This commits the skill in a **pending-audit** state and runs the SkillAudit
   reviewer, returning a safety report. (If no LLM is configured the tool returns \`audit_required\`
   — tell the user to configure a provider, then retry.)
4. Show the user the audit's risk rating + summary. The audit is **advisory** — the operator still
   confirms. On confirmation, call \`skill_activate\` with the \`name\` to make the skill live.
5. Confirm in one line: "the \`<name>\` skill is now live". Do NOT call \`complete_task\` — the
   master flow owns session completion.

## Edit Flow
\`skill_list\` → read the target → interview → describe the diff in plain language → \`skill_update\`.
Builtin forge skills cannot be edited; offer to fork under a new name instead.`;

const AGENT_FORGE = `# Agent Forge Workflow

Guides creating or editing an **agent** — a persona (not code) with a system-prompt body and
frontmatter that define how it operates. Agents are AGENT.md: frontmatter (label, domain,
description, model, autonomy, placeholder, suggestions) + a markdown body that becomes the system
prompt.

## Create Flow — interview, don't guess
Conduct a short step-by-step interview before proposing the agent, even if the initial prompt gives
the role. Walk the decision tree one question at a time, giving your recommended answer for each. If
a question can be answered from the soul, explore it first (\`agent_list\`, \`resource_type_schema\`).

### Step 1 — Role
What role does the agent fill (e.g. "support triage", "sprint planner") and its one-sentence
purpose? Call \`agent_list\` to show existing agents.

### Step 2 — Personality & constraints
Communication style (formal/casual/technical/friendly), what it optimises for, and what it must
never do.

### Step 3 — Model & autonomy
- **model**: \`quick\` | \`standard\` | \`complex\` (default \`standard\`).
- **autonomy**: \`supervised\` (default) | \`full\` | \`approval-required\` | \`manual\`.
  \`approval-required\` gates every mutating tool behind human approval; \`supervised\`/\`full\` run
  without per-action gates; \`manual\` gates every tool call.

### Step 4 — UI
Optional: 2–3 cycling input **placeholder** hints and 3–6 **suggestion** chips for quick starts.

### Step 5 — Generate AGENT.md
Body: a Role section, Decision Principles, Communication Style, and Constraints. Frontmatter: name,
label, domain, description, model, autonomy, and optional placeholder/suggestions.

### Step 6 — Validate, preview, write
1. If \`validate_artifact\` is available, validate the assembled AGENT.md.
2. Present the draft concisely and ask for approval.
3. On approval call \`agent_create\` with \`name\` (kebab-case) and \`body\` plus \`frontmatter\`
   ({ label, domain, description, model?, autonomy?, placeholder?, suggestions? }). This commits
   \`agents/<name>/AGENT.md\` and reloads the registry, so the new agent is immediately selectable.
4. Confirm in one line and suggest follow-ups (e.g. "create a skill tailored for <name>"). Do NOT
   call \`complete_task\` — the master flow owns session completion.

## Edit Flow
\`agent_list\`/\`agent_get\` → interview → describe the diff in plain language → \`agent_update\`.`;

const ONBOARDING = `# Onboarding Workflow

Runs a guided first-time setup that generates a starter set of soul artifacts for the user's
business. Use this when the user wants to "set up my business" / "run onboarding" / "add a new
domain". For a single incremental request ("create an invoices resource"), skip this and use the
matching forge directly.

## Flow (sequential)

### 1. Discovery
Use \`present_choices\` (if available) to offer domain starting points plus Custom: Software
Development, Customer Support, Sales & CRM, HR & People Ops, General Operations, Custom. Then run a
focused 3–5 minute interview: the entities to track, the workflows to automate, the team roles, and
the external tools used. Use \`present_choices\` for structured picks and plain language for open
questions.

### 2. Plan
Summarise what you'll generate (counts of resources, skills, agents) and **wait for the user to
confirm** before generating.

### 3. Generate (one at a time, in dependency order)
1. **Resources** — for each entity: \`load_skill("resource-forge")\`, follow it, \`create_resource_type\`.
2. **Skills** — \`load_skill("skill-forge")\`, follow it, \`skill_create\` (+ \`skill_activate\`).
3. **Agents** — \`load_skill("agent-forge")\`, follow it, \`agent_create\` (reference the resources
   and skills just built).

A schema must exist before an agent references it. If a forge hits a dead end after retries, build a
simplified version rather than skipping it.

### 4. Review & complete
Summarise everything created (with which agents use which skills / reference which resources). Handle
revise-per-artifact by rebuilding that single artifact with the matching forge. When the user is
satisfied, record completion in working memory (\`update_memory\`:
\`onboarding_completed\` = \`true\`, \`onboarding_domain\` = \`"<domain>"\`) and call \`complete_task\`
with a \`success\` summary listing what was created, so the General Assistant resumes and can suggest
next steps.`;

/**
 * The inbuilt forge skills, keyed by name. Surfaced (frontmatter only) to the Information Architect
 * and loaded on demand via `load_skill`.
 */
export const BUILTIN_SKILLS: Map<string, BuiltinSkill> = new Map(
  [
    {
      name: "resource-forge",
      description:
        "Forge a resource-type schema: design fields, relationships (x-links) and transforms, then create_resource_type. Use when the user wants to create/define/add a resource type, schema, data model, or 'track X'.",
      body: RESOURCE_FORGE,
    },
    {
      name: "skill-forge",
      description:
        "Forge a skill (SKILL.md): a stateless, single-task capability loaded by agents on demand. Use when the user wants to create/author/add a skill, capability, or reusable instruction. Writes via skill_create + skill_activate.",
      body: SKILL_FORGE,
    },
    {
      name: "agent-forge",
      description:
        "Forge an agent (AGENT.md): a persona with a system prompt, model and autonomy. Use when the user wants to create/add/build an agent, assistant, or persona. Writes via agent_create.",
      body: AGENT_FORGE,
    },
    {
      name: "onboarding",
      description:
        "Run guided first-time business onboarding: discovery interview, then generate a starter set of resources, skills and agents via the forges. Use for 'set up my business', 'run onboarding', or 'add a new domain'.",
      body: ONBOARDING,
    },
  ].map((s) => [s.name, s])
);

/** Names of the inbuilt forge skills the Information Architect surfaces and can load. */
export const FORGE_SKILL_NAMES: readonly string[] = Array.from(BUILTIN_SKILLS.keys());
