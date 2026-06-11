import type { FastifyReply, FastifyRequest } from "fastify";
import { hashToken, type TokenRepo } from "./api-tokens";
import type { SessionStore } from "./session-store";
import type { UserDoc, UserRepo } from "./users";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserDoc;
  }
}

export const SESSION_COOKIE = "tf_sid";

export function makeRequireAuth(store: SessionStore, repo: UserRepo, tokenRepo: TokenRepo) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) {
      const userId = await store.get(sid);
      if (userId) {
        const user = await repo.findById(userId);
        if (user) {
          req.user = user;
          return;
        }
      }
    }

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const rawToken = authHeader.slice(7);
      const tokenDoc = await tokenRepo.findByHash(hashToken(rawToken));
      if (tokenDoc) {
        const user = await repo.findById(tokenDoc.userId);
        if (user) {
          req.user = user;
          return;
        }
      }
    }

    reply.code(401).send({ error: "unauthorized" });
  };
}
