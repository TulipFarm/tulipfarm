import { parsePaginationQuery } from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createApiToken, type TokenRepo, toPublicToken } from "../api-tokens";
import { ErrorSchema, PublicTokenSchema } from "../schemas";
import type { UserDoc, UserRepo } from "../users";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerTokenRoutes(
  app: FastifyInstance,
  repo: UserRepo,
  tokenRepo: TokenRepo,
  requireAuth: PreHandler,
  rateLimitHook?: PreHandler
): void {
  app.post(
    "/api/v1/auth/tokens",
    {
      preHandler: rateLimitHook ? [rateLimitHook, requireAuth] : requireAuth,
      schema: {
        description: "Create a new API token for the authenticated user.",
        tags: ["auth"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            userId: { type: "string", description: "Admin only — create token for another user." },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              token: { type: "string", description: "Raw token value. Shown once." },
              ...PublicTokenSchema.properties,
            },
            required: ["token", ...PublicTokenSchema.required],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      const body = (req.body ?? {}) as { name?: unknown; userId?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return reply.code(400).send({ error: "name is required" });
      }

      let targetUserId = actor._id;
      if (body.userId !== undefined) {
        if (actor.role !== "admin") {
          return reply.code(403).send({ error: "forbidden" });
        }
        if (typeof body.userId !== "string") {
          return reply.code(400).send({ error: "userId must be a string" });
        }
        const targetUser = await repo.findById(body.userId);
        if (!targetUser) {
          return reply.code(404).send({ error: "user not found" });
        }
        targetUserId = body.userId;
      }

      const { doc, rawToken } = await createApiToken(tokenRepo, targetUserId, name);
      return reply.code(201).send({ token: rawToken, ...toPublicToken(doc) });
    }
  );

  app.get(
    "/api/v1/auth/tokens",
    {
      preHandler: rateLimitHook ? [rateLimitHook, requireAuth] : requireAuth,
      schema: {
        description: "List API tokens. Admins see all tokens; members see their own.",
        tags: ["auth"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              tokens: { type: "array", items: PublicTokenSchema },
              nextCursor: { type: ["string", "null"] },
            },
            required: ["tokens", "nextCursor"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      const { limit, after } = parsePaginationQuery(req.query as Record<string, unknown>);

      const rawCursor = (req.query as Record<string, unknown>).cursor;
      if (typeof rawCursor === "string" && rawCursor !== "" && after === undefined) {
        return reply.code(400).send({ error: "invalid cursor" });
      }

      const result =
        actor.role === "admin"
          ? await tokenRepo.findAllPaginated(limit, after)
          : await tokenRepo.findByUserIdPaginated(actor._id, limit, after);

      return reply.send({ tokens: result.items.map(toPublicToken), nextCursor: result.nextCursor });
    }
  );

  app.delete(
    "/api/v1/auth/tokens/:id",
    {
      preHandler: rateLimitHook ? [rateLimitHook, requireAuth] : requireAuth,
      schema: {
        description:
          "Delete an API token. Admins can delete any token; members can only delete their own.",
        tags: ["auth"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = req.user as UserDoc;
      const { id } = req.params as { id: string };
      const token = await tokenRepo.findById(id);
      if (!token) {
        return reply.code(404).send({ error: "token not found" });
      }
      if (actor.role !== "admin" && token.userId !== actor._id) {
        return reply.code(403).send({ error: "forbidden" });
      }
      await tokenRepo.deleteById(id);
      return reply.code(204).send();
    }
  );
}
