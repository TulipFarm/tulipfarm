import { parsePaginationQuery } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization } from "../authz/route-gate";
import type { ActivityRow } from "./repo";
import type { ActivityService } from "./service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Activity is a workspace-wide operational feed (Runs, Record changes, sync, Soul Doctor). */
const OPERATIONS_READ = {
  action: "operations.read",
  resourceType: "operations",
  fallback: "admin",
} as const;

const ActivityItemSchema = {
  type: "object",
  required: ["id", "category", "action", "actorType", "summary", "status", "createdAt"],
  properties: {
    id: { type: "string" },
    category: { type: "string" },
    action: { type: "string" },
    actorType: { type: "string" },
    actorId: { type: "string", nullable: true },
    targetType: { type: "string", nullable: true },
    targetId: { type: "string", nullable: true },
    summary: { type: "string" },
    status: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
    createdAt: { type: "string" },
  },
} as const;

function toApiActivity(r: ActivityRow): Record<string, unknown> {
  return {
    id: r._id,
    category: r.category,
    action: r.action,
    actorType: r.actorType,
    actorId: r.actorId,
    targetType: r.targetType,
    targetId: r.targetId,
    summary: r.summary,
    status: r.status,
    metadata: r.metadata,
    createdAt: r.createdAt.toISOString(),
  };
}

/** GET /api/v1/activities — newest-first workspace activity feed, cursor-paginated + category filter. */
export function registerActivityRoutes(
  app: FastifyInstance,
  service: ActivityService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  app.get(
    "/api/v1/activities",
    {
      preHandler: [requireAuth, requireAuthorization(OPERATIONS_READ)],
      schema: {
        description:
          "List workspace activity (newest-first, cursor paginated; filter by category). " +
          "Requires operational authorization.",
        tags: ["activity"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: {
            cursor: { type: "string" },
            limit: { type: "number" },
            category: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["items", "nextCursor"],
            properties: {
              items: { type: "array", items: ActivityItemSchema },
              nextCursor: { type: "string", nullable: true },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      const { limit, after } = parsePaginationQuery(q);
      const category =
        typeof q.category === "string" && q.category.length > 0 ? q.category : undefined;
      const page = await service.list({ limit, after, category });
      return reply.send({
        items: page.items.map(toApiActivity),
        nextCursor: page.nextCursor,
      });
    }
  );
}
