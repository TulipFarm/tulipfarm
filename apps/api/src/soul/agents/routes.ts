import type { SoulAgent, SoulLoader } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import { getAgent, listAgents } from "./registry";

/*
 * Read-only HTTP surface for agents (AGENTS / UI-V1-003). The registry is the built-in `GeneralAssistant`
 * platform agent plus the soul agents (AGENT.md files loaded into the SoulLoader at startup). The list
 * view carries frontmatter only and puts GeneralAssistant first; the detail view adds the markdown `body`
 * (the agent's system prompt). Creation/editing of soul agents happens via the agent_* tools / forges,
 * not here.
 */

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
  return {
    ...toSummary(agent),
    placeholder: asStringArray(f.placeholder),
    suggestions: asStringArray(f.suggestions),
    body: agent.body,
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
