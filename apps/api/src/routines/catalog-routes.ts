import type { RoutineCatalog } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const security: { [securityLabel: string]: readonly string[] }[] = [
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

const routineSchema = {
  type: "object",
  required: ["id", "slug", "displayName", "authoredVersion", "triggers"],
  properties: {
    id: { type: "string" },
    slug: { type: "string" },
    displayName: { type: ["string", "null"] },
    authoredVersion: { type: "integer", minimum: 1 },
    triggers: { type: "array", items: triggerSchema },
  },
} as const;

export function registerRoutineCatalogRoutes(
  app: FastifyInstance,
  catalog: RoutineCatalog,
  requireAuth: PreHandler
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
    async (_request, reply) => {
      try {
        return { items: await catalog.list() };
      } catch (error) {
        app.log.error({ err: error }, "Routine catalogue could not read the active bundle");
        return reply.status(503).send({ error: "Active Routine catalogue is unavailable." });
      }
    }
  );
}
