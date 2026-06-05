import type { FastifyInstance } from "fastify";
import type { TokenRepo } from "../api-tokens";
import { makeRequireAuth } from "../middleware";
import type { SessionStore } from "../session-store";
import type { UserRepo } from "../users";
import { registerSessionRoutes } from "./session";
import { registerTokenRoutes } from "./tokens";

export { SESSION_COOKIE } from "../middleware";

interface AuthRouteOptions {
  ttlSeconds?: number;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  store: SessionStore,
  repo: UserRepo,
  tokenRepo: TokenRepo,
  options: AuthRouteOptions = {}
): void {
  const ttlSeconds =
    options.ttlSeconds ?? Number.parseInt(process.env.SESSION_TTL_SECONDS ?? "604800", 10);
  const requireAuth = makeRequireAuth(store, repo, tokenRepo);

  registerSessionRoutes(app, store, repo, requireAuth, ttlSeconds);
  registerTokenRoutes(app, repo, tokenRepo, requireAuth);
}
