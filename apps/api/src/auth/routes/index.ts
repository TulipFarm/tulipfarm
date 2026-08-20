import type { FastifyInstance } from "fastify";
import type { AuthorizationCheck, RequireAuthorization } from "../../authz/route-gate";
import { makeAuthorizationCheck, makeRequireAuthorization } from "../../authz/route-gate";
import type { IdentityRouteDeps } from "../../identity/routes";
import { registerIdentityRoutes } from "../../identity/routes";
import type { RateLimiter } from "../../rate-limit";
import { makeRateLimitHook } from "../../rate-limit";
import type { TokenRepo } from "../api-tokens";
import type { UserInviteRepo } from "../invites";
import { makeRequireAuth } from "../middleware";
import type { SessionStore } from "../session-store";
import type { PasswordWriteRepo, ProfileWriteRepo, UserAdminRepo, UserRepo } from "../users";
import { registerSessionRoutes } from "./session";
import { registerTokenRoutes } from "./tokens";
import { registerAdminUserRoutes } from "./users";

export { SESSION_COOKIE } from "../middleware";

interface AuthRouteOptions {
  ttlSeconds?: number;
  rateLimiter?: RateLimiter;
  identity?: Omit<IdentityRouteDeps, "sessionStore" | "userRepo" | "ttlSeconds">;
  userAdminRepo?: UserAdminRepo;
  passwordWriteRepo?: PasswordWriteRepo;
  profileWriteRepo?: ProfileWriteRepo;
  inviteRepo?: UserInviteRepo;
  /** Defaults to the no-authorizer gate, which still refuses non-admins on admin declarations. */
  requireAuthorization?: RequireAuthorization;
  /** The value form of the same decision, for owner-scoped surfaces. */
  authorizationCheck?: AuthorizationCheck;
  /** Kicks the Curator sweep outside its five-minute cron after an invite is issued, so
   * "Invite your team" clears within seconds instead of waiting for the next scheduled tick. */
  triggerCuratorSweep?: () => Promise<void>;
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

  registerSessionRoutes(app, {
    store,
    repo,
    requireAuth,
    ttlSeconds,
    rateLimitHook: preHandler,
    loginRateLimitHook: loginPreHandler,
    passwordWriteRepo: options.passwordWriteRepo,
    profileWriteRepo: options.profileWriteRepo,
    inviteRepo: options.inviteRepo,
    ...(options.authorizationCheck && { authorizationCheck: options.authorizationCheck }),
  });
  registerTokenRoutes(
    app,
    repo,
    tokenRepo,
    requireAuth,
    options.authorizationCheck ?? makeAuthorizationCheck(),
    preHandler
  );
  if (options.userAdminRepo && options.inviteRepo) {
    registerAdminUserRoutes(
      app,
      repo,
      options.userAdminRepo,
      options.inviteRepo,
      requireAuth,
      options.requireAuthorization ?? makeRequireAuthorization(),
      preHandler,
      options.triggerCuratorSweep
    );
  }
  registerIdentityRoutes(
    app,
    {
      ...options.identity,
      sessionStore: store,
      userRepo: repo,
      ttlSeconds,
      ...(preHandler && { rateLimitHook: preHandler }),
      ...(loginPreHandler && { credentialRateLimitHook: loginPreHandler }),
    },
    requireAuth,
    options.requireAuthorization ?? makeRequireAuthorization()
  );
}
