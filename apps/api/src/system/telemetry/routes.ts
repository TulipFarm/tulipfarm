import type { ProductTelemetryLevel, ProductTelemetryReporter } from "@tulipfarm/observability";
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import type { RequireAuthorization } from "../../authz/route-gate";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
const levelSchema = { type: "integer", minimum: 0, maximum: 2 };
const nullableDate = { type: "string", nullable: true };
const eventSchema = {
  type: "object",
  nullable: true,
  required: [
    "schema_version",
    "event_id",
    "installation_id",
    "event_type",
    "occurred_at",
    "telemetry_level",
    "data",
  ],
  additionalProperties: false,
  properties: {
    schema_version: { type: "integer", const: 1 },
    event_id: { type: "string", format: "uuid" },
    installation_id: { type: "string", format: "uuid" },
    event_type: { type: "string", enum: ["instance_bootstrapped", "instance_snapshot"] },
    occurred_at: { type: "string" },
    telemetry_level: levelSchema,
    data: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...Object.fromEntries(
          [
            "version",
            "os",
            "architecture",
            "deployment_method",
            "first_boot_at",
            "business_name",
            "business_website",
            "instance_url",
            "soul_repository_url",
          ].map((key) => [key, { type: "string" }])
        ),
        ...Object.fromEntries(
          [
            "users",
            "resource_types",
            "integrations",
            "skills",
            "bundled_skills",
            "agents",
            "routines",
          ].map((key) => [key, { type: "integer", minimum: 0 }])
        ),
        ...Object.fromEntries(
          ["resource_type_names", "integration_providers", "skill_names", "agent_names"].map(
            (key) => [
              key,
              { type: "array", maxItems: 200, items: { type: "string", maxLength: 128 } },
            ]
          )
        ),
        inventory_truncated: { type: "boolean" },
      },
    },
  },
};
const statusSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "level",
    "effectiveLevel",
    "maxLevel",
    "enabled",
    "configured",
    "installationId",
    "bootstrapSentAt",
    "lastSnapshotAt",
    "preview",
  ],
  properties: {
    level: levelSchema,
    effectiveLevel: levelSchema,
    maxLevel: levelSchema,
    enabled: { type: "boolean" },
    configured: { type: "boolean" },
    installationId: { type: "string" },
    bootstrapSentAt: nullableDate,
    lastSnapshotAt: nullableDate,
    preview: {
      type: "object",
      required: ["bootstrap", "snapshot"],
      properties: { bootstrap: eventSchema, snapshot: eventSchema },
    },
  },
};

export function registerProductTelemetryRoutes(
  app: FastifyInstance,
  reporter: ProductTelemetryReporter,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const schema: FastifySchema = {
    tags: ["system"],
    security: [{ sessionCookie: [] }, { bearerToken: [] }],
    response: { 200: statusSchema, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema },
  };
  app.get<{ Querystring: { level?: ProductTelemetryLevel } }>(
    "/api/v1/system/telemetry",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "telemetry.read",
          resourceType: "telemetry",
          fallback: "admin",
        }),
      ],
      schema: {
        ...schema,
        description:
          "Read deployment telemetry preferences and the exact allowlisted report preview.",
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { level: levelSchema },
        },
      },
    },
    async (req) => reporter.status(req.query.level)
  );
  app.put<{ Body: { level: ProductTelemetryLevel } }>(
    "/api/v1/system/telemetry",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "telemetry.write",
          resourceType: "telemetry",
          fallback: "admin",
        }),
      ],
      schema: {
        ...schema,
        description:
          "Save deployment-local telemetry sharing and discard pending reports above the new level.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["level"],
          properties: { level: levelSchema },
        },
      },
    },
    async (req) => reporter.save(req.body.level)
  );
}

export function registerInternalProductTelemetryRoutes(
  app: FastifyInstance,
  reporter: ProductTelemetryReporter,
  requireAuth: PreHandler
): void {
  const requireService: PreHandler = async (req, reply) => {
    if (req.principal?.kind !== "service")
      await reply.code(403).send({ error: "Product telemetry dispatch is service-only" });
  };
  app.post(
    "/api/v1/internal/system/telemetry/dispatch",
    {
      preHandler: [requireAuth, requireService],
      schema: {
        description: "Deliver one due product report after rechecking deployment preferences.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        response: {
          200: { type: "object", required: ["sent"], properties: { sent: { type: "boolean" } } },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async () => {
      try {
        await reporter.initialize();
        return await reporter.dispatch();
      } catch {
        app.log.warn("Product telemetry dispatch deferred");
        return { sent: false };
      }
    }
  );
}
