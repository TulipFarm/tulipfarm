import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type TokenRepo, createApiToken, toPublicToken } from "../api-tokens";
import type { UserDoc, UserRepo } from "../users";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerTokenRoutes(
  app: FastifyInstance,
  repo: UserRepo,
  tokenRepo: TokenRepo,
  requireAuth: PreHandler
): void {
  app.post("/api/v1/auth/tokens", { preHandler: requireAuth }, async (req, reply) => {
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
  });

  app.get("/api/v1/auth/tokens", { preHandler: requireAuth }, async (req, reply) => {
    const actor = req.user as UserDoc;
    const tokens =
      actor.role === "admin" ? await tokenRepo.findAll() : await tokenRepo.findByUserId(actor._id);
    return reply.send({ tokens: tokens.map(toPublicToken) });
  });

  app.delete("/api/v1/auth/tokens/:id", { preHandler: requireAuth }, async (req, reply) => {
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
  });
}
