import type { RoutineCatalog } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TeamAssetService } from "../team-assets/service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Shared with `detail-routes.ts`, which serves the same Routines surface. */
export const security: { [securityLabel: string]: readonly string[] }[] = [
  { sessionCookie: [] },
  { bearerToken: [] },
];
const errorSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
} as const;

const triggerSchema = {
  type: "object",
  required: ["slug", "type", "summary"],
  properties: {
    slug: { type: "string" },
    type: { type: "string" },
    summary: { type: "string" },
  },
} as const;

const summarySchema = {
  type: "object",
  required: [
    "owner",
    "stateCount",
    "stateTypes",
    "effects",
    "toolAbilities",
    "maxRiskClass",
    "requiresApproval",
    "concurrencyPolicy",
    "compensationPolicy",
  ],
  properties: {
    owner: { type: ["string", "null"] },
    ownership: { type: "object", additionalProperties: true },
    stateCount: { type: "integer", minimum: 0 },
    stateTypes: { type: "array", items: { type: "string" } },
    effects: { type: "array", items: { type: "string" } },
    toolAbilities: { type: "array", items: { type: "string" } },
    maxRiskClass: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
    requiresApproval: { type: "boolean" },
    concurrencyPolicy: { type: ["string", "null"] },
    compensationPolicy: { type: ["string", "null"] },
  },
} as const;

export const routineSchema = {
  type: "object",
  required: ["id", "slug", "displayName", "authoredVersion", "triggers", "summary"],
  properties: {
    id: { type: "string" },
    slug: { type: "string" },
    displayName: { type: ["string", "null"] },
    authoredVersion: { type: "integer", minimum: 1 },
    triggers: { type: "array", items: triggerSchema },
    summary: summarySchema,
  },
} as const;

export function registerRoutineCatalogRoutes(
  app: FastifyInstance,
  catalog: RoutineCatalog,
  requireAuth: PreHandler,
  teamAssets?: TeamAssetService
): void {
  app.get(
    "/api/v1/routines",
    {
      preHandler: [requireAuth],
      schema: {
        description: "List published Routines from the verified active Soul bundle.",
        tags: ["routines"],
        security,
        response: {
          200: {
            type: "object",
            required: ["items"],
            properties: { items: { type: "array", items: routineSchema } },
          },
          401: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const items = await catalog.list();
        if (!teamAssets || !request.principal) return { items };
        const visible = await Promise.all(
          items.map(async (item) => ({
            item,
            access: await teamAssets.access(
              "routine",
              item.id,
              request.principal as NonNullable<typeof request.principal>,
              item.summary.ownership ?? undefined
            ),
          }))
        );
        return {
          items: visible
            .filter(({ access }) => access.levels.includes("view"))
            .map(({ item }) => item),
        };
      } catch (error) {
        app.log.error({ err: error }, "Routine catalogue could not read the active bundle");
        return reply.status(503).send({ error: "Active Routine catalogue is unavailable." });
      }
    }
  );
}
