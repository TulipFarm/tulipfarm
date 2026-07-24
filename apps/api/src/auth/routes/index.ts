import type { FastifyInstance } from "fastify";
import type { IdentityRouteDeps } from "../../identity/routes";
import { registerIdentityRoutes } from "../../identity/routes";
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
  identity?: Omit<IdentityRouteDeps, "sessionStore" | "userRepo" | "ttlSeconds">;
}

const AUTH_LIMIT = 100;
const AUTH_WINDOW_MS = 60_000;

// Credential-guessing budget for the one unauthenticated route that verifies a secret. Far
// tighter than the general auth budget: online password guessing must stay uneconomic.
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 900_000;

export function registerAuthRoutes(
  app: FastifyInstance,
  store: SessionStore,
  repo: UserRepo,
  tokenRepo: TokenRepo,
  options: AuthRouteOptions = {}
): void {
  const ttlSeconds =
    options.ttlSeconds ?? Number.parseInt(process.env.SESSION_TTL_SECONDS ?? "604800", 10);
  const requireAuth = makeRequireAuth({
    store,
    userRepo: repo,
    tokenRepo,
    ...(options.identity?.apiClientRepo && { apiClientRepo: options.identity.apiClientRepo }),
  });

  const limiter = options.rateLimiter;
  const preHandler = limiter
    ? makeRateLimitHook(limiter, (req) => `rl:auth:${req.ip}`, AUTH_LIMIT, AUTH_WINDOW_MS)
    : undefined;
  const loginPreHandler = limiter
    ? makeRateLimitHook(limiter, (req) => `rl:login:${req.ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS)
    : undefined;

  registerSessionRoutes(app, store, repo, requireAuth, ttlSeconds, preHandler, loginPreHandler);
  registerTokenRoutes(app, repo, tokenRepo, requireAuth, preHandler);
  registerIdentityRoutes(
    app,
    { ...options.identity, sessionStore: store, userRepo: repo, ttlSeconds },
    requireAuth
  );
}
