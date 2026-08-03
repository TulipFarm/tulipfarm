import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ajv, TulipFarmValidationError, validateAgentFrontmatter } from "@tulipfarm/schema";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import { stringify } from "yaml";
import { err, ok, type ToolCallResult } from "../../tools/types.js";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface AgentToolContext {
  gitSync: GitSyncService;
  soulLoader: SoulLoader;
}

export interface AgentTool {
  name: string;
  description: string;
  mutating: boolean;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: AgentToolContext) => Promise<ToolCallResult>;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function firstError(validate: ReturnType<typeof ajv.compile>): string {
  const e = validate.errors?.[0];
  if (!e) return "invalid arguments";
  return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim();
}

function serializeAgent(frontmatter: Record<string, unknown>, body: string): string {
  if (Object.keys(frontmatter).length === 0) return body;
  return `---\n${stringify(frontmatter)}---\n${body}`;
}

// Write-time meta-schema gate (VAL-V1-010). Returns a validation_error
// result on invalid frontmatter, or null when it passes.
function frontmatterError(frontmatter: Record<string, unknown>): ToolCallResult | null {
  try {
    validateAgentFrontmatter(frontmatter);
    return null;
  } catch (e) {
    if (e instanceof TulipFarmValidationError) {
      return err("validation_error", `${e.path} ${e.message}`.trim());
    }
    throw e;
  }
}

// ── agent_create ──────────────────────────────────────────────────────────────

const CREATE_SCHEMA = {
  type: "object",
  required: ["name", "body"],
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "Agent name (kebab-case, e.g. 'task-planner'). Becomes the soul directory name.",
    },
    body: { type: "string", description: "Markdown system-prompt body." },
    frontmatter: {
      type: "object",
      description:
        "Optional frontmatter. Allowed keys: label, domain, description, model, autonomy (full|supervised|approval-required|manual), placeholder (string[]), suggestions (string[]). Unknown keys are rejected.",
    },
  },
} as const;

const validateCreate = ajv.compile(CREATE_SCHEMA);

const agentCreate: AgentTool = {
  name: "agent_create",
  description:
    "Create a new agent in the soul repo by writing its AGENT.md. Commits and pushes via withSync. No approval gate.",
  mutating: true,
  inputSchema: CREATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCreate(args)) return err("validation_error", firstError(validateCreate));
    const {
      name,
      body,
      frontmatter = {},
    } = args as {
      name: string;
      body: string;
      frontmatter?: Record<string, unknown>;
    };

    if (!NAME_RE.test(name)) return err("validation_error", "invalid agent name");

    const fmError = frontmatterError(frontmatter);
    if (fmError) return fmError;

    const agentDir = join(ctx.gitSync.path, "agents", name);
    if (existsSync(agentDir)) return err("validation_error", "agent already exists");

    try {
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "AGENT.md"), serializeAgent(frontmatter, body), "utf8");
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(`soul: add agent ${name}`);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, frontmatter, body });
  },
};

// ── agent_update ──────────────────────────────────────────────────────────────

// NOTE: no top-level `anyOf` — OpenAI-family models reject tool parameter schemas with a top-level
// anyOf/oneOf/allOf/enum/not. The "at least one of body/frontmatter" rule is enforced in the handler.
const UPDATE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Agent name to update." },
    body: { type: "string", description: "New markdown body (replaces existing)." },
    frontmatter: {
      type: "object",
      description:
        "New frontmatter (replaces existing; omit to keep current). Same allowed keys as agent_create; unknown keys are rejected. At least one of body or frontmatter must be provided.",
    },
  },
} as const;

const validateUpdate = ajv.compile(UPDATE_SCHEMA);

const agentUpdate: AgentTool = {
  name: "agent_update",
  description:
    "Update an existing agent's body and/or frontmatter. At least one must be provided. Commits and pushes via withSync.",
  mutating: true,
  inputSchema: UPDATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateUpdate(args)) return err("validation_error", firstError(validateUpdate));
    const { name, body, frontmatter } = args as {
      name: string;
      body?: string;
      frontmatter?: Record<string, unknown>;
    };
    if (body === undefined && frontmatter === undefined)
      return err("validation_error", "at least one of body or frontmatter must be provided");

    const existing = ctx.soulLoader.agents.get(name);
    if (!existing) return err("not_found", `agent not found: ${name}`);

    if (frontmatter !== undefined) {
      const fmError = frontmatterError(frontmatter);
      if (fmError) return fmError;
    }

    const newBody = body ?? existing.body;
    const newFm = frontmatter ?? existing.frontmatter;

    const agentFile = join(ctx.gitSync.path, "agents", name, "AGENT.md");
    try {
      await writeFile(agentFile, serializeAgent(newFm, newBody), "utf8");
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(`soul: update agent ${name}`);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, frontmatter: newFm, body: newBody });
  },
};

// ── agent_get ─────────────────────────────────────────────────────────────────

const GET_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Agent name." },
  },
} as const;

const validateGet = ajv.compile(GET_SCHEMA);

const agentGet: AgentTool = {
  name: "agent_get",
  description: "Get an agent's frontmatter and markdown body from the soul.",
  mutating: false,
  inputSchema: GET_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGet(args)) return err("validation_error", firstError(validateGet));
    const { name } = args as { name: string };
    const agent = ctx.soulLoader.agents.get(name);
    if (!agent) return err("not_found", `agent not found: ${name}`);
    return ok({ name: agent.name, frontmatter: agent.frontmatter, body: agent.body });
  },
};

// ── agent_list ────────────────────────────────────────────────────────────────

const LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const validateList = ajv.compile(LIST_SCHEMA);

const agentList: AgentTool = {
  name: "agent_list",
  description: "List all agents defined in the soul repo.",
  mutating: false,
  inputSchema: LIST_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateList(args)) return err("validation_error", firstError(validateList));
    const agents = Array.from(ctx.soulLoader.agents.values()).map(({ name, frontmatter }) => ({
      name,
      frontmatter,
    }));
    return ok({ agents });
  },
};

// ── agent_delete ──────────────────────────────────────────────────────────────

const DELETE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Agent name to delete." },
  },
} as const;

const validateDelete = ajv.compile(DELETE_SCHEMA);

const agentDelete: AgentTool = {
  name: "agent_delete",
  description:
    "Delete an agent from the soul repo. Removes its directory, commits and pushes via withSync.",
  mutating: true,
  inputSchema: DELETE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateDelete(args)) return err("validation_error", firstError(validateDelete));
    const { name } = args as { name: string };

    if (!ctx.soulLoader.agents.has(name)) return err("not_found", `agent not found: ${name}`);

    const agentDir = join(ctx.gitSync.path, "agents", name);
    try {
      await rm(agentDir, { recursive: true, force: true });
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(`soul: remove agent ${name}`);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, deleted: true });
  },
};

export const AGENT_TOOLS: AgentTool[] = [
  agentCreate,
  agentUpdate,
  agentGet,
  agentList,
  agentDelete,
];
