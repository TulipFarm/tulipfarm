import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SoulAgent, SoulSkill } from "@tulipfarm/soul";
import { ajv } from "@tulipfarm/validation";
import { type ToolCallResult, err, ok } from "./tool-result";

export interface PlatformToolContext {
  soulLoader?: {
    skills: Map<string, SoulSkill>;
    agents: Map<string, SoulAgent>;
  };
  soulPath?: string;
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
];
