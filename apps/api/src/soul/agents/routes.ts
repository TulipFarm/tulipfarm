import type { SoulAgent, SoulLoader } from "@tulipfarm/soul";
import { getAgent, listAgents } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../../auth/schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const AUTONOMY_VALUES = ["full", "supervised", "approval-required", "manual"] as const;
type Autonomy = (typeof AUTONOMY_VALUES)[number];

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

function toSummary(agent: SoulAgent) {
  const f = agent.frontmatter;
  return {
    name: agent.name,
    label: asString(f.label),
    domain: asString(f.domain),
    description: asString(f.description),
    model: asString(f.model),
    autonomy: asAutonomy(f.autonomy),
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

const SummaryProps = {
  name: { type: "string" },
  label: { type: "string" },
  domain: { type: "string" },
  description: { type: "string" },
  model: { type: "string" },
  autonomy: { type: "string", enum: AUTONOMY_VALUES },
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
