import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GitSyncService, SoulAgent, SoulRoutine, SoulSkill } from "@tulipfarm/soul";
import { ajv } from "@tulipfarm/validation";
import { A2UI_COMPONENTS_REF, A2UI_SPEC_SCHEMA } from "../a2ui/spec";
import { err, ok, type ToolCallResult } from "./tool-result";

export interface PlatformToolContext {
  soulLoader?: {
    skills: Map<string, SoulSkill>;
    agents: Map<string, SoulAgent>;
    routines?: Map<string, SoulRoutine>;
  };
  soulPath?: string;
  gitSync?: GitSyncService;
  routineContext?: { routineId: string; runId: string };
  /**
   * Inbuilt forge skills (resource-forge / skill-forge / agent-forge / onboarding) bundled with the
   * app, not present in the soul. `load_skill` falls back to these by name so the Information
   * Architect can pull a forge body on demand.
   */
  builtinSkills?: ReadonlyMap<string, { name: string; description: string; body: string }>;
  /** Reserved names of the code-defined platform agents, valid `transfer_to_agent` targets. */
  platformAgentNames?: ReadonlySet<string>;
}

export interface PlatformTool {
  name: string;
  description: string;
  mutating: boolean;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: PlatformToolContext) => Promise<ToolCallResult>;
}

type AjvErrors = ReturnType<typeof ajv.compile>["errors"];

function firstError(errors: AjvErrors): string {
  const e = errors?.[0];
  return e
    ? `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim()
    : "invalid arguments";
}

// ── load_skill ────────────────────────────────────────────────────────────────

const LOAD_SKILL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name as registered in the soul." },
  },
};
const validateLoadSkill = ajv.compile(LOAD_SKILL_SCHEMA);

export const loadSkillTool: PlatformTool = {
  name: "load_skill",
  description:
    "Load a skill's frontmatter and body by name so the agent can apply its instructions. Resolves soul skills and the inbuilt forge skills (resource-forge, skill-forge, agent-forge, onboarding). Graceful not_found when the skill is absent.",
  mutating: false,
  inputSchema: LOAD_SKILL_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateLoadSkill(args))
      return err("validation_error", firstError(validateLoadSkill.errors));
    const { name } = args as { name: string };
    const skill = ctx.soulLoader?.skills.get(name);
    if (skill) return ok({ name: skill.name, frontmatter: skill.frontmatter, body: skill.body });
    // Fall back to the bundled forge skills (not in the soul).
    const builtin = ctx.builtinSkills?.get(name);
    if (builtin)
      return ok({
        name: builtin.name,
        frontmatter: { description: builtin.description },
        body: builtin.body,
      });
    return err("not_found", `Skill "${name}" not found.`);
  },
};

// ── load_skill_reference ──────────────────────────────────────────────────────

const LOAD_SKILL_REFERENCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["skill", "reference"],
  properties: {
    skill: {
      type: "string",
      minLength: 1,
      pattern: "^[a-z][a-z0-9-]*$",
      description: "Skill name (kebab-case, as registered in the soul).",
    },
    reference: {
      type: "string",
      minLength: 1,
      description:
        "Reference filename (e.g. 'migration-playbook.md') within the skill's references/ directory.",
    },
  },
};
const validateLoadSkillRef = ajv.compile(LOAD_SKILL_REFERENCE_SCHEMA);

export const loadSkillReferenceTool: PlatformTool = {
  name: "load_skill_reference",
  description:
    "Load a reference file from a skill's references/ directory. Use this to pull in supporting material (playbooks, templates) that are too large to include in the skill body.",
  mutating: false,
  inputSchema: LOAD_SKILL_REFERENCE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateLoadSkillRef(args))
      return err("validation_error", firstError(validateLoadSkillRef.errors));
    const { skill, reference } = args as { skill: string; reference: string };
    if (!ctx.soulPath)
      return err("not_found", `Skill "${skill}" references directory not available.`);
    // Contain the read to the skill's references/ dir — `reference` is LLM-controlled, so a
    // `../`-escape (e.g. driven by a malicious skill) must not read outside the soul (SKL-V1-002).
    const base = resolve(ctx.soulPath, "skills", skill, "references");
    const refPath = resolve(base, reference);
    const rel = relative(base, refPath);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      return err(
        "validation_error",
        `Reference "${reference}" escapes the skill references directory.`
      );
    try {
      const content = await readFile(refPath, "utf8");
      return ok({ skill, reference, content });
    } catch {
      return err("not_found", `Reference "${reference}" not found for skill "${skill}".`);
    }
  },
};

// ── compose_view ──────────────────────────────────────────────────────────────

const COMPOSE_VIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["html"],
  properties: {
    html: {
      type: "string",
      minLength: 1,
      description:
        "HTML using tf-* web components (tf-card, tf-data-table, tf-schema-form, etc.). Rendered in the A2UI sandboxed iframe.",
    },
  },
};
const validateComposeView = ajv.compile(COMPOSE_VIEW_SCHEMA);

export const composeViewTool: PlatformTool = {
  name: "compose_view",
  description:
    "Emit an A2UI rich-content block using tf-* web components. The HTML is sanitised and rendered in a sandboxed iframe in the chat UI. Use tf-card, tf-data-table, tf-schema-form, tf-metric-card, tf-chart-bar, etc.",
  mutating: false,
  inputSchema: COMPOSE_VIEW_SCHEMA,
  handler: async (args, _ctx) => {
    if (!validateComposeView(args))
      return err("validation_error", firstError(validateComposeView.errors));
    const { html } = args as { html: string };
    return ok({ html });
  },
};

// ── render_surface ────────────────────────────────────────────────────────────

const RENDER_SURFACE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["surfaceId", "spec"],
  properties: {
    surfaceId: {
      type: "string",
      minLength: 1,
      description: 'A stable id for this surface, e.g. "q2-dashboard".',
    },
    spec: A2UI_SPEC_SCHEMA,
    dataModel: {
      type: "object",
      description:
        "Optional data object the spec's { path } bindings resolve against (JSON-pointer).",
    },
  },
};
const validateRenderSurface = ajv.compile(RENDER_SURFACE_SCHEMA);

export const renderSurfaceTool: PlatformTool = {
  name: "render_surface",
  description:
    "Render a rich UI surface from a declarative A2UI component spec (preferred over compose_view's raw HTML). `spec.root` is a component node or an array of nodes. The surface renders in the sandboxed iframe in chat. " +
    A2UI_COMPONENTS_REF,
  mutating: false,
  inputSchema: RENDER_SURFACE_SCHEMA,
  handler: async (args, _ctx) => {
    if (!validateRenderSurface(args))
      return err("validation_error", firstError(validateRenderSurface.errors));
    const { surfaceId, spec, dataModel } = args as {
      surfaceId: string;
      spec: unknown;
      dataModel?: Record<string, unknown>;
    };
    return ok({ surfaceId, spec, dataModel: dataModel ?? {} });
  },
};

// ── update_surface ────────────────────────────────────────────────────────────

const UPDATE_SURFACE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["surfaceId", "dataModel"],
  properties: {
    surfaceId: {
      type: "string",
      minLength: 1,
      description:
        "The id of a surface previously rendered with render_surface in this conversation.",
    },
    dataModel: {
      type: "object",
      description:
        "A patch merged into the surface's data model (top-level keys). Nodes bound via { path } recompute and swap in place — so bind values you want to update later instead of inlining literals.",
    },
  },
};
const validateUpdateSurface = ajv.compile(UPDATE_SURFACE_SCHEMA);

export const updateSurfaceTool: PlatformTool = {
  name: "update_surface",
  description:
    "Update an already-rendered surface in place by patching its data model. Bound nodes ({ path }) recompute and swap without re-rendering the whole surface. Use after render_surface to reflect new data (a changed metric, a refreshed table) — the surface must have used { path } bindings for the values you patch.",
  mutating: false,
  inputSchema: UPDATE_SURFACE_SCHEMA,
  handler: async (args, _ctx) => {
    if (!validateUpdateSurface(args))
      return err("validation_error", firstError(validateUpdateSurface.errors));
    const { surfaceId, dataModel } = args as {
      surfaceId: string;
      dataModel: Record<string, unknown>;
    };
    return ok({ surfaceId, dataModel });
  },
};

// ── ask_user ──────────────────────────────────────────────────────────────────

const ASK_USER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["surfaceId", "spec"],
  properties: {
    surfaceId: { type: "string", minLength: 1, description: "A stable id for the form surface." },
    prompt: { type: "string", description: "The question shown to the user (also recorded)." },
    spec: A2UI_SPEC_SCHEMA,
    schema: {
      type: "object",
      description: "JSON Schema describing the expected answer (stored as the awaited schema).",
    },
  },
};
const validateAskUser = ajv.compile(ASK_USER_SCHEMA);

export const askUserTool: PlatformTool = {
  name: "ask_user",
  description:
    "Pause the run and ask the user for input via an interactive A2UI form, then resume with their answer as THIS tool's result. `spec` is the surface to render — include a Form whose `action.event` posts the answer; usually a Card wrapping a Heading (the question) and the Form. The turn ends with the form on screen; the user's submission resumes the SAME run with their answer. Use for genuine human-in-the-loop decisions, not rhetorical questions. " +
    A2UI_COMPONENTS_REF,
  mutating: false,
  inputSchema: ASK_USER_SCHEMA,
  handler: async (args, _ctx) => {
    if (!validateAskUser(args)) return err("validation_error", firstError(validateAskUser.errors));
    const { surfaceId, prompt, spec, schema } = args as {
      surfaceId: string;
      prompt?: string;
      spec: unknown;
      schema?: Record<string, unknown>;
    };
    return ok({
      surfaceId,
      spec,
      dataModel: {},
      prompt: prompt ?? null,
      schema: schema ?? {},
      __interactive: true,
    });
  },
};

// ── present_choices ───────────────────────────────────────────────────────────

const CHOICE_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label", "value"],
  properties: {
    label: { type: "string", minLength: 1 },
    value: { type: "string", minLength: 1 },
    description: { type: "string" },
  },
};

const PRESENT_CHOICES_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["question", "choices"],
  properties: {
    question: {
      type: "string",
      minLength: 1,
      description: "The question or prompt to display to the user.",
    },
    choices: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: CHOICE_ITEM_SCHEMA,
      description:
        "Selectable options. Each choice has a label (display text) and a value (machine token).",
    },
  },
};
const validatePresentChoices = ajv.compile(PRESENT_CHOICES_SCHEMA);

export const presentChoicesTool: PlatformTool = {
  name: "present_choices",
  description:
    "Present the user with a set of labelled choices and pause for their selection. The UI renders an interactive choice picker from the tool result. Use for branching decisions, disambiguation, or option selection.",
  mutating: false,
  inputSchema: PRESENT_CHOICES_SCHEMA,
  handler: async (args, _ctx) => {
    if (!validatePresentChoices(args))
      return err("validation_error", firstError(validatePresentChoices.errors));
    const { question, choices } = args as {
      question: string;
      choices: Array<{ label: string; value: string; description?: string }>;
    };
    return ok({ question, choices });
  },
};

// ── suggest_agent ─────────────────────────────────────────────────────────────

const SUGGEST_AGENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["agentId"],
  properties: {
    agentId: { type: "string", minLength: 1, description: "Soul name of the agent to suggest." },
    reason: {
      type: "string",
      description: "Why this agent is more appropriate for the user's need.",
    },
  },
};
const validateSuggestAgent = ajv.compile(SUGGEST_AGENT_SCHEMA);

export const suggestAgentTool: PlatformTool = {
  name: "suggest_agent",
  description:
    "Suggest a more appropriate agent for the user's current need without transferring the conversation. The UI surfaces an agent-suggestion card. Use when the user's intent clearly fits a specialist agent but the handoff should be user-confirmed.",
  mutating: false,
  inputSchema: SUGGEST_AGENT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateSuggestAgent(args))
      return err("validation_error", firstError(validateSuggestAgent.errors));
    const { agentId, reason } = args as { agentId: string; reason?: string };
    const agent = ctx.soulLoader?.agents.get(agentId);
    if (!agent) return err("not_found", `Agent "${agentId}" not found in soul.`);
    const agentName = typeof agent.frontmatter.name === "string" ? agent.frontmatter.name : agentId;
    return ok({ agentId, agentName, reason: reason ?? null });
  },
};

// ── validate_artifact ─────────────────────────────────────────────────────────

const VALIDATE_ARTIFACT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["artifact", "schema"],
  properties: {
    artifact: { description: "The data to validate." },
    schema: {
      type: "object",
      description: "JSON Schema to validate the artifact against.",
    },
  },
};
const validateArtifactArgs = ajv.compile(VALIDATE_ARTIFACT_SCHEMA);

export const validateArtifactTool: PlatformTool = {
  name: "validate_artifact",
  description:
    "Validate an arbitrary artifact against a JSON Schema. Returns { valid: true } on success or { valid: false, errors: [...] } with AJV error details. Use before writing structured data to resources.",
  mutating: false,
  inputSchema: VALIDATE_ARTIFACT_SCHEMA,
  handler: async (args, _ctx) => {
    if (!validateArtifactArgs(args))
      return err("validation_error", firstError(validateArtifactArgs.errors));
    const { artifact, schema } = args as { artifact: unknown; schema: Record<string, unknown> };
    let validate: ReturnType<typeof ajv.compile>;
    try {
      validate = ajv.compile(schema);
    } catch (e) {
      return err("internal_error", `Invalid schema: ${e instanceof Error ? e.message : String(e)}`);
    }
    const valid = validate(artifact);
    if (valid) return ok({ valid: true });
    return ok({
      valid: false,
      errors: (validate.errors ?? []).map((e) => ({
        path: e.instancePath || "(root)",
        message: e.message ?? "is invalid",
      })),
    });
  },
};

// ── transfer_to_agent ─────────────────────────────────────────────────────────

const TRANSFER_TO_AGENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["agentId"],
  properties: {
    agentId: { type: "string", minLength: 1, description: "Soul name of the target agent." },
    message: {
      type: "string",
      description: "Optional handoff context to give the receiving agent.",
    },
  },
};
const validateTransfer = ajv.compile(TRANSFER_TO_AGENT_SCHEMA);

export const transferToAgentTool: PlatformTool = {
  name: "transfer_to_agent",
  description:
    "Hand the conversation off to another agent (e.g. the InformationArchitect for any create/edit of a resource type, skill, or agent). The conversation's active agent switches and future turns are handled by the target until it completes. Validates that the target is a known platform or soul agent.",
  mutating: false,
  inputSchema: TRANSFER_TO_AGENT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateTransfer(args))
      return err("validation_error", firstError(validateTransfer.errors));
    const { agentId, message } = args as { agentId: string; message?: string };
    if (ctx.platformAgentNames?.has(agentId)) {
      return ok({ agentId, agentName: agentId, status: "transferred", message: message ?? null });
    }
    const agent = ctx.soulLoader?.agents.get(agentId);
    if (!agent) return err("not_found", `Agent "${agentId}" not found.`);
    const agentName = typeof agent.frontmatter.name === "string" ? agent.frontmatter.name : agentId;
    return ok({ agentId, agentName, status: "transferred", message: message ?? null });
  },
};

// ── delegate_to_agent ─────────────────────────────────────────────────────────

const DELEGATE_TO_AGENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["agentId", "task"],
  properties: {
    agentId: {
      type: "string",
      minLength: 1,
      description: "Soul name of the agent to delegate to.",
    },
    task: { type: "string", minLength: 1, description: "The task description to delegate." },
    context: {
      type: "object",
      description: "Optional structured context to pass to the delegated agent.",
    },
  },
};
const validateDelegate = ajv.compile(DELEGATE_TO_AGENT_SCHEMA);

export const delegateToAgentTool: PlatformTool = {
  name: "delegate_to_agent",
  description:
    "Delegate a sub-task to another agent and record the delegation. The UI surfaces a delegation-event card. Full async execution is deferred (Agents v0.9) — V1 records intent and returns a delegation receipt.",
  mutating: false,
  inputSchema: DELEGATE_TO_AGENT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateDelegate(args))
      return err("validation_error", firstError(validateDelegate.errors));
    const { agentId, task, context } = args as {
      agentId: string;
      task: string;
      context?: Record<string, unknown>;
    };
    const agent = ctx.soulLoader?.agents.get(agentId);
    if (!agent) return err("not_found", `Agent "${agentId}" not found in soul.`);
    return ok({ agentId, task, context: context ?? null, status: "delegated" });
  },
};

// ── trigger_routine ───────────────────────────────────────────────────────────

const TRIGGER_ROUTINE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, description: "Soul name of the routine to trigger." },
    inputs: {
      type: "object",
      description: "Optional key-value inputs matching the routine's x-inputs schema.",
    },
  },
};
const validateTriggerRoutine = ajv.compile(TRIGGER_ROUTINE_SCHEMA);

export const triggerRoutineTool: PlatformTool = {
  name: "trigger_routine",
  description:
    "Trigger a routine by name. V1 validates the routine exists and records intent, returning a stub receipt. Full async execution is available after Routines v0.11.",
  mutating: true,
  inputSchema: TRIGGER_ROUTINE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateTriggerRoutine(args))
      return err("validation_error", firstError(validateTriggerRoutine.errors));
    const { name, inputs } = args as { name: string; inputs?: Record<string, unknown> };
    const routine = ctx.soulLoader?.routines?.get(name);
    if (!routine) return err("not_found", `Routine "${name}" not found in soul.`);
    return ok({ routineId: name, status: "triggered", runId: null, inputs: inputs ?? null });
  },
};

// ── routine_picker ────────────────────────────────────────────────────────────

const ROUTINE_PICKER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
const validateRoutinePicker = ajv.compile(ROUTINE_PICKER_SCHEMA);

export const routinePickerTool: PlatformTool = {
  name: "routine_picker",
  description:
    "List all available routines from the soul so the user can pick one to trigger. Returns name, title, and description for each routine.",
  mutating: false,
  inputSchema: ROUTINE_PICKER_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateRoutinePicker(args))
      return err("validation_error", firstError(validateRoutinePicker.errors));
    const routines = ctx.soulLoader?.routines ?? new Map<string, SoulRoutine>();
    const items = Array.from(routines.values()).map((r) => ({
      name: r.name,
      title: typeof r.config.title === "string" ? r.config.title : r.name,
      description: typeof r.config.description === "string" ? r.config.description : null,
    }));
    return ok({ routines: items });
  },
};

// ── begin_soul_batch ──────────────────────────────────────────────────────────

const BEGIN_SOUL_BATCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
const validateBeginSoulBatch = ajv.compile(BEGIN_SOUL_BATCH_SCHEMA);

export const beginSoulBatchTool: PlatformTool = {
  name: "begin_soul_batch",
  description:
    "Open a soul-batch window. Multiple soul file writes performed after this call will be committed together by end_soul_batch. Call end_soul_batch to close the batch and commit.",
  mutating: false,
  inputSchema: BEGIN_SOUL_BATCH_SCHEMA,
  handler: async (args, _ctx) => {
    if (!validateBeginSoulBatch(args))
      return err("validation_error", firstError(validateBeginSoulBatch.errors));
    return ok({ status: "open" });
  },
};

// ── end_soul_batch ────────────────────────────────────────────────────────────

const END_SOUL_BATCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: {
      type: "string",
      minLength: 1,
      description: "Commit message for the batch of soul writes.",
    },
  },
};
const validateEndSoulBatch = ajv.compile(END_SOUL_BATCH_SCHEMA);

export const endSoulBatchTool: PlatformTool = {
  name: "end_soul_batch",
  description:
    "Close the soul-batch window and commit all pending soul writes as a single commit via withSync (commit + best-effort push).",
  mutating: true,
  inputSchema: END_SOUL_BATCH_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateEndSoulBatch(args))
      return err("validation_error", firstError(validateEndSoulBatch.errors));
    if (!ctx.gitSync) return err("internal_error", "Soul git sync is not available.");
    const { message } = args as { message: string };
    try {
      const result = await ctx.gitSync.withSync(message);
      return ok({ sha: result.sha, filesChanged: result.filesChanged });
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }
  },
};

// ── soul_repo_commit ──────────────────────────────────────────────────────────

const SOUL_REPO_COMMIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: {
      type: "string",
      minLength: 1,
      description: "Commit message attributed to tulipfarm-bot.",
    },
  },
};
const validateSoulRepoCommit = ajv.compile(SOUL_REPO_COMMIT_SCHEMA);

export const soulRepoCommitTool: PlatformTool = {
  name: "soul_repo_commit",
  description:
    "Stage and commit all current soul changes locally (attributed to tulipfarm-bot). Does not push — use soul_repo_push or end_soul_batch to reach the remote.",
  mutating: true,
  inputSchema: SOUL_REPO_COMMIT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateSoulRepoCommit(args))
      return err("validation_error", firstError(validateSoulRepoCommit.errors));
    if (!ctx.gitSync) return err("internal_error", "Soul git sync is not available.");
    const { message } = args as { message: string };
    try {
      const result = await ctx.gitSync.commit(message);
      return ok({ sha: result.sha, filesChanged: result.filesChanged });
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }
  },
};

// ── soul_repo_push ────────────────────────────────────────────────────────────

const SOUL_REPO_PUSH_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};
const validateSoulRepoPush = ajv.compile(SOUL_REPO_PUSH_SCHEMA);

export const soulRepoPushTool: PlatformTool = {
  name: "soul_repo_push",
  description:
    "Push committed soul changes to the configured git remote. Returns { pushed: false } when no remote is configured (local-only mode).",
  mutating: true,
  inputSchema: SOUL_REPO_PUSH_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateSoulRepoPush(args))
      return err("validation_error", firstError(validateSoulRepoPush.errors));
    if (!ctx.gitSync) return err("internal_error", "Soul git sync is not available.");
    try {
      const pushed = await ctx.gitSync.push();
      return ok({ pushed });
    } catch (e) {
      return err("internal_error", e instanceof Error ? e.message : String(e));
    }
  },
};

// ── call_skill (routine-spawned only) ────────────────────────────────────────

const CALL_SKILL_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, description: "Skill name to invoke." },
    args: {
      type: "object",
      description: "Optional arguments to pass to the skill.",
    },
  },
};
const validateCallSkill = ajv.compile(CALL_SKILL_SCHEMA);

export const callSkillTool: PlatformTool = {
  name: "call_skill",
  description:
    "Load and invoke a skill within the current routine execution context. Only callable from a routine-spawned agent turn.",
  mutating: false,
  inputSchema: CALL_SKILL_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCallSkill(args))
      return err("validation_error", firstError(validateCallSkill.errors));
    if (!ctx.routineContext)
      return err("internal_error", "call_skill is only callable from a routine context.");
    const { name, args: skillArgs } = args as { name: string; args?: Record<string, unknown> };
    const skill = ctx.soulLoader?.skills.get(name);
    if (!skill) return err("not_found", `Skill "${name}" not found in soul.`);
    return ok({
      name: skill.name,
      frontmatter: skill.frontmatter,
      body: skill.body,
      args: skillArgs ?? null,
    });
  },
};

// ── complete_state (routine-spawned only) ─────────────────────────────────────

const COMPLETE_STATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    output: { description: "Output data from the completed state." },
  },
};
const validateCompleteState = ajv.compile(COMPLETE_STATE_SCHEMA);

export const completeStateTool: PlatformTool = {
  name: "complete_state",
  description:
    "Signal completion of the current routine state and emit its output. Only callable from a routine-spawned agent turn.",
  mutating: true,
  inputSchema: COMPLETE_STATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCompleteState(args))
      return err("validation_error", firstError(validateCompleteState.errors));
    if (!ctx.routineContext)
      return err("internal_error", "complete_state is only callable from a routine context.");
    const { output } = args as { output?: unknown };
    return ok({
      routineId: ctx.routineContext.routineId,
      runId: ctx.routineContext.runId,
      completed: true,
      output: output ?? null,
    });
  },
};

// ── complete_task ─────────────────────────────────────────────────────────────

const COMPLETE_TASK_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["success", "failed", "cancelled"],
      description: "Outcome of the delegated work.",
    },
    summary: { type: "string", description: "One-line summary of what was built / what happened." },
    result: {
      type: "object",
      description:
        "Optional structured result, e.g. { resources, skills, agents } counts or names.",
    },
    error: { type: "string", description: "Specific reason when status is 'failed'." },
  },
};
const validateCompleteTask = ajv.compile(COMPLETE_TASK_SCHEMA);

export const completeTaskTool: PlatformTool = {
  name: "complete_task",
  description:
    "Signal that the delegated work is finished and hand control back to the front-desk agent. Call this when a creation/onboarding session is done (success), cannot proceed (failed), or was abandoned (cancelled).",
  mutating: false,
  inputSchema: COMPLETE_TASK_SCHEMA,
  handler: async (args) => {
    if (!validateCompleteTask(args))
      return err("validation_error", firstError(validateCompleteTask.errors));
    const { status, summary, result, error } = args as {
      status: "success" | "failed" | "cancelled";
      summary?: string;
      result?: Record<string, unknown>;
      error?: string;
    };
    return ok({
      status,
      summary: summary ?? null,
      result: result ?? null,
      error: error ?? null,
      completed: true,
    });
  },
};

// ── Registry ──────────────────────────────────────────────────────────────────

export const PLATFORM_TOOLS: PlatformTool[] = [
  loadSkillTool,
  loadSkillReferenceTool,
  composeViewTool,
  renderSurfaceTool,
  updateSurfaceTool,
  askUserTool,
  presentChoicesTool,
  suggestAgentTool,
  validateArtifactTool,
  transferToAgentTool,
  delegateToAgentTool,
  triggerRoutineTool,
  routinePickerTool,
  beginSoulBatchTool,
  endSoulBatchTool,
  soulRepoCommitTool,
  soulRepoPushTool,
  callSkillTool,
  completeStateTool,
  completeTaskTool,
];
