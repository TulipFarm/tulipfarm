import type { FastifyInstance } from "fastify";
import type { RateLimiter } from "../../rate-limit";
import { makeRateLimitHook } from "../../rate-limit";
import type { TokenRepo } from "../api-tokens";
import { makeRequireAuth } from "../middleware";
import type { SessionStore } from "../session-store";
import type { UserRepo } from "../users";
import { registerSessionRoutes } from "./session";
import { registerTokenRoutes } from "./tokens";

export { SESSION_COOKIE } from "../middleware";

interface AuthRouteOptions {
  ttlSeconds?: number;
  rateLimiter?: RateLimiter;
}

const AUTH_LIMIT = 100;
const AUTH_WINDOW_MS = 60_000;

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

  const preHandler = options.rateLimiter
    ? makeRateLimitHook(
        options.rateLimiter,
        (req) => `rl:auth:${req.ip}`,
        AUTH_LIMIT,
        AUTH_WINDOW_MS
      )
    : undefined;

  registerSessionRoutes(app, store, repo, requireAuth, ttlSeconds, preHandler);
  registerTokenRoutes(app, repo, tokenRepo, requireAuth, preHandler);
}
