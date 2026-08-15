import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sessionCookieOptions } from "../auth/cookie-security";
import { setCsrfCookie } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { ErrorSchema, PublicApiClientSchema, PublicUserSchema } from "../auth/schemas";
import {
  type AuthMethod,
  DEFAULT_SESSION_TTL_SECONDS,
  rotateSession,
  type SessionStore,
} from "../auth/session-store";
import { toPublicUser, type UserRepo } from "../auth/users";
import type { RequireAuthorization, RouteAuthorization } from "../authz/route-gate";
import { MemoryRateLimiter, makeRateLimitHook } from "../rate-limit";
import {
  type ApiClientRepo,
  createApiClient,
  formatApiClientCredential,
  rotateApiClientSecret,
  toPublicApiClient,
} from "./api-clients";
import {
  ChannelBindDeniedError,
  type ChannelBindDeps,
  previewChannelBind,
  redeemChannelBindToken,
} from "./channel-link";
import {
  ExternalIdentityDeniedError,
  type ExternalIdentityRepo,
  LinkRedemptionDeniedError,
  mintLinkToken,
  redeemLinkToken,
  resolveExternalIdentity,
} from "./external-links";
import {
  claimsProveMfa,
  completeOidcAuthorization,
  type OidcAuthRequestRepo,
  OidcDeniedError,
  type OidcProvider,
  startOidcAuthorization,
} from "./oidc";
import { assertUserAuthenticatable } from "./principal";
import type { MfaVerifierRegistry } from "./step-up";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface OidcConfig {
  readonly provider: OidcProvider;
  readonly requestRepo: OidcAuthRequestRepo;
  /** Absolute callback URL registered with the provider. */
  readonly redirectUri: string;
}

export interface IdentityRouteDeps {
  sessionStore: SessionStore;
  userRepo: UserRepo;
  apiClientRepo?: ApiClientRepo;
  externalIdentityRepo?: ExternalIdentityRepo;
  /** Enables the channel bind flow. Absent → an unlinked sender is simply denied. */
  channelBind?: ChannelBindDeps;
  oidc?: OidcConfig;
  mfa?: MfaVerifierRegistry;
  ttlSeconds?: number;
  /** Shared per-IP budget applied to every identity route. */
  rateLimitHook?: PreHandler;
  /** Tighter budget for routes that verify a secret (OIDC callback, step-up proof). */
  credentialRateLimitHook?: PreHandler;
}

/** Route preHandlers in order, dropping the hooks that were not configured. */
function chain(...hooks: Array<PreHandler | undefined>): PreHandler[] {
  return hooks.filter((hook): hook is PreHandler => hook !== undefined);
}

// Per-IP budgets for the identity surface. The deployment normally injects a shared
// (Postgres-backed) limiter; when it does not, these in-process budgets still apply, so no
// identity route is ever unlimited.
const IDENTITY_LIMIT = 100;
const IDENTITY_WINDOW_MS = 60_000;
const CREDENTIAL_LIMIT = 10;
const CREDENTIAL_WINDOW_MS = 900_000;

const AUTH_METHODS: AuthMethod[] = ["password", "oidc", "totp", "passkey"];

function isAuthMethod(value: unknown): value is AuthMethod {
  return typeof value === "string" && (AUTH_METHODS as string[]).includes(value);
}

/** Identity routes default-deny unconfigured providers, missing factors, and non-admins. */
export function registerIdentityRoutes(
  app: FastifyInstance,
  deps: IdentityRouteDeps,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const ttlSeconds = deps.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const fallbackLimiter = new MemoryRateLimiter();
  const limited: IdentityRouteDeps = {
    ...deps,
    rateLimitHook:
      deps.rateLimitHook ??
      makeRateLimitHook(
        fallbackLimiter,
        (req) => `rl:identity:${req.ip}`,
        IDENTITY_LIMIT,
        IDENTITY_WINDOW_MS
      ),
    credentialRateLimitHook:
      deps.credentialRateLimitHook ??
      makeRateLimitHook(
        fallbackLimiter,
        (req) => `rl:identity-credential:${req.ip}`,
        CREDENTIAL_LIMIT,
        CREDENTIAL_WINDOW_MS
      ),
  };

  registerOidcRoutes(app, limited, ttlSeconds);
  registerStepUpRoute(app, limited, requireAuth, ttlSeconds);
  registerApiClientRoutes(app, limited, requireAuth, requireAuthorization);
  registerExternalLinkRoutes(app, limited, requireAuth);
  registerChannelBindRoutes(app, limited, requireAuth);
}

function registerOidcRoutes(
  app: FastifyInstance,
  deps: IdentityRouteDeps,
  ttlSeconds: number
): void {
  app.get(
    "/api/v1/auth/oidc/start",
    {
      preHandler: chain(deps.rateLimitHook),
      schema: {
        description: "Begin OIDC sign-in. Redirects to the configured identity provider.",
        tags: ["auth"],
        querystring: {
          type: "object",
          properties: { redirectTo: { type: "string" } },
        },
        response: { 302: { type: "null" }, 503: ErrorSchema },
      },
    },
    async (req, reply) => {
      if (!deps.oidc) {
        return reply.code(503).send({ error: "oidc is not configured" });
      }
      const query = (req.query ?? {}) as { redirectTo?: unknown };
      const { url } = await startOidcAuthorization(deps.oidc.requestRepo, deps.oidc.provider, {
        redirectUri: deps.oidc.redirectUri,
        // Only same-origin relative paths survive: an absolute URL here would be an open redirect.
        redirectTo:
          typeof query.redirectTo === "string" && query.redirectTo.startsWith("/")
            ? query.redirectTo
            : null,
      });
      return reply.redirect(url, 302);
    }
  );

  app.get(
    "/api/v1/auth/oidc/callback",
    {
      preHandler: chain(deps.credentialRateLimitHook),
      schema: {
        description: "Complete OIDC sign-in and issue a session for the mapped user.",
        tags: ["auth"],
        querystring: {
          type: "object",
          required: ["code", "state"],
          properties: { code: { type: "string" }, state: { type: "string" } },
        },
        response: {
          200: { type: "object", properties: { user: PublicUserSchema }, required: ["user"] },
          401: ErrorSchema,
          403: ErrorSchema,
          503: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!deps.oidc || !deps.externalIdentityRepo) {
        return reply.code(503).send({ error: "oidc is not configured" });
      }
      const query = (req.query ?? {}) as { code?: unknown; state?: unknown };
      if (typeof query.code !== "string" || typeof query.state !== "string") {
        return reply.code(401).send({ error: "invalid authorization response" });
      }

      let claims: Awaited<ReturnType<typeof completeOidcAuthorization>>;
      try {
        claims = await completeOidcAuthorization(deps.oidc.requestRepo, deps.oidc.provider, {
          state: query.state,
          code: query.code,
          redirectUri: deps.oidc.redirectUri,
        });
      } catch (error) {
        if (error instanceof OidcDeniedError) {
          req.log?.warn({ event: "auth.oidc.denied", reason: error.reason }, "oidc denied");
          return reply.code(401).send({ error: "invalid authorization response" });
        }
        throw error;
      }

      // An OIDC subject only signs in through an existing verified mapping — no JIT provisioning.
      let userId: string;
      try {
        userId = await resolveExternalIdentity(
          deps.externalIdentityRepo,
          deps.oidc.provider.providerId,
          claims.claims.subject
        );
      } catch (error) {
        if (error instanceof ExternalIdentityDeniedError) {
          req.log?.warn({ event: "auth.oidc.unmapped", reason: error.reason }, "oidc unmapped");
          return reply.code(403).send({ error: "identity is not linked to a user" });
        }
        throw error;
      }

      const user = await deps.userRepo.findById(userId);
      if (!user) return reply.code(403).send({ error: "identity is not linked to a user" });
      try {
        assertUserAuthenticatable(user);
      } catch {
        return reply.code(403).send({ error: "identity is not linked to a user" });
      }

      const mfaProven = claimsProveMfa(claims.claims);
      const session = await rotateSession(deps.sessionStore, req.cookies[SESSION_COOKIE], {
        userId: user._id,
        authMethods: ["oidc"],
        mfaVerifiedAt: mfaProven ? new Date() : null,
      });
      reply.setCookie(SESSION_COOKIE, session.sid, sessionCookieOptions(ttlSeconds));
      setCsrfCookie(reply, session.csrfToken, ttlSeconds);

      if (claims.redirectTo) return reply.redirect(claims.redirectTo, 302);
      return reply.code(200).send({ user: toPublicUser(user) });
    }
  );
}

function registerStepUpRoute(
  app: FastifyInstance,
  deps: IdentityRouteDeps,
  requireAuth: PreHandler,
  ttlSeconds: number
): void {
  app.post(
    "/api/v1/auth/step-up",
    {
      preHandler: chain(deps.credentialRateLimitHook, requireAuth),
      schema: {
        description: "Prove a second factor and elevate the current session.",
        tags: ["auth"],
        security: [{ sessionCookie: [] }],
        body: {
          type: "object",
          required: ["method", "proof"],
          properties: {
            method: { type: "string", enum: ["totp", "passkey"] },
            proof: {},
          },
        },
        response: {
          200: {
            type: "object",
            properties: { mfaVerifiedAt: { type: "string", format: "date-time" } },
            required: ["mfaVerifiedAt"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal;
      // Step-up re-proves an interactive factor; a token or client credential has none to prove.
      if (principal?.credential !== "session" || !principal.sessionId) {
        return reply.code(403).send({ error: "step-up requires an interactive session" });
      }

      const body = (req.body ?? {}) as { method?: unknown; proof?: unknown };
      if (!isAuthMethod(body.method) || body.method === "password" || body.method === "oidc") {
        return reply.code(400).send({ error: "unsupported step-up method" });
      }

      const verifier = deps.mfa?.get(body.method);
      if (!verifier) {
        return reply.code(400).send({ error: "unsupported step-up method" });
      }

      const verified = await verifier.verify({
        userId: principal.id,
        method: body.method,
        proof: body.proof,
      });
      if (!verified) {
        req.log?.warn({ event: "auth.step_up.denied", method: body.method }, "step-up denied");
        return reply.code(401).send({ error: "step-up verification failed" });
      }

      // Elevation rotates the session id: a session id captured before the second factor cannot
      // be replayed against the now-elevated session.
      const mfaVerifiedAt = new Date();
      const session = await rotateSession(deps.sessionStore, principal.sessionId, {
        userId: principal.id,
        authMethods: [...principal.authMethods, body.method],
        mfaVerifiedAt,
      });
      reply.setCookie(SESSION_COOKIE, session.sid, sessionCookieOptions(ttlSeconds));
      setCsrfCookie(reply, session.csrfToken, ttlSeconds);
      return reply.code(200).send({ mfaVerifiedAt: mfaVerifiedAt.toISOString() });
    }
  );
}

const API_CLIENT_READ: RouteAuthorization = {
  action: "identity.api_client.read",
  resourceType: "identity",
  fallback: "admin",
};
const API_CLIENT_CREATE: RouteAuthorization = {
  action: "identity.api_client.create",
  resourceType: "identity",
  fallback: "admin",
};
const API_CLIENT_ROTATE: RouteAuthorization = {
  action: "identity.api_client.rotate",
  resourceType: "identity",
  fallback: "admin",
};
const API_CLIENT_DISABLE: RouteAuthorization = {
  action: "identity.api_client.disable",
  resourceType: "identity",
  fallback: "admin",
};

function registerApiClientRoutes(
  app: FastifyInstance,
  deps: IdentityRouteDeps,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const repo = deps.apiClientRepo;
  if (!repo) return;

  app.get(
    "/api/v1/identity/api-clients",
    {
      preHandler: chain(deps.rateLimitHook, requireAuth, requireAuthorization(API_CLIENT_READ)),
      schema: {
        description: "List API clients (service identities). Admin only.",
        tags: ["identity"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: { clients: { type: "array", items: PublicApiClientSchema } },
            required: ["clients"],
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const clients = await repo.findAll();
      return reply.send({ clients: clients.map(toPublicApiClient) });
    }
  );

  app.post(
    "/api/v1/identity/api-clients",
    {
      preHandler: chain(deps.rateLimitHook, requireAuth, requireAuthorization(API_CLIENT_CREATE)),
      schema: {
        description: "Create an API client. The secret is returned exactly once. Admin only.",
        tags: ["identity"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: { client: PublicApiClientSchema, credential: { type: "string" } },
            required: ["client", "credential"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { name?: unknown; expiresAt?: unknown };
      if (typeof body.name !== "string" || body.name.trim() === "") {
        return reply.code(400).send({ error: "name is required" });
      }
      let expiresAt: Date | null = null;
      if (typeof body.expiresAt === "string") {
        const parsed = new Date(body.expiresAt);
        if (Number.isNaN(parsed.getTime())) {
          return reply.code(400).send({ error: "expiresAt is not a valid date" });
        }
        expiresAt = parsed;
      }
      const ownerUserId = req.principal?.id as string;
      const { doc, secret } = await createApiClient(repo, {
        name: body.name.trim(),
        ownerUserId,
        expiresAt,
      });
      return reply.code(201).send({
        client: toPublicApiClient(doc),
        credential: formatApiClientCredential(doc.clientId, secret),
      });
    }
  );

  app.post(
    "/api/v1/identity/api-clients/:id/rotate",
    {
      preHandler: chain(deps.rateLimitHook, requireAuth, requireAuthorization(API_CLIENT_ROTATE)),
      schema: {
        description:
          "Rotate an API client secret. The previous secret stops working at once. Admin only.",
        tags: ["identity"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            properties: { credential: { type: "string" } },
            required: ["credential"],
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const rotated = await rotateApiClientSecret(repo, id);
      if (!rotated) return reply.code(404).send({ error: "not found" });
      return reply.send({ credential: rotated.credential });
    }
  );

  app.post(
    "/api/v1/identity/api-clients/:id/disable",
    {
      preHandler: chain(deps.rateLimitHook, requireAuth, requireAuthorization(API_CLIENT_DISABLE)),
      schema: {
        description:
          "Disable an API client. Its credential is refused on the next request. Admin only.",
        tags: ["identity"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            properties: { client: PublicApiClientSchema },
            required: ["client"],
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const client = await repo.findById(id);
      if (!client) return reply.code(404).send({ error: "not found" });
      await repo.updateStatus(id, "disabled");
      return reply.send({ client: toPublicApiClient({ ...client, status: "disabled" }) });
    }
  );
}

const ExternalLinkSchema = {
  type: "object",
  properties: {
    provider: { type: "string" },
    externalSubject: { type: "string" },
    userId: { type: "string" },
    verifiedAt: { type: "string", format: "date-time" },
  },
  required: ["provider", "externalSubject", "userId", "verifiedAt"],
} as const;

function registerExternalLinkRoutes(
  app: FastifyInstance,
  deps: IdentityRouteDeps,
  requireAuth: PreHandler
): void {
  const repo = deps.externalIdentityRepo;
  if (!repo) return;

  app.post(
    "/api/v1/identity/external-links",
    {
      preHandler: chain(deps.rateLimitHook, requireAuth),
      schema: {
        description: "Mint a one-use link token binding an external subject to the current user.",
        tags: ["identity"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string", minLength: 1 } },
        },
        response: {
          201: {
            type: "object",
            properties: {
              linkToken: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
            },
            required: ["linkToken", "expiresAt"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal;
      if (principal?.kind !== "user") {
        return reply.code(403).send({ error: "only a user may link an external identity" });
      }
      const body = (req.body ?? {}) as { provider?: unknown };
      if (typeof body.provider !== "string" || body.provider.trim() === "") {
        return reply.code(400).send({ error: "provider is required" });
      }
      const { raw, expiresAt } = await mintLinkToken(repo, {
        userId: principal.id,
        provider: body.provider.trim(),
      });
      return reply.code(201).send({ linkToken: raw, expiresAt: expiresAt.toISOString() });
    }
  );

  app.post(
    "/api/v1/identity/external-links/redeem",
    {
      preHandler: chain(deps.rateLimitHook, requireAuth),
      schema: {
        description: "Redeem a link token for one verified external subject (single use).",
        tags: ["identity"],
        security: [{ bearerToken: [] }],
        body: {
          type: "object",
          required: ["linkToken", "provider", "externalSubject"],
          properties: {
            linkToken: { type: "string" },
            provider: { type: "string", minLength: 1 },
            externalSubject: { type: "string", minLength: 1 },
          },
        },
        response: {
          201: {
            type: "object",
            properties: { link: ExternalLinkSchema },
            required: ["link"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      // Redemption asserts "this provider verified this subject" — only the integration's own
      // service identity may make that claim, never a browser session.
      if (req.principal?.kind !== "service") {
        return reply.code(403).send({ error: "only a service identity may redeem a link token" });
      }
      const body = (req.body ?? {}) as {
        linkToken?: unknown;
        provider?: unknown;
        externalSubject?: unknown;
      };
      if (
        typeof body.linkToken !== "string" ||
        typeof body.provider !== "string" ||
        typeof body.externalSubject !== "string"
      ) {
        return reply.code(400).send({ error: "linkToken, provider and externalSubject required" });
      }
      try {
        const mapping = await redeemLinkToken(repo, {
          raw: body.linkToken,
          provider: body.provider,
          externalSubject: body.externalSubject,
        });
        return reply.code(201).send({
          link: {
            provider: mapping.provider,
            externalSubject: mapping.externalSubject,
            userId: mapping.userId,
            verifiedAt: mapping.verifiedAt.toISOString(),
          },
        });
      } catch (error) {
        if (error instanceof LinkRedemptionDeniedError) {
          req.log?.warn({ event: "identity.link.denied", reason: error.reason }, "link denied");
          return reply.code(400).send({ error: "link token is not redeemable" });
        }
        throw error;
      }
    }
  );

  app.get(
    "/api/v1/identity/external-links",
    {
      preHandler: chain(deps.rateLimitHook, requireAuth),
      schema: {
        description: "List the external identities linked to the current user.",
        tags: ["identity"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: { links: { type: "array", items: ExternalLinkSchema } },
            required: ["links"],
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal;
      if (principal?.kind !== "user") {
        return reply.code(403).send({ error: "forbidden" });
      }
      const links = await repo.listMappingsForUser(principal.id);
      return reply.send({
        links: links.map((link) => ({
          provider: link.provider,
          externalSubject: link.externalSubject,
          userId: link.userId,
          verifiedAt: link.verifiedAt.toISOString(),
        })),
      });
    }
  );

  app.delete(
    "/api/v1/identity/external-links/:provider/:externalSubject",
    {
      preHandler: chain(deps.rateLimitHook, requireAuth),
      schema: {
        description: "Remove one of the current user's external identity links.",
        tags: ["identity"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["provider", "externalSubject"],
          properties: {
            provider: { type: "string" },
            externalSubject: { type: "string" },
          },
        },
        response: { 204: { type: "null" }, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const principal = req.principal;
      if (principal?.kind !== "user") {
        return reply.code(403).send({ error: "forbidden" });
      }
      const { provider, externalSubject } = req.params as {
        provider: string;
        externalSubject: string;
      };
      const mapping = await repo.findMapping(provider, externalSubject);
      // A user may only unlink their own mapping — and cannot probe for other users' links.
      if (!mapping || mapping.userId !== principal.id) {
        return reply.code(404).send({ error: "not found" });
      }
      await repo.deleteMapping(provider, externalSubject);
      return reply.code(204).send();
    }
  );
}

const ChannelBindOfferSchema = {
  type: "object",
  properties: {
    slug: { type: "string" },
    senderId: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
    account: {
      type: "object",
      properties: { userId: { type: "string" }, email: { type: "string" } },
      required: ["userId", "email"],
    },
  },
  required: ["slug", "senderId", "expiresAt", "account"],
} as const;

/** Reverse link tokens prove issuance only; binding always uses the user session. */
function registerChannelBindRoutes(
  app: FastifyInstance,
  deps: IdentityRouteDeps,
  requireAuth: PreHandler
): void {
  const bind = deps.channelBind;
  if (!bind) return;

  /** The token travels in the body: a query string would reach access logs and referrers. */
  const TokenBody = {
    type: "object",
    required: ["token"],
    properties: { token: { type: "string", minLength: 1 } },
  } as const;

  const readToken = (req: FastifyRequest): string | null => {
    const body = (req.body ?? {}) as { token?: unknown };
    return typeof body.token === "string" && body.token !== "" ? body.token : null;
  };

  app.post(
    "/api/v1/identity/channel-links/preview",
    {
      preHandler: chain(deps.credentialRateLimitHook, requireAuth),
      schema: {
        description:
          "Describe the channel identity a bind link would bind, and the account it would be " +
          "bound to, without spending the link.",
        tags: ["identity"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: TokenBody,
        response: {
          200: ChannelBindOfferSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal;
      if (principal?.kind !== "user") {
        return reply.code(403).send({ error: "only a user may bind a channel identity" });
      }
      const token = readToken(req);
      if (!token) return reply.code(400).send({ error: "token is required" });

      const user = await deps.userRepo.findById(principal.id);
      if (!user) return reply.code(403).send({ error: "only a user may bind a channel identity" });

      try {
        const offer = await previewChannelBind(bind, token);
        return reply.send({
          slug: offer.slug,
          senderId: offer.senderId,
          expiresAt: offer.expiresAt.toISOString(),
          account: { userId: user._id, email: user.email },
        });
      } catch (error) {
        if (error instanceof ChannelBindDeniedError) {
          req.log?.warn({ event: "identity.bind.denied", reason: error.reason }, "bind denied");
          return reply.code(400).send({ error: "bind link is not usable" });
        }
        throw error;
      }
    }
  );

  app.post(
    "/api/v1/identity/channel-links/confirm",
    {
      preHandler: chain(deps.credentialRateLimitHook, requireAuth),
      schema: {
        description:
          "Bind the channel identity named by a bind link to the signed-in account. Single use.",
        tags: ["identity"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: TokenBody,
        response: {
          201: { type: "object", properties: { link: ExternalLinkSchema }, required: ["link"] },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const principal = req.principal;
      if (principal?.kind !== "user") {
        return reply.code(403).send({ error: "only a user may bind a channel identity" });
      }
      const token = readToken(req);
      if (!token) return reply.code(400).send({ error: "token is required" });

      try {
        const mapping = await redeemChannelBindToken(bind, token, principal.id);
        req.log?.info(
          { event: "identity.bind.confirmed", provider: mapping.provider },
          "channel identity bound"
        );
        return reply.code(201).send({
          link: {
            provider: mapping.provider,
            externalSubject: mapping.externalSubject,
            userId: mapping.userId,
            verifiedAt: mapping.verifiedAt.toISOString(),
          },
        });
      } catch (error) {
        if (error instanceof ChannelBindDeniedError) {
          req.log?.warn({ event: "identity.bind.denied", reason: error.reason }, "bind denied");
          return reply.code(400).send({ error: "bind link is not usable" });
        }
        throw error;
      }
    }
  );
}
