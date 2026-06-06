import type { GitSyncService } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerSoulRoutes(
  app: FastifyInstance,
  gitSync: GitSyncService,
  requireAuth: PreHandler
): void {
  app.post(
    "/api/v1/soul/commit",
    {
      preHandler: requireAuth,
      schema: {
        description: "Stage all soul changes and commit as tulipfarm-bot.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["message"],
          properties: { message: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              sha: { type: "string" },
              filesChanged: { type: "number" },
            },
            required: ["sha", "filesChanged"],
          },
          204: { type: "null" },
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { message } = req.body as { message: string };
      const result = await gitSync.commit(message);
      if (result.sha === "") {
        return reply.code(204).send();
      }
      return reply.send(result);
    }
  );

  app.post(
    "/api/v1/soul/push",
    {
      preHandler: requireAuth,
      schema: {
        description: "Push committed soul changes to origin/main.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: { pushed: { type: "boolean" } },
            required: ["pushed"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const pushed = await gitSync.push();
      return reply.send({ pushed });
    }
  );
}
