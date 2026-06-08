import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitSyncService, SoulAgent, SoulRoutine, SoulSkill } from "@tulipfarm/soul";
import { ajv } from "@tulipfarm/validation";
import { type ToolCallResult, err, ok } from "./tool-result";

export interface PlatformToolContext {
  soulLoader?: {
    skills: Map<string, SoulSkill>;
    agents: Map<string, SoulAgent>;
    routines?: Map<string, SoulRoutine>;
  };
  soulPath?: string;
  gitSync?: GitSyncService;
  routineContext?: { routineId: string; runId: string };
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
    "Load a skill's frontmatter and body from the soul by name. Returns the skill definition so the agent can apply its instructions. Graceful not_found when the skill is absent.",
  mutating: false,
  inputSchema: LOAD_SKILL_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateLoadSkill(args))
      return err("validation_error", firstError(validateLoadSkill.errors));
    const { name } = args as { name: string };
    const skill = ctx.soulLoader?.skills.get(name);
    if (!skill) return err("not_found", `Skill "${name}" not found in soul.`);
    return ok({ name: skill.name, frontmatter: skill.frontmatter, body: skill.body });
  },
};

// ── load_skill_reference ──────────────────────────────────────────────────────

const LOAD_SKILL_REFERENCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["skill", "reference"],
  properties: {
    skill: { type: "string", minLength: 1, description: "Skill name." },
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
    const refPath = join(ctx.soulPath, "skills", skill, "references", reference);
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
    "Hand the conversation off to another agent. The UI surfaces a handoff card and future turns are handled by the target agent. Validates that the target agent exists in the soul.",
  mutating: false,
  inputSchema: TRANSFER_TO_AGENT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateTransfer(args))
      return err("validation_error", firstError(validateTransfer.errors));
    const { agentId, message } = args as { agentId: string; message?: string };
    const agent = ctx.soulLoader?.agents.get(agentId);
    if (!agent) return err("not_found", `Agent "${agentId}" not found in soul.`);
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

// ── Registry ──────────────────────────────────────────────────────────────────

export const PLATFORM_TOOLS: PlatformTool[] = [
  loadSkillTool,
  loadSkillReferenceTool,
  composeViewTool,
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
];
