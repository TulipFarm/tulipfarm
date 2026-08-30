import type { SoulAgent, SoulLoader } from "@tulipfarm/soul";
import { getAgent, listAgents } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../../auth/schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const AUTONOMY_VALUES = ["full", "supervised", "approval-required", "manual"] as const;
type Autonomy = (typeof AUTONOMY_VALUES)[number];

const RECORD_ACTIONS = ["list", "search", "read", "create", "update", "delete"] as const;
const RESOURCE_TYPE_ACTIONS = ["list", "read", "create", "update"] as const;

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string");
  return arr.length > 0 ? arr : undefined;
}

function asNumberRecord(v: unknown): Record<string, number> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v).filter((entry): entry is [string, number] => typeof entry[1] === "number")
  );
}

function asAutonomy(v: unknown): Autonomy | undefined {
  return typeof v === "string" && (AUTONOMY_VALUES as readonly string[]).includes(v)
    ? (v as Autonomy)
    : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function omitEmpty<T extends Record<string, unknown>>(value: T): T | undefined {
  const kept = Object.entries(value).filter(([, v]) => v !== undefined);
  return kept.length > 0 ? (Object.fromEntries(kept) as T) : undefined;
}

function asAllowDeny(v: unknown, values?: readonly string[]) {
  const source = asRecord(v);
  if (!source) return undefined;
  const pick = (key: "allow" | "deny") => {
    const list = asStringArray(source[key]);
    if (!list) return undefined;
    const kept = values ? list.filter((item) => values.includes(item)) : list;
    return kept.length > 0 ? kept : undefined;
  };
  return omitEmpty({ allow: pick("allow"), deny: pick("deny") });
}

/**
 * The Soul's capability restrictions are what the runtime actually enforces, so the UI has to be
 * able to show them; every field is re-checked here because frontmatter reaches the loader
 * unvalidated.
 */
function toCapabilityRestrictions(f: Record<string, unknown>) {
  const source = asRecord(f.capabilityRestrictions);
  if (!source) return undefined;

  const toolSource = asRecord(source.tools);
  const tools = toolSource
    ? omitEmpty({
        ...(asAllowDeny(toolSource) ?? {}),
        allowMutating:
          typeof toolSource.allowMutating === "boolean" ? toolSource.allowMutating : undefined,
      })
    : undefined;

  const recordSource = asRecord(source.records);
  const records = recordSource
    ? omitEmpty({
        actions: asAllowDeny(recordSource.actions, RECORD_ACTIONS),
        resourceTypes: asStringArray(recordSource.resourceTypes),
      })
    : undefined;

  const resourceTypeSource = asRecord(source.resourceTypes);
  const resourceTypes = resourceTypeSource
    ? omitEmpty({
        actions: asAllowDeny(resourceTypeSource.actions, RESOURCE_TYPE_ACTIONS),
        names: asStringArray(resourceTypeSource.names),
      })
    : undefined;

  return omitEmpty({
    tools,
    skills: asAllowDeny(source.skills),
    records,
    resourceTypes,
  });
}

function toSummary(agent: SoulAgent) {
  const f = agent.frontmatter;
  return {
    name: agent.name,
    label: asString(f.label),
    domain: asString(f.domain),
    description: asString(f.description),
    model: asString(f.model),
    autonomy: asAutonomy(f.autonomy),
    capabilityRestrictions: toCapabilityRestrictions(f),
  };
}

function toDetail(agent: SoulAgent) {
  const f = agent.frontmatter;
  const version = asString(f.version);
  const candidateVersion = asString(f.candidateVersion);
  const evaluationStatus = asString(f.evaluationStatus);
  const publicationStatus = asString(f.publicationStatus);
  const governance =
    version && candidateVersion
      ? {
          version,
          roles: asStringArray(f.roles) ?? [],
          skills: asStringArray(f.skills) ?? [],
          tools: asStringArray(f.tools) ?? [],
          modelProfile: asString(f.modelProfile) ?? asString(f.model) ?? "default",
          limits: asNumberRecord(f.limits),
          evaluation: {
            status:
              evaluationStatus &&
              ["pending", "passed", "failed", "stale"].includes(evaluationStatus)
                ? evaluationStatus
                : "pending",
            suite: asString(f.evaluationSuite) ?? "not configured",
            passedAt: asString(f.evaluationPassedAt),
          },
          publication: {
            candidateVersion,
            status:
              publicationStatus &&
              ["draft", "validated", "awaiting_approval", "published", "blocked"].includes(
                publicationStatus
              )
                ? publicationStatus
                : "draft",
            canPublish: f.canPublish === true,
            reason: asString(f.publicationReason),
          },
        }
      : undefined;
  return {
    ...toSummary(agent),
    placeholder: asStringArray(f.placeholder),
    suggestions: asStringArray(f.suggestions),
    body: agent.body,
    governance,
  };
}

const AllowDenyProps = {
  allow: { type: "array", items: { type: "string" } },
  deny: { type: "array", items: { type: "string" } },
} as const;

const CapabilityRestrictionsSchema = {
  type: "object",
  properties: {
    tools: {
      type: "object",
      properties: { ...AllowDenyProps, allowMutating: { type: "boolean" } },
    },
    skills: { type: "object", properties: AllowDenyProps },
    records: {
      type: "object",
      properties: {
        actions: { type: "object", properties: AllowDenyProps },
        resourceTypes: { type: "array", items: { type: "string" } },
      },
    },
    resourceTypes: {
      type: "object",
      properties: {
        actions: { type: "object", properties: AllowDenyProps },
        names: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

const SummaryProps = {
  name: { type: "string" },
  label: { type: "string" },
  domain: { type: "string" },
  description: { type: "string" },
  model: { type: "string" },
  autonomy: { type: "string", enum: AUTONOMY_VALUES },
  capabilityRestrictions: CapabilityRestrictionsSchema,
} as const;

export function registerAgentRoutes(
  app: FastifyInstance,
  soulLoader: SoulLoader,
  requireAuth: PreHandler
): void {
  app.get(
    "/api/v1/agents",
    {
      preHandler: requireAuth,
      schema: {
        description: "List agents defined in the soul repo (frontmatter only).",
        tags: ["agents"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["agents"],
            properties: {
              agents: {
                type: "array",
                items: { type: "object", required: ["name"], properties: SummaryProps },
              },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    async () => {
      const agents = listAgents(soulLoader).map(toSummary);
      return { agents };
    }
  );

  app.get(
    "/api/v1/agents/:name",
    {
      preHandler: requireAuth,
      schema: {
        description: "Get a single agent including its AGENT.md markdown body.",
        tags: ["agents"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["name", "body"],
            properties: {
              ...SummaryProps,
              placeholder: { type: "array", items: { type: "string" } },
              suggestions: { type: "array", items: { type: "string" } },
              body: { type: "string" },
              governance: { type: "object", additionalProperties: true },
            },
          },
          401: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      const agent = getAgent(soulLoader, name);
      if (!agent) return reply.code(404).send({ error: `agent not found: ${name}` });
      return toDetail(agent);
    }
  );
}
