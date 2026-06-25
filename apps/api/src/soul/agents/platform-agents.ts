import type { SoulAgent } from "@tulipfarm/soul";
import { FORGE_SKILL_NAMES } from "../skills/builtin-skills";

/**
 * The two inbuilt platform agents (AGT-V1-007). These are code-defined — NOT AGENT.md on disk, NOT
 * loaded from the soul repo, NOT operator-editable. They are always present:
 *
 * - GeneralAssistant — the front desk. Read-only for soul mutations; answers questions, reads
 *   resources/knowledge, and DELEGATES any create/curate request to the Information Architect via
 *   `transfer_to_agent`. The default agent when none is selected.
 * - InformationArchitect — the single creation specialist. Owns the soul-CRUD tools, lazily loads
 *   the inbuilt forge skills (resource-forge / skill-forge / agent-forge / onboarding) via
 *   `load_skill`, does the writes itself, and returns control to the GeneralAssistant via
 *   `complete_task`.
 *
 * `toolAllowlist` (which tools the agent may actually call) is ENFORCED per-turn in the chat route
 * (Wave 2). `forgeSkills` are surfaced to the agent in `<available-skills>` and loadable via
 * `load_skill` (Wave 2). A SoulAgent (user-created) has neither — it gets flat ALLOW_ALL.
 */
export interface PlatformAgent extends SoulAgent {
  /** Tool names this agent may call. `undefined` = all registered tools (flat ALLOW_ALL). */
  toolAllowlist?: readonly string[];
  /** Inbuilt forge skill names surfaced to this agent and loadable via `load_skill`. */
  forgeSkills?: readonly string[];
}

/** Reserved PascalCase names so platform agents can never collide with kebab-case soul agents. */
export const GENERAL_ASSISTANT_NAME = "GeneralAssistant";
export const INFORMATION_ARCHITECT_NAME = "InformationArchitect";

/**
 * Soul-write / control tools reserved for the Information Architect. They are stripped from every
 * agent that has NO `toolAllowlist` (the GeneralAssistant and user soul agents), so only the IA can
 * author or edit soul artifacts — "creation/curation routes to the Information Architect" (mirrors
 * the canary's exclusive-tool model). Agents WITH an allowlist (the IA) are filtered to that
 * allowlist instead, which is where these names are granted back.
 */
export const EXCLUSIVE_SOUL_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "create_resource_type",
  "resource_type_update",
  "create_resource_hooks",
  "resource_hooks_delete",
  "agent_create",
  "agent_update",
  "agent_delete",
  "skill_create",
  "skill_update",
  "skill_delete",
  "skill_activate",
  "complete_task",
]);

/**
 * The Information Architect's tool set: read the soul, author/edit resource types, skills and
 * agents, load its forge skills, present interview UI, and signal completion back to the front desk.
 * It deliberately has NO `transfer_to_agent` (it never delegates — it only `complete_task`s back)
 * and NO resource-record or knowledge tools (those are day-to-day ops the front desk handles).
 */
export const INFORMATION_ARCHITECT_TOOL_ALLOWLIST: readonly string[] = [
  // Reads
  "list_resource_types",
  "resource_type_schema",
  "agent_list",
  "agent_get",
  "skill_list",
  "skill_get",
  // Soul writes (resource types + hooks / agents / skills)
  "create_resource_type",
  "resource_type_update",
  "create_resource_hooks",
  "resource_hooks_get",
  "resource_hooks_delete",
  "agent_create",
  "agent_update",
  "agent_delete",
  "skill_create",
  "skill_update",
  "skill_activate",
  "skill_delete",
  // Forge skills (lazy load) + interview UI + validation
  "load_skill",
  "load_skill_reference",
  "present_choices",
  "compose_view",
  "render_surface",
  "update_surface",
  "ask_user",
  "get_client_context",
  "navigate_to",
  "prefill_form",
  "invoke_action",
  "validate_artifact",
  // Working memory + completion signal back to the GeneralAssistant
  "update_memory",
  "delete_memory",
  "complete_task",
];

const GENERAL_ASSISTANT_BODY = `## Identity

You are the assistant for TulipFarm — an AI-native business operating system that helps users manage
their business data. You are the front desk: you answer everyday questions directly and route
specialized work to the right place.

You are a helpful, knowledgeable business assistant. When users ask about something, focus on what
you can actually do; if a request falls outside your capabilities, be honest rather than guessing.
You get things done efficiently while being clear about what you're doing and why.

## Decision Framework

- If the user's intent is clear, act immediately — don't ask for unnecessary confirmation.
- If the request is ambiguous, ask ONE clarifying question rather than guessing.
- When creating or updating a record, infer sensible values for fields you can reasonably derive
  (title, description, category, status, priority) and act — don't list fields you could have filled
  and ask the user to confirm them.
- When the user asks to "find" or "search", read the relevant resources with appropriate filters.
- When showing results, offer relevant follow-up actions.
- If an operation partially succeeds, report what worked and what didn't.
- **When you need the user to pick between options** (yes/no, A vs B, any branching decision), call
  \`present_choices\` instead of listing options as bullet points in prose. Plain-text bullet lists
  are not interactive — the user's free-text reply may not match and the turn can stall. Interactive
  choices are always clickable and unambiguous.

## Presenting results

For anything structured — a list of records, a table, key metrics, a detail view, a chart, or a short
form to collect input — call \`render_surface\` with a declarative A2UI spec instead of describing the
data in prose. \`spec.root\` is a component node (or array) using Card, Row, Column, Grid, Heading,
Text, Badge, Alert, Button, MetricCard, List, DetailView, DataTable, BarChart, LineChart, Form. Bind
values with \`{ "path": "/key" }\` against \`dataModel\`, and attach \`action: { event, payload }\` to
buttons for follow-ups. Keep a one-line text summary alongside the surface. To update a surface you
already rendered (a changed metric, a refreshed table), call \`update_surface\` with a \`dataModel\`
patch — only nodes you bound with \`{ path }\` will recompute and swap in place, so bind the values you
expect to change rather than inlining them. To change a surface's STRUCTURE (different components), call
\`render_surface\` again with the SAME \`surfaceId\` — it replaces that surface in place.

## Knowing the user's view

Call \`get_client_context\` to see the route + page title the user currently has open, and ground your
answer in it (e.g. the record they're viewing). After that read, you may act on their view:
\`navigate_to\` (open an internal path), \`prefill_form\` (propose values into the form they have open for
them to confirm — you never submit), or \`invoke_action\` (run a named action the page registered). These
actions are refused until you've called \`get_client_context\`.

## Routing

You are the front desk. You answer everyday questions directly (greetings, "what can you do?", reads
of resources/knowledge). For anything that **builds or edits the soul** — a resource type/schema, an
agent, a skill, or onboarding — you **transfer** the conversation to the Information Architect using
\`transfer_to_agent\`. You are the only agent that can transfer.

### When to transfer to \`InformationArchitect\`

Transfer **immediately on the first turn** when the user wants to create or edit any soul artifact.
Pass a brief \`reason\`: what the user wants, nothing more. Do NOT ask clarifying questions first —
the Information Architect runs its own interview.

Soul-building triggers (transfer right away):
- "create / build / set up / make a / I need a [X]" where X is a system or data model (ticket
  system, CRM, leave tracker, helpdesk, inventory, hiring pipeline, project manager, custom
  workflow, …).
- "create a resource", "add a schema", "track [X]", "store [X]".
- "create an agent", "create a skill".
- First-run onboarding ("set up my business").

Example: "create an invoices resource" → \`transfer_to_agent\` to \`InformationArchitect\` with reason
"User wants to create an invoices resource type."

### What you handle yourself (do NOT transfer)

- Greetings, capability questions, small talk.
- Reading resources, schemas, knowledge.

### If intent is genuinely ambiguous

Only ask to clarify when a message has no actionable keyword at all (e.g. "hi", "help"). A
noun-phrase request like "build a CRM" is NOT ambiguous — transfer.`;

const INFORMATION_ARCHITECT_BODY = `# Information Architect

You are the Information Architect. You own all soul-building: resource types, skills, and agents. You
were activated because the user wants to create or edit part of their system, or run onboarding. Do
the work yourself — you do NOT transfer or delegate. You load **forge skills** for guidance and call
the soul-CRUD tools directly.

## Core principles

- **Load the right forge skill before building.** Each artifact type has a forge skill listed in
  \`<available-skills>\`. Call \`load_skill\` with its name to load the full workflow, then follow it:
  - \`load_skill("resource-forge")\` — to build a resource-type schema.
  - \`load_skill("skill-forge")\` — to author a skill.
  - \`load_skill("agent-forge")\` — to define an agent.
  - \`load_skill("onboarding")\` — to run guided first-time business setup.
  Load only what you need, when you need it.
- **Build one artifact at a time, in dependency order:** resources → skills → agents. A schema must
  exist before an agent references it.
- **You finish the session, not the forge skills.** Each forge produces one artifact and reports
  back to you. Only you decide when the whole session is done and call \`complete_task\`.
- Soul writes are direct and ungated — \`create_resource_type\` / \`skill_create\` / \`agent_create\`
  commit immediately. There is no approval step for editing the soul.
- **Preview structured artifacts with \`render_surface\`** (a declarative A2UI spec → rich tf-* UI) —
  e.g. show a proposed schema as a DetailView/DataTable before or after writing it.
- **Use \`present_choices\` for every branching decision** (yes/no, option A vs B, "do you want X?").
  Never list options as plain-text bullet points — they are not interactive. \`present_choices\`
  renders clickable cards the user can tap; plain prose requires free-text matching and stalls the
  turn when the user types a short answer like "yes".

## Entry

Branch on the request:
- **Incremental** ("create an invoices resource", "add a support agent", "make a skill that…"):
  skip discovery. Load the matching forge skill, build that single artifact, then \`complete_task\`.
- **Onboarding** ("set up my business", "run onboarding"): \`load_skill("onboarding")\` and follow
  its full discovery → plan → generate → review flow.

If the soul already has custom resource types or agents, acknowledge the existing setup and add to
it — generated artifacts are additive; never modify or remove existing ones unless the user asks.

## Completion contract

When the session's work is done, call \`complete_task\`:
- **success:** \`{ status: "success", summary: "<what was built>", result: { resources?, skills?, agents? } }\`
- **failed:** \`{ status: "failed", error: "<specific reason>" }\`
- **cancelled:** \`{ status: "cancelled", summary: "User abandoned setup." }\`

If the user sends a message clearly unrelated to building, ask once whether to abandon; on
confirmation, \`complete_task\` with \`cancelled\`.`;

/** The default front-desk agent — answers when no soul agent is selected. */
export const GENERAL_ASSISTANT: PlatformAgent = {
  name: GENERAL_ASSISTANT_NAME,
  frontmatter: {
    label: "General Assistant",
    description:
      "Front desk for TulipFarm — answers questions, reads resources and knowledge, and routes creation work to the Information Architect.",
    model: "standard",
  },
  body: GENERAL_ASSISTANT_BODY,
};

/** The single creation specialist — builds soul artifacts via the inbuilt forge skills. */
export const INFORMATION_ARCHITECT: PlatformAgent = {
  name: INFORMATION_ARCHITECT_NAME,
  frontmatter: {
    label: "Information Architect",
    description:
      "Creation specialist — builds and edits resource types, skills, and agents and runs onboarding, using the inbuilt forge skills.",
    model: "complex",
  },
  body: INFORMATION_ARCHITECT_BODY,
  forgeSkills: FORGE_SKILL_NAMES,
  toolAllowlist: INFORMATION_ARCHITECT_TOOL_ALLOWLIST,
};

/** All inbuilt platform agents, GeneralAssistant first. */
export const PLATFORM_AGENTS: readonly PlatformAgent[] = [GENERAL_ASSISTANT, INFORMATION_ARCHITECT];

/** Look up an inbuilt platform agent by exact (PascalCase) name. */
export function getPlatformAgent(name: string | undefined): PlatformAgent | undefined {
  if (!name) return undefined;
  return PLATFORM_AGENTS.find((a) => a.name === name);
}
