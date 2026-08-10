import {
  isLogEventLevel,
  isLogService,
  LOG_EVENT_LEVELS,
  LOG_SERVICES,
  RESOURCE_SERVICES,
} from "@tulipfarm/observability";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { UserDoc } from "../auth/users";
import type { ObservabilityConfig } from "./config";
import type { LogRepo } from "./log-repo";
import {
  isResourceWindow,
  RESOURCE_WINDOW_KEYS,
  type ResourceRepo,
  type ResourceWindow,
} from "./resource-repo";
import { isSummaryRange, type ObservabilityService } from "./service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Page size ceiling for the log reader — a runaway `limit` must not scan the whole table. */
const LOG_LIMIT_MAX = 200;
const LOG_LIMIT_DEFAULT = 50;

const LogsSchema = {
  type: "object",
  required: ["items", "nextCursor"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "ts", "level", "service", "message"],
        properties: {
          id: { type: "string" },
          ts: { type: "string" },
          level: { type: "string", enum: [...LOG_EVENT_LEVELS] },
          service: { type: "string", enum: [...LOG_SERVICES] },
          message: { type: "string" },
          stack: { type: "string", nullable: true },
          requestId: { type: "string", nullable: true },
          runId: { type: "string", nullable: true },
          conversationId: { type: "string", nullable: true },
          attributes: { type: "object", additionalProperties: true },
        },
      },
    },
    nextCursor: { type: "string", nullable: true },
  },
} as const;

const ResourcesSchema = {
  type: "object",
  required: ["window", "bucketSeconds", "buckets", "series"],
  properties: {
    window: { type: "string", enum: [...RESOURCE_WINDOW_KEYS] },
    bucketSeconds: { type: "number" },
    buckets: { type: "array", items: { type: "string" } },
    series: {
      type: "array",
      items: {
        type: "object",
        required: ["service", "cpuPct", "rssBytes"],
        properties: {
          service: { type: "string", enum: [...RESOURCE_SERVICES] },
          // Nullable entries are load-bearing: a null is a bucket the service produced no sample
          // for, and the chart must draw that as a gap rather than interpolate across an outage.
          cpuPct: { type: "array", items: { type: "number", nullable: true } },
          rssBytes: { type: "array", items: { type: "number", nullable: true } },
        },
      },
    },
  },
} as const;

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
 * Admin-only (mirrors Business → Secrets / Models); the observability dashboard is an admin surface.
 */
export function registerObservabilityRoutes(
  app: FastifyInstance,
  service: ObservabilityService,
  requireAuth: PreHandler,
  config?: ObservabilityConfig,
  logs?: LogRepo,
  resources?: ResourceRepo
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

  // GET /api/v1/observability/resources — per-service CPU/RSS over a time window (admin).
  if (resources) {
    app.get(
      "/api/v1/observability/resources",
      {
        preHandler: requireAuth,
        schema: {
          description:
            "Bucketed CPU and memory usage per service over a time window (admin only). " +
            "CPU is percent of a single core, so a process saturating two cores reads 200.",
          tags: ["observability"],
          security: [{ sessionCookie: [] }, { bearerToken: [] }],
          querystring: {
            type: "object",
            properties: {
              window: { type: "string", enum: [...RESOURCE_WINDOW_KEYS] },
            },
          },
          response: { 200: ResourcesSchema, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema },
        },
      },
      async (req, reply) => {
        const actor = req.user as UserDoc;
        if (actor.role !== "admin") return reply.code(403).send({ error: "forbidden" });
        const raw = (req.query as { window?: string }).window;
        // The querystring enum already rejects an unknown value with 400; this covers the parameter
        // being absent, which is the ordinary first load.
        const window: ResourceWindow = isResourceWindow(raw) ? raw : "1h";
        return reply.send(await resources.usage(window));
      }
    );
  }

  // GET /api/v1/observability/logs — durable error/fatal records across all services (admin).
  // Only registered when a repo is wired: a route that always returns [] would read as "nothing
  // is failing" when the truth is "nothing is being captured".
  if (!logs) return;
  app.get(
    "/api/v1/observability/logs",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "Durable error/fatal log records across api, worker, and integration-worker (admin only).",
        tags: ["observability"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: {
            level: { type: "string", enum: [...LOG_EVENT_LEVELS] },
            service: { type: "string", enum: [...LOG_SERVICES] },
            since: { type: "string", description: "ISO timestamp; only records at or after it." },
            q: { type: "string", description: "Case-insensitive substring match on the message." },
            limit: { type: "number", minimum: 1, maximum: LOG_LIMIT_MAX },
            cursor: { type: "string", description: "Opaque cursor from a previous page." },
          },
        },
        response: { 200: LogsSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      if (actor.role !== "admin") return reply.code(403).send({ error: "forbidden" });
      const q = req.query as {
        level?: string;
        service?: string;
        since?: string;
        q?: string;
        limit?: number;
        cursor?: string;
      };
      // An unparseable `since` is ignored rather than 400'd: the filter is a convenience, and a
      // stale bookmark should still show the operator their logs.
      const since = q.since ? new Date(q.since) : undefined;
      return reply.send(
        await logs.query({
          level: isLogEventLevel(q.level) ? q.level : undefined,
          service: isLogService(q.service) ? q.service : undefined,
          since: since && !Number.isNaN(since.getTime()) ? since : undefined,
          q: q.q?.trim() || undefined,
          limit: Math.min(Math.max(Math.floor(q.limit ?? LOG_LIMIT_DEFAULT), 1), LOG_LIMIT_MAX),
          cursor: q.cursor,
        })
      );
    }
  );
}
