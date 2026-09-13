import type { OimConnectionRefreshSweepResult } from "@tulipfarm/integrations";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface InternalOimConnectionRouteDeps {
  refreshDue(): Promise<OimConnectionRefreshSweepResult>;
}

export function registerInternalOimConnectionRoutes(
  app: FastifyInstance,
  deps: InternalOimConnectionRouteDeps,
  requireAuth: PreHandler
): void {
  const requireService: PreHandler = async (request, reply) => {
    if (request.principal?.kind !== "service") {
      await reply.code(403).send({ error: "OIM Connection refresh is service-only" });
    }
  };

  app.post(
    "/api/v1/internal/oim/connections/refresh-due",
    {
      preHandler: [requireAuth, requireService],
      schema: {
        description: "Refresh OIM Connections whose provider credentials are nearing expiry.",
        tags: ["internal"],
        security: [{ bearerToken: [] }],
        response: {
          200: {
            type: "object",
            required: ["examined", "refreshed", "failed"],
            properties: {
              examined: { type: "integer", minimum: 0 },
              refreshed: { type: "integer", minimum: 0 },
              failed: { type: "integer", minimum: 0 },
            },
          },
          401: {
            type: "object",
            required: ["error"],
            properties: { error: { type: "string" } },
          },
          403: {
            type: "object",
            required: ["error"],
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async () => deps.refreshDue()
  );
}
