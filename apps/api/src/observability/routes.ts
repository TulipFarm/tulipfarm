import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  isLogEventLevel,
  isLogService,
  LOG_EVENT_LEVELS,
  LOG_SERVICES,
  RESOURCE_SERVICES,
} from "@tulipfarm/observability";
import type { SoulWriter } from "@tulipfarm/soul";
import { isSoulWriteError, soulWriteHttpError } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parse as parseYaml } from "yaml";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization } from "../authz/route-gate";
import { commitActorFromRequest } from "../soul/commit-actor";
import {
  type ObservabilityConfig,
  type ObservabilityConfigWrite,
  parseObservabilityConfig,
  validateObservabilityConfigWrite,
  yamlForObservabilityConfig,
} from "./config";
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
  required: [
    "enabled",
    "otlpConfigured",
    "retentionDays",
    "captureContent",
    "pricingOverrides",
    "baseCommit",
    "exporterActive",
    "restartRequired",
  ],
  properties: {
    enabled: { type: "boolean" },
    otlpConfigured: { type: "boolean" },
    endpoint: { type: "string", nullable: true },
    retentionDays: { type: "number" },
    captureContent: { type: "boolean" },
    spendAlertUsd: { type: "number", nullable: true },
    instanceId: { type: "string", nullable: true },
    pricingOverrides: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["in", "out"],
        additionalProperties: false,
        properties: { in: { type: "number" }, out: { type: "number" } },
      },
    },
    baseCommit: { type: "string", nullable: true },
    exporterActive: { type: "boolean" },
    restartRequired: { type: "boolean" },
  },
} as const;

const ConfigWriteSchema = {
  type: "object",
  required: [
    "baseCommit",
    "enabled",
    "retentionDays",
    "captureContent",
    "spendAlertUsd",
    "otlp",
    "pricingOverrides",
  ],
  additionalProperties: false,
  properties: {
    baseCommit: { type: "string", minLength: 1 },
    enabled: { type: "boolean" },
    retentionDays: { type: "integer", minimum: 1, maximum: 3650 },
    captureContent: { type: "boolean" },
    spendAlertUsd: { type: "number", minimum: 0, nullable: true },
    otlp: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          required: ["endpoint", "instanceId"],
          additionalProperties: false,
          properties: {
            endpoint: { type: "string", minLength: 1, maxLength: 2048 },
            instanceId: { type: "string", minLength: 1, maxLength: 256 },
            tokenRef: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
      ],
    },
    pricingOverrides: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["in", "out"],
        additionalProperties: false,
        properties: {
          in: { type: "number", minimum: 0 },
          out: { type: "number", minimum: 0 },
        },
      },
    },
  },
} as const;

const ConfigWriteResponseSchema = {
  type: "object",
  required: ["commitSha", "published", "exporterActive", "restartRequired"],
  properties: {
    commitSha: { type: "string" },
    published: { type: "boolean" },
    publicationError: { type: "string" },
    exporterActive: { type: "boolean" },
    restartRequired: { type: "boolean" },
  },
} as const;

const ConfigValidationErrorSchema = {
  type: "object",
  required: ["error", "path"],
  properties: {
    error: { type: "string" },
    path: { type: "string" },
  },
} as const;

const SummarySchema = {
  type: "object",
  required: ["totals", "series", "byAgent", "byMember", "byModel", "modelSeries", "reliability"],
  properties: {
    totals: {
      type: "object",
      required: ["cost", "tokens", "turns", "unpricedCalls"],
      properties: {
        cost: { type: "number" },
        tokens: { type: "number" },
        turns: { type: "number" },
        unpricedCalls: { type: "number" },
      },
    },
    series: {
      type: "array",
      items: {
        type: "object",
        required: ["bucket", "cost", "tokens"],
        properties: {
          bucket: { type: "string" },
          cost: { type: "number" },
          tokens: { type: "number" },
        },
      },
    },
    byAgent: {
      type: "array",
      items: {
        type: "object",
        required: ["agentId", "cost"],
        properties: { agentId: { type: "string" }, cost: { type: "number" } },
      },
    },
    byMember: {
      type: "array",
      items: {
        type: "object",
        required: ["memberId", "member", "cost"],
        properties: {
          memberId: { type: "string" },
          member: { type: "string" },
          cost: { type: "number" },
        },
      },
    },
    byModel: {
      type: "array",
      items: {
        type: "object",
        required: ["model", "cost", "calls", "unpriced"],
        properties: {
          model: { type: "string" },
          cost: { type: "number" },
          calls: { type: "number" },
          unpriced: { type: "boolean" },
        },
      },
    },
    modelSeries: {
      type: "array",
      items: {
        type: "object",
        required: ["bucket", "model", "cost"],
        properties: {
          bucket: { type: "string" },
          model: { type: "string" },
          cost: { type: "number" },
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
/** Cost, spend, traces and process logs describe the whole deployment, so this is one surface. */
const OBSERVABILITY_READ = {
  action: "observability.read",
  resourceType: "observability",
  fallback: "admin",
} as const;

const OBSERVABILITY_WRITE = {
  action: "observability.write",
  resourceType: "observability",
  fallback: "admin",
} as const;

function comparable(config: ObservabilityConfig): string {
  return JSON.stringify({
    ...config,
    pricingOverrides: Object.fromEntries(
      Object.entries(config.pricingOverrides).sort(([left], [right]) => left.localeCompare(right))
    ),
  });
}

export function registerObservabilityRoutes(
  app: FastifyInstance,
  service: ObservabilityService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  config?: ObservabilityConfig,
  logs?: LogRepo,
  resources?: ResourceRepo,
  soulWriter?: SoulWriter,
  exporterActive: () => boolean = () => false
): void {
  async function savedConfig(): Promise<{
    config: ObservabilityConfig;
    baseCommit: string | null;
  }> {
    if (soulWriter === undefined) {
      return { config: config ?? parseObservabilityConfig(null), baseCommit: null };
    }
    const saved = await soulWriter.readWithBase("ObservabilityConfig");
    return {
      config: parseObservabilityConfig(saved.content === null ? null : parseYaml(saved.content)),
      baseCommit: saved.baseCommit,
    };
  }

  // GET /api/v1/observability/config — Grafana-export status (admin). Never returns the OTLP token.
  app.get(
    "/api/v1/observability/config",
    {
      preHandler: [requireAuth, requireAuthorization(OBSERVABILITY_READ)],
      schema: {
        description: "Observability / Grafana export status (admin only; no secrets).",
        tags: ["observability"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: { 200: ConfigStatusSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (_req, reply) => {
      const saved = await savedConfig();
      return reply.send({
        enabled: saved.config.enabled,
        otlpConfigured: saved.config.otlp != null,
        endpoint: saved.config.otlp?.endpoint ?? null,
        instanceId: saved.config.otlp?.instanceId ?? null,
        retentionDays: saved.config.retentionDays,
        captureContent: saved.config.captureContent,
        spendAlertUsd: saved.config.spendAlertUsd,
        pricingOverrides: saved.config.pricingOverrides,
        baseCommit: saved.baseCommit,
        exporterActive: exporterActive(),
        restartRequired:
          saved.baseCommit !== null &&
          comparable(saved.config) !== comparable(config ?? parseObservabilityConfig(null)),
      });
    }
  );

  if (soulWriter !== undefined) {
    app.put(
      "/api/v1/observability/config",
      {
        preHandler: [requireAuth, requireAuthorization(OBSERVABILITY_WRITE)],
        schema: {
          description:
            "Validate and save the Observability Soul Config. Exporter changes require restart.",
          tags: ["observability", "soul"],
          security: [{ sessionCookie: [] }, { bearerToken: [] }],
          body: ConfigWriteSchema,
          response: {
            200: ConfigWriteResponseSchema,
            202: ConfigWriteResponseSchema,
            400: ErrorSchema,
            401: ErrorSchema,
            403: ErrorSchema,
            404: ErrorSchema,
            409: ErrorSchema,
            422: ConfigValidationErrorSchema,
            500: ErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const body = request.body as ObservabilityConfigWrite & { baseCommit: string };
        const current = await soulWriter.readWithBase("ObservabilityConfig");
        const existing = parseObservabilityConfig(
          current.content === null ? null : parseYaml(current.content)
        );
        const checked = validateObservabilityConfigWrite(body, existing.otlp?.token ?? null);
        if (!checked.ok) {
          return reply.code(422).send({ error: checked.error, path: checked.path });
        }

        try {
          const write = await soulWriter.apply({
            subject: "soul: update observability config",
            source: "api",
            actor: commitActorFromRequest(request),
            businessId: DEPLOYMENT_BUSINESS_ID,
            expectedBaseCommit: body.baseCommit,
            changes: [
              {
                op: "put",
                target: { kind: "ObservabilityConfig" },
                content: yamlForObservabilityConfig(checked.config),
              },
            ],
          });
          return reply.code(write.published ? 200 : 202).send({
            commitSha: write.commitSha,
            published: write.published,
            ...(write.publicationError === undefined
              ? {}
              : { publicationError: write.publicationError }),
            exporterActive: exporterActive(),
            restartRequired:
              write.published &&
              comparable(checked.config) !== comparable(config ?? parseObservabilityConfig(null)),
          });
        } catch (error) {
          if (isSoulWriteError(error)) {
            const mapped = soulWriteHttpError(error);
            return reply.code(mapped.status).send(mapped.body);
          }
          throw error;
        }
      }
    );
  }

  // GET /api/v1/observability/recent — newest chat turns, drill-down entry points (admin).
  app.get(
    "/api/v1/observability/recent",
    {
      preHandler: [requireAuth, requireAuthorization(OBSERVABILITY_READ)],
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
      const q = req.query as { limit?: number };
      return reply.send(await service.recentTurns(q.limit ?? 25));
    }
  );

  // GET /api/v1/observability/trace/:conversationId — a conversation's event timeline (admin).
  app.get(
    "/api/v1/observability/trace/:conversationId",
    {
      preHandler: [requireAuth, requireAuthorization(OBSERVABILITY_READ)],
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
      const { conversationId } = req.params as { conversationId: string };
      return reply.send(await service.trace(conversationId));
    }
  );

  app.get(
    "/api/v1/observability/summary",
    {
      preHandler: [requireAuth, requireAuthorization(OBSERVABILITY_READ)],
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
        preHandler: [requireAuth, requireAuthorization(OBSERVABILITY_READ)],
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
      preHandler: [requireAuth, requireAuthorization(OBSERVABILITY_READ)],
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
