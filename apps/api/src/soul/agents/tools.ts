import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { ajv, TulipFarmValidationError, validateAgentFrontmatter } from "@tulipfarm/schema";
import {
  AGENT_EXISTING_DECISIONS,
  type AgentExistingDecision,
  agentWriteRequest,
  type GitSyncService,
  resolveAgentName,
  type SoulLoader,
  SoulWriteError,
  type SoulWriter,
} from "@tulipfarm/soul";
import {
  type ApiToolDefinition,
  defineApiTool,
  err,
  ok,
  type RequestContext,
  type ToolCallResult,
} from "@tulipfarm/tool-host";
import { firstError } from "../../platform/tool-args";
import { SYSTEM_SOUL_COMMIT_ACTOR } from "../../runtime/soul-writer";
import { readSoulConfig } from "../../setup/soul-config";
import { soulCommitError } from "../../tools/soul-faults";

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SOUL_AGENT_TARGET = "soul.agent";

export interface AgentToolContext {
  gitSync: GitSyncService;
  soulLoader: SoulLoader;
  readonly soulWriter: SoulWriter;
  requestContext?: RequestContext;
  /** Which Agent is executing this Turn. Absent outside an Agent Turn. */
  agentId?: string;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Map a Soul write-gateway rejection onto this tool family's error vocabulary.
 *
 * `PRECONDITION_FAILED` is the one code whose meaning is site-specific — an "already exists" on
 * create, a "not found" on update/delete — so each caller supplies that mapping. The rest are
 * fixed: a rejected changeset (bad target or invalid frontmatter) is a `validation_error`, a moved
 * base is transient (`unavailable`), and a failed commit is classified by `soulCommitError` so git
 * contention is reported as `unavailable` rather than as a request the model should repair. The
 * gateway's message carries only structured evidence, never file content, so it is safe to surface.
 */
function mapSoulWriteError(
  e: SoulWriteError,
  onPrecondition: () => ToolCallResult
): ToolCallResult {
  switch (e.code) {
    case "PRECONDITION_FAILED":
      return onPrecondition();
    case "VALIDATION_FAILED":
    case "INVALID_TARGET":
      return err("validation_error", e.message);
    case "CONFLICT":
      return err("unavailable", e.message);
    default:
      return soulCommitError(e, e.message);
  }
}

function stringArg(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function agentTargets(args: unknown) {
  const id = stringArg(args, "name");
  // Soul targets use the same two-level name as their static resource (`soul.<thing>`).
  return id === undefined ? [] : [{ type: SOUL_AGENT_TARGET, id }];
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

/** The one `AGENT.md` write both agent Tools take: the failing result, or `null` once committed. */
async function putAgent(
  ctx: AgentToolContext,
  verb: "add" | "update",
  name: string,
  frontmatter: Record<string, unknown>,
  body: string,
  onPrecondition: () => ToolCallResult
): Promise<ToolCallResult | null> {
  const actor = ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR;
  try {
    await ctx.soulWriter.apply(agentWriteRequest(verb, name, frontmatter, body, actor));
    // Same-Turn tools (e.g. routine_forge) read ctx.soulLoader.agents synchronously right after
    // this call; without a reload here they'd validate against the pre-write snapshot and reject
    // an agentRef this Turn just created.
    await ctx.soulLoader.reload();
    return null;
  } catch (e) {
    if (e instanceof SoulWriteError) return mapSoulWriteError(e, onPrecondition);
    return err("internal_error", reason(e));
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
        "Optional frontmatter. Allowed keys: label, domain, description, model, autonomy (full|supervised|approval-required|manual), modelPolicy, capabilityRestrictions, placeholder (string[]), suggestions (string[]). Use capabilityRestrictions to set server-enforced Tool, Skill, Record, and Resource type limits such as read-only access or a named set of Skills this Agent may load.",
    },
    onExisting: {
      type: "string",
      enum: [...AGENT_EXISTING_DECISIONS],
      description:
        "The user's decision when an Agent already holds this name or label. Omit on the first attempt; the Tool then reports the collision. Ask the user once, then re-call with 'keep' to leave the existing Agent untouched or 'update' to replace its body and frontmatter. Never ask the same question twice.",
    },
  },
} as const;

const validateCreate = ajv.compile(CREATE_SCHEMA);

const agentCreate = defineApiTool<AgentToolContext>({
  name: "agent_create",
  description:
    "Create a new agent in the soul repo by writing its AGENT.md. The change is committed atomically to the soul repo. No approval gate.",
  tier: "system",
  mutating: true,
  inputSchema: CREATE_SCHEMA,
  authorization: {
    action: "soul.agent.create",
    resources: ["soul.agent"],
    targets: agentTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateCreate(args)) return err("validation_error", firstError(validateCreate.errors));
    const {
      name,
      body,
      frontmatter = {},
      onExisting,
    } = args as {
      name: string;
      body: string;
      frontmatter?: Record<string, unknown>;
      onExisting?: AgentExistingDecision;
    };

    if (!NAME_RE.test(name)) return err("validation_error", "invalid agent name");

    const fmError = frontmatterError(frontmatter);
    if (fmError) return fmError;

    const plan = resolveAgentName(ctx.soulLoader.agents, name, frontmatter, onExisting);
    if (plan.outcome === "refuse") return err("validation_error", plan.message);
    if (plan.outcome === "keep") return ok({ created: false, changed: false, ...plan.agent });

    const created = plan.outcome === "create";
    const target = created ? name : plan.agent.name;
    const failure = await putAgent(ctx, created ? "add" : "update", target, frontmatter, body, () =>
      err("validation_error", "agent already exists")
    );
    return failure ?? ok({ name: target, created, changed: true, frontmatter, body });
  },
});

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
        "New frontmatter (replaces existing; omit to keep current). Same allowed keys as agent_create, including capabilityRestrictions for server-enforced Tool, Skill, Record, and Resource type limits. Unknown keys are rejected. At least one of body or frontmatter must be provided.",
    },
  },
} as const;

const validateUpdate = ajv.compile(UPDATE_SCHEMA);

const agentUpdate = defineApiTool<AgentToolContext>({
  name: "agent_update",
  description:
    "Update an existing agent's body and/or frontmatter. At least one must be provided. The change is committed atomically to the soul repo.",
  tier: "system",
  mutating: true,
  inputSchema: UPDATE_SCHEMA,
  authorization: {
    action: "soul.agent.update",
    resources: ["soul.agent"],
    targets: agentTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateUpdate(args)) return err("validation_error", firstError(validateUpdate.errors));
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

    const failure = await putAgent(ctx, "update", name, newFm, newBody, () =>
      err("not_found", `agent not found: ${name}`)
    );
    return failure ?? ok({ name, frontmatter: newFm, body: newBody });
  },
});

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

const agentGet = defineApiTool<AgentToolContext>({
  name: "agent_get",
  description: "Get an agent's frontmatter and markdown body from the soul.",
  tier: "system",
  mutating: false,
  inputSchema: GET_SCHEMA,
  authorization: {
    action: "soul.agent.read",
    resources: ["soul.agent"],
    targets: agentTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateGet(args)) return err("validation_error", firstError(validateGet.errors));
    const { name } = args as { name: string };
    const agent = ctx.soulLoader.agents.get(name);
    if (!agent) return err("not_found", `agent not found: ${name}`);
    return ok({ name: agent.name, frontmatter: agent.frontmatter, body: agent.body });
  },
});

// ── agent_list ────────────────────────────────────────────────────────────────

const LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const validateList = ajv.compile(LIST_SCHEMA);

const agentList = defineApiTool<AgentToolContext>({
  name: "agent_list",
  description: "List all agents defined in the soul repo.",
  tier: "system",
  mutating: false,
  inputSchema: LIST_SCHEMA,
  authorization: {
    action: "soul.agent.list",
    resources: ["soul.agent"],
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateList(args)) return err("validation_error", firstError(validateList.errors));
    const agents = Array.from(ctx.soulLoader.agents.values()).map(({ name, frontmatter }) => ({
      name,
      frontmatter,
    }));
    return ok({ agents });
  },
});

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

const agentDelete = defineApiTool<AgentToolContext>({
  name: "agent_delete",
  description:
    "Delete an agent from the soul repo. Removes its definition and companions, committed atomically to the soul repo.",
  tier: "system",
  mutating: true,
  inputSchema: DELETE_SCHEMA,
  authorization: {
    action: "soul.agent.delete",
    resources: ["soul.agent"],
    targets: agentTargets,
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateDelete(args)) return err("validation_error", firstError(validateDelete.errors));
    const { name } = args as { name: string };

    if (!ctx.soulLoader.agents.has(name)) return err("not_found", `agent not found: ${name}`);

    try {
      await ctx.soulWriter.apply({
        subject: `soul: remove agent ${name}`,
        source: "agent",
        actor: ctx.requestContext?.actor ?? SYSTEM_SOUL_COMMIT_ACTOR,
        businessId: DEPLOYMENT_BUSINESS_ID,
        changes: [{ op: "deleteArtifact", kind: "Agent", slug: name }],
      });
    } catch (e) {
      if (e instanceof SoulWriteError) {
        return mapSoulWriteError(e, () => err("not_found", `agent not found: ${name}`));
      }
      return err("internal_error", reason(e));
    }

    return ok({ name, deleted: true });
  },
});

// ── get_current_agent ─────────────────────────────────────────────────────────

const CURRENT_AGENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const validateCurrentAgent = ajv.compile(CURRENT_AGENT_SCHEMA);

/**
 * Which Agent is running.
 *
 * Nothing in the prompt names it, and the other Soul Tools cannot substitute: `agent_get` needs a
 * name it does not have, and `agent_list` returns every Agent without marking which one is asking.
 */
const getCurrentAgent = defineApiTool<AgentToolContext>({
  name: "get_current_agent",
  description:
    "Find out which Agent you are: your name, your configured domain, and your description. " +
    "Call this when you need to identify yourself, decide whether a request is yours to handle, " +
    "or look up your own definition.",
  tier: "system",
  mutating: false,
  inputSchema: CURRENT_AGENT_SCHEMA,
  authorization: {
    action: "soul.agent.read",
    resources: ["soul.agent"],
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateCurrentAgent(args))
      return err("validation_error", firstError(validateCurrentAgent.errors));
    const name = ctx.agentId;
    if (name === undefined) {
      return ok({
        known: false,
        note: "This execution is not bound to a named Agent.",
      });
    }
    const agent = ctx.soulLoader.agents.get(name);
    return ok({
      known: true,
      name,
      // A platform Agent has no soul-repo file, so its frontmatter is legitimately absent; that is
      // reported rather than hidden, or the model reads "no domain" as "domain unrestricted".
      ...(agent === undefined
        ? { note: "You are a built-in Agent with no soul-repo definition." }
        : { frontmatter: agent.frontmatter }),
    });
  },
});

// ── get_business_profile ──────────────────────────────────────────────────────

const BUSINESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const validateBusiness = ajv.compile(BUSINESS_SCHEMA);

/**
 * The business the instance runs. Read from `soul.yaml`, the same source `GET /api/v1/business`
 * serves, so an Agent and the settings screen cannot disagree about who the business is.
 */
const getBusinessProfile = defineApiTool<AgentToolContext>({
  name: "get_business_profile",
  description:
    "Read the business you work for: its name, what it does, and its website. Nothing else " +
    "tells you, so call this before naming the business, writing anything in its voice, or " +
    "assuming what it sells.",
  tier: "system",
  mutating: false,
  inputSchema: BUSINESS_SCHEMA,
  authorization: {
    action: "soul.business_profile.read",
    resources: ["soul"],
    dataClasses: ["soul_definition"],
  },
  requiresApproval: false,
  handler: async (args, ctx) => {
    if (!validateBusiness(args))
      return err("validation_error", firstError(validateBusiness.errors));
    try {
      const config = await readSoulConfig(ctx.gitSync.path);
      const text = (value: unknown): string | undefined =>
        typeof value === "string" && value.trim().length > 0 ? value : undefined;
      const name = text(config.businessName);
      const description = text(config.businessDescription);
      const website = text(config.businessWebsite);
      if (name === undefined && description === undefined && website === undefined) {
        return ok({
          configured: false,
          note: "The business profile has not been filled in yet. Offer to set it up.",
        });
      }
      return ok({
        configured: true,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(website === undefined ? {} : { website }),
      });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

export const AGENT_TOOLS: ApiToolDefinition<AgentToolContext>[] = [
  agentCreate,
  agentUpdate,
  agentGet,
  agentList,
  agentDelete,
  getCurrentAgent,
  getBusinessProfile,
];
