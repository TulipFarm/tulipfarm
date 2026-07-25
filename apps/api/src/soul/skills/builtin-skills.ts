/**
 * Inbuilt forge skills (SKL-V1-005) — bundled with the app, NOT seeded into the soul repo and NOT
 * operator-editable. These are lazily-loaded sidebar skills available to normal chat: it surfaces
 * their `name` + `description` in `<available-skills>` and pulls the
 * full `body` on demand via `load_skill`. Ported from the canary forge skills, adapted to this
 * repo's tools (`create_resource_type`, `skill_create`/`skill_activate`, `agent_create`, …) and to
 * UUID record ids (RES-V1-001 — `_id` is a UUID, not a Mongo ObjectId).
 *
 * Scope: resource / skill / agent / routine / onboarding. The integration forge is deferred until
 * its `*_create` tool exists.
 */

export interface BuiltinSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * Hermes-style execution discipline, adapted for Soul creation. This appears inside every forge
 * body (not only the normal-chat harness) so loading a workflow preserves the same inspect → act
 * → verify contract through multi-step creation and onboarding flows.
 */
const FORGE_EXECUTION_CONTRACT = `## Execution Contract

- Inspect relevant existing Soul artifacts before writing, then use the creation or update tool that
  actually performs the requested change. Do not stop at a plan, draft, or preview.
- Treat a write as incomplete until it has a real tool result. Verify it with the relevant read,
  list, schema, status, or smoke-test tool when one is available.
- If validation or a tool call fails, use the returned error to correct the artifact and retry when
  the path is clear. If the request is genuinely blocked, report the specific blocker; never claim
  an artifact was created, activated, or tested when it was not.
- Keep dependent work ordered: inspect before changing, create prerequisites before dependants, and
  verify after changing. Batch independent inspection calls when the tool surface allows it.
- Respect the user's explicit approval choice and the active autonomy/approval controls. Ask one
  focused question only when the missing decision materially changes the artifact.`;

const RESOURCE_FORGE = `# Resource Forge Workflow

Guides building ONE resource-type schema at a time. The chat harness owns the whole session; this
skill reports its outcome directly.

${FORGE_EXECUTION_CONTRACT}

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
Summarise the type briefly (name, purpose, key fields) and use \`present_choices\` for approval
(e.g. "Create it" / "Edit first" / "Cancel"). Keep the summary concise — do not dump the full raw
YAML. Never list approval options as plain-text bullets.

### Step 7 — Write
On approval, call \`create_resource_type\` with the resource \`name\` and the \`schema\` (the JSON
Schema, serialised as YAML). This commits \`resources/<name>/schema.yml\` to the soul and
materialises the Postgres table.

### Step 8 — Hooks (optional)
After the resource type is created, assess whether it needs lifecycle hooks. Use \`present_choices\`
to ask whether hooks are needed — never list the options as plain-text bullets. If you recommend
hooks, explain why in one sentence, then present the choice. Common triggers that suggest hooks:

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
dead end (validation fails repeatedly, impossible schema): stop and report the specific error.`;

const SKILL_FORGE = `# Skill Forge Workflow

Guides creating or editing a **skill** — a stateless, atomic unit carrying instructions for a
single well-defined task (SKILL.md = \`name\` + \`description\` + markdown body). Skills are loaded by
agents on demand via \`load_skill\`. They have no identity and no memory.

${FORGE_EXECUTION_CONTRACT}

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

${FORGE_EXECUTION_CONTRACT}

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

${FORGE_EXECUTION_CONTRACT}

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
\`onboarding_completed\` = \`true\`, \`onboarding_domain\` = \`"<domain>"\`) and report a
\`success\` summary listing what was created and relevant next steps.`;

const ROUTINE_FORGE = `# Routine Forge Workflow

Guides authoring or editing ONE **routine** — a scheduled/triggered automation that runs a
deterministic sequence of steps (CNCF Serverless Workflow 0.8 subset + \`x-\` extensions). A routine
lives at \`soul/routines/<slug>/routine.yaml\` (+ optional \`hooks.ts\`). The chat harness owns the
whole session; this skill reports its outcome directly.

${FORGE_EXECUTION_CONTRACT}

## Decide first: routine, agent, or skill?
- **Routine** — a repeatable, mostly-deterministic pipeline on a trigger ("every morning at 9, tag
  overdue tickets and email a digest"; "when a lead is created, score it and notify sales"). Steps
  call tools, agents, or hook functions and pass data between states.
- If it needs a persona / free-form conversation → **agent** (\`agent-forge\`). If it is a single
  stateless instruction an agent loads on demand → **skill** (\`skill-forge\`). Stop and switch.

## V1 surface (anything outside this is rejected at write with a "deferred in V1" error)
- **States:** \`operation\` (call tools/agents/hooks), \`switch\` (branch), \`foreach\` (iterate,
  cap 1000), \`sleep\` (ISO-8601 duration), \`inject\` (merge literal data). Deferred: \`parallel\`,
  \`event\` state, sub-routine (\`subFlowRef\`).
- **Triggers (\`x-triggers\`, ≥1):** \`manual\`, \`cron\` (\`schedule\` cron expr, optional
  \`timezone\`), \`webhook\` (\`secret_ref\` → a secret name), \`event\` (\`event\` ∈
  resource.created·resource.updated·conversation.created·conversation.completed·integration.event,
  optional \`filter\`), \`agent\`. Deferred: \`datetime\`, \`integration\`.
- **Approval channels:** \`ui\` (always), \`slack\` (if the Slack integration is present).
  \`email\`/\`sms\` are schema-accepted but fall back to \`ui\`.

## Create Flow — interview one step at a time, recommend an answer for each

### Step 1 — Purpose & trigger(s)
Establish the one-sentence purpose and what starts it. Pick trigger type(s) and their config
(cron \`schedule\`, webhook \`secret_ref\`, event \`event\` name + optional \`filter\`). Most routines
have exactly one trigger; declare \`{ type: "manual" }\` too if the user should be able to run it
by hand from the Routines UI.

### Step 2 — Inputs (\`x-inputs\`, optional)
If a manual/webhook/agent run needs parameters, declare \`x-inputs\` as a JSON Schema. It renders the
manual-trigger form and validates webhook/agent payloads. Inputs arrive at runtime as
\`trigger.payload\`.

### Step 3 — Functions
Every external call a state makes is a named entry in \`functions[]\` with \`operation\`:
- \`tool:<toolName>\` — a platform tool. Common ones: \`record_search\`, \`record_get\`,
  \`record_create\`, \`record_update\`, \`record_delete\` (resource-record CRUD). Only reference
  tools you know exist; a bad name fails at runtime, not at write.
- \`agent:<agentName>\` — spawn a headless agent turn (pass its brief as an \`arguments.task\`
  string). Confirm the agent exists with \`agent_list\` first.
- \`hook:<fnName>\` — a function you define in \`hooks.ts\` (Step 7) for pure in-routine computation.

### Step 4 — States & flow
Design the state machine. Rules the writer enforces:
- \`start\` names the first state. Each state is \`operation|switch|foreach|sleep|inject\` and either
  \`transition\`s to another state's name or sets \`end: true\`. State names match \`^[A-Za-z][A-Za-z0-9]*$\`
  (PascalCase, no spaces/hyphens). Every \`transition\`/condition target must be a real state name.
- **operation:** \`actions: [{ functionRef: { refName, arguments? }, actionDataFilter?, retryRef? }]\`.
  Store a call's result into run data with \`actionDataFilter: { toStateData: "someKey" }\` (optionally
  transform first with \`results: "\${ result.foo }"\`) so later states can read \`context.someKey\`.
- **switch:** \`dataConditions: [{ condition: "<js>", transition|end }]\` + optional
  \`defaultCondition\`. First truthy condition wins.
- **foreach:** \`inputCollection: "<js yielding an array>"\`, optional \`iterationParam\` (default
  \`item\`), and \`actions\` run per element. The element is in scope as that param.
- **sleep:** \`duration: "PT5M"\` (ISO-8601). **inject:** \`data: { ... }\` merged into \`context\`.

### Step 5 — Expressions (\`\${ ... }\`)
Argument values, switch \`condition\`s, foreach \`inputCollection\`, and data filters are JS strings
evaluated in an isolated sandbox (100ms, no host/network/fs). In scope: \`context\` (accumulated run
data), \`trigger.type\` / \`trigger.payload\`, the foreach iteration param, and \`result\` inside an
\`actionDataFilter.results\`. Argument strings of the form \`"\${ <js> }"\` are evaluated; plain
strings pass through literally.

### Step 6 — Errors & retries (optional)
- \`retries: [{ name, maxAttempts, delay?: "PT2S", multiplier? }]\`; reference from an action via
  \`retryRef\`. Exponential backoff when \`multiplier\` > 1.
- Per-state \`onErrors: [{ errorRef: "<name>"|"*", transition?|end? }]\` routes failures to a
  recovery state or a clean end. Retries win while attempts remain, then \`onErrors\`, else the run fails.
- Optional per-state \`timeouts: { stateExecTimeout: "PT30S" }\`.

### Step 7 — Human approval (optional)
Gate a step behind a person: on an \`operation\`/\`foreach\` state set
\`x-autonomy-level: human_approval\` and \`x-approval-channel: ["ui"]\` (add \`"slack"\` when Slack is
connected). The run pauses in \`waiting_approval\` and resumes on the decision. Only valid on
operation/foreach states.

### Step 8 — Hooks (\`hooks.ts\`, optional)
For pure computation the states cannot express, pass a \`hooks\` string: a parenthesized object
literal, NO import/export:
\`({ beforeHook(ctx){}, afterHook(ctx){}, before<State>(ctx){}, after<State>(ctx){}, <fnName>(ctx, args){} })\`.
- \`beforeHook\`/\`afterHook\` fire once around the whole run; \`before<State>\`/\`after<State>\` around
  that state. Step-callable \`<fnName>\` are invoked by a function with \`operation: "hook:<fnName>"\`
  and receive \`(ctx, args)\` — the return value is stored like any action result.
- \`ctx\` provides \`ctx.runId\`, \`ctx.slug\`, \`ctx.stateName\`, \`ctx.context\` (run data),
  \`ctx.trigger\`. Pure computation only — same **banned patterns** as resource hooks: no
  \`require\`/\`import\`/\`eval\`/\`Function\`/\`process\`/\`global\`/\`Buffer\`/\`fetch\`/\`setTimeout\`/
  \`setInterval\`/\`setImmediate\`/\`queueMicrotask\`, no network, no Node APIs.

### Step 9 — Validate, preview, write
1. Assemble the \`definition\` object (id = the slug, \`version\` e.g. "1.0", \`start\`, \`states\`,
   \`functions?\`, \`retries?\`, \`x-triggers\`, \`x-inputs?\`).
2. Preview it concisely (purpose, trigger, the state flow as a short list) with \`render_surface\` or
   plain text — do NOT dump raw YAML — and get approval via \`present_choices\`.
3. On approval call \`routine_forge\` with \`name\` (the slug), \`definition\`, and \`hooks?\` (the
   object-literal source). It validates against the V1 meta-schema, writes
   \`routines/<slug>/routine.yaml\` (+ \`hooks.ts\`), and commits — no approval step (ROUT-V1-002).
4. **Iterate on errors:** \`routine_forge\` returns \`validation_error\` with a JSON-pointer path and
   message (including "deferred in V1" for post-V1 constructs, and "transition target … not found" /
   "function … not found" for broken refs). Fix the definition and retry — do not work around it.

### Step 10 — Smoke-test (recommended)
For a routine with a \`manual\` trigger, offer to run it once: on the user's OK call
\`trigger_routine\` with the slug (+ inputs matching \`x-inputs\`) and report the run outcome. Warn
first if the routine performs real writes (\`record_create\`/\`update\`/\`delete\`), and skip the
test run if the user prefers. Otherwise point them to the Routines UI to run/monitor it.

### Step 11 — Report
Confirm in one sentence (slug + trigger + step count + whether it has hooks). Do NOT call
\`complete_task\` — the master flow owns session completion.

## Edit Flow
Read the existing routine (via the Routines UI / prior forge), interview the change, describe the
diff in plain language, then call \`routine_forge\` again with the SAME \`name\` and the full updated
\`definition\` (it overwrites). Re-smoke-test if the trigger/flow changed.

## Error handling
Recoverable (bad ref, schema violation, user changes mind): fix and retry. A hard dead end
(repeated validation failure, a construct that is genuinely deferred in V1): stop and report the
specific error.`;

/**
 * The inbuilt forge skills, keyed by name, surfaced to normal chat and loaded on demand via
 * `load_skill`.
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
        "Forge a skill (SKILL.md): a stateless, single-task unit loaded by agents on demand. Use when the user wants to create/author/add a skill or reusable instruction. Writes via skill_create + skill_activate.",
      body: SKILL_FORGE,
    },
    {
      name: "agent-forge",
      description:
        "Forge an agent (AGENT.md): a persona with a system prompt, model and autonomy. Use when the user wants to create/add/build an agent, assistant, or persona. Writes via agent_create.",
      body: AGENT_FORGE,
    },
    {
      name: "routine-forge",
      description:
        "Forge a routine (routine.yaml): a scheduled/triggered automation of tool/agent/hook steps (operation/switch/foreach/sleep/inject states; manual/cron/webhook/event/agent triggers). Use when the user wants to create/build/automate a workflow, schedule, pipeline, or 'when X happens do Y'. Writes via routine_forge.",
      body: ROUTINE_FORGE,
    },
    {
      name: "onboarding",
      description:
        "Run guided first-time business onboarding: discovery interview, then generate a starter set of resources, skills and agents via the forges. Use for 'set up my business', 'run onboarding', or 'add a new domain'.",
      body: ONBOARDING,
    },
  ].map((s) => [s.name, s])
);

/** Names of the inbuilt forge skills normal chat can load. */
export const FORGE_SKILL_NAMES: readonly string[] = Array.from(BUILTIN_SKILLS.keys());
