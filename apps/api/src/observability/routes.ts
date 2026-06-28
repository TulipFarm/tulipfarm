import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { ObservabilityConfig } from "./config";
import { isSummaryRange, type ObservabilityService } from "./service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const ConfigStatusSchema = {
  type: "object",
  required: ["enabled", "otlpConfigured", "retentionDays", "captureContent"],
  properties: {
    enabled: { type: "boolean" },
    otlpConfigured: { type: "boolean" },
    endpoint: { type: "string", nullable: true },
    retentionDays: { type: "number" },
    captureContent: { type: "boolean" },
    spendAlertUsd: { type: "number", nullable: true },
  },
} as const;

const SummarySchema = {
  type: "object",
  required: ["totals", "series", "byAgent", "byModel", "reliability"],
  properties: {
    totals: {
      type: "object",
      required: ["costUsd", "tokens", "turns", "unpricedCalls"],
      properties: {
        costUsd: { type: "number" },
        tokens: { type: "number" },
        turns: { type: "number" },
        unpricedCalls: { type: "number" },
      },
    },
    series: {
      type: "array",
      items: {
        type: "object",
        required: ["bucket", "costUsd", "tokens"],
        properties: {
          bucket: { type: "string" },
          costUsd: { type: "number" },
          tokens: { type: "number" },
        },
      },
    },
    byAgent: {
      type: "array",
      items: {
        type: "object",
        required: ["agentId", "costUsd"],
        properties: { agentId: { type: "string" }, costUsd: { type: "number" } },
      },
    },
    byModel: {
      type: "array",
      items: {
        type: "object",
        required: ["model", "costUsd", "calls", "unpriced"],
        properties: {
          model: { type: "string" },
          costUsd: { type: "number" },
          calls: { type: "number" },
          unpriced: { type: "boolean" },
        },
      },
    },
    reliability: {
      type: "object",
      required: [
        "turns",
        "turnErrors",
        "llmCalls",
        "llmErrors",
        "fallbacks",
        "toolCalls",
        "toolErrors",
        "p95DurationMs",
      ],
      properties: {
        turns: { type: "number" },
        turnErrors: { type: "number" },
        llmCalls: { type: "number" },
        llmErrors: { type: "number" },
        fallbacks: { type: "number" },
        toolCalls: { type: "number" },
        toolErrors: { type: "number" },
        p95DurationMs: { type: "number" },
      },
    },
  },
} as const;

/**
 * GET /api/v1/observability/summary?range=24h|7d|30d — pre-aggregated cost/usage dashboard data.
 * Admin-only (mirrors Settings → Secrets / LLM); the observability dashboard is an admin surface.
 */
export function registerObservabilityRoutes(
  app: FastifyInstance,
  service: ObservabilityService,
  requireAuth: PreHandler,
  config?: ObservabilityConfig
): void {
  // GET /api/v1/observability/config — Grafana-export status (admin). Never returns the OTLP token.
  app.get(
    "/api/v1/observability/config",
    {
      preHandler: requireAuth,
      schema: {
        description: "Observability / Grafana export status (admin only; no secrets).",
        tags: ["observability"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: { 200: ConfigStatusSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      if (actor.role !== "admin") {
        return reply.code(403).send({ error: "forbidden" });
      }
      return reply.send({
        enabled: config?.enabled ?? false,
        otlpConfigured: config?.otlp != null,
        endpoint: config?.otlp?.endpoint ?? null,
        retentionDays: config?.retentionDays ?? 90,
        captureContent: config?.captureContent ?? false,
        spendAlertUsd: config?.spendAlertUsd ?? null,
      });
    }
  );

  // GET /api/v1/observability/recent — newest chat turns, drill-down entry points (admin).
  app.get(
    "/api/v1/observability/recent",
    {
      preHandler: requireAuth,
      schema: {
        description: "Recent chat turns for trace drill-down (admin only).",
        tags: ["observability"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: { type: "object", properties: { limit: { type: "number" } } },
        response: {
          200: { type: "array", items: { type: "object", additionalProperties: true } },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      if (actor.role !== "admin") return reply.code(403).send({ error: "forbidden" });
      const q = req.query as { limit?: number };
      return reply.send(await service.recentTurns(q.limit ?? 25));
    }
  );

  // GET /api/v1/observability/trace/:conversationId — a conversation's event timeline (admin).
  app.get(
    "/api/v1/observability/trace/:conversationId",
    {
      preHandler: requireAuth,
      schema: {
        description: "Event timeline (llm_call/tool_call/turn) for one conversation (admin only).",
        tags: ["observability"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["conversationId"],
          properties: { conversationId: { type: "string" } },
        },
        response: {
          200: { type: "array", items: { type: "object", additionalProperties: true } },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      if (actor.role !== "admin") return reply.code(403).send({ error: "forbidden" });
      const { conversationId } = req.params as { conversationId: string };
      return reply.send(await service.trace(conversationId));
    }
  );

  app.get(
    "/api/v1/observability/summary",
    {
      preHandler: requireAuth,
      schema: {
        description: "AI observability cost/usage summary over a trailing window (admin only).",
        tags: ["observability"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: { range: { type: "string", enum: ["24h", "7d", "30d"] } },
        },
        response: { 200: SummarySchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      if (actor.role !== "admin") {
        return reply.code(403).send({ error: "forbidden" });
      }
      const q = req.query as Record<string, unknown>;
      const range = isSummaryRange(q.range) ? q.range : "7d";
      return reply.send(await service.summary(range));
    }
  );
}
