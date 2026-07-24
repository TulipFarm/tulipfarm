import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
import {
  type ApiClientRepo,
  createApiClient,
  formatApiClientCredential,
  rotateApiClientSecret,
  toPublicApiClient,
} from "./api-clients";
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
  oidc?: OidcConfig;
  mfa?: MfaVerifierRegistry;
  ttlSeconds?: number;
}

const AUTH_METHODS: AuthMethod[] = ["password", "oidc", "totp", "passkey"];

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

function isAuthMethod(value: unknown): value is AuthMethod {
  return typeof value === "string" && (AUTH_METHODS as string[]).includes(value);
}

/**
 * Identity surface (SPEC §12): OIDC sign-in, step-up authentication, API clients as service
 * identities, and the external identity link flow. Every route is default-deny — an unconfigured
 * provider, an unregistered factor, and a non-admin caller are all refusals, never fallbacks.
 */
export function registerIdentityRoutes(
  app: FastifyInstance,
  deps: IdentityRouteDeps,
  requireAuth: PreHandler
): void {
  const ttlSeconds = deps.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;

  registerOidcRoutes(app, deps, ttlSeconds);
  registerStepUpRoute(app, deps, requireAuth, ttlSeconds);
  registerApiClientRoutes(app, deps, requireAuth);
  registerExternalLinkRoutes(app, deps, requireAuth);
}

function registerOidcRoutes(
  app: FastifyInstance,
  deps: IdentityRouteDeps,
  ttlSeconds: number
): void {
  app.get(
    "/api/v1/auth/oidc/start",
    {
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
      reply.setCookie(SESSION_COOKIE, session.sid, cookieOptions(ttlSeconds));
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
      preHandler: requireAuth,
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
      reply.setCookie(SESSION_COOKIE, session.sid, cookieOptions(ttlSeconds));
      setCsrfCookie(reply, session.csrfToken, ttlSeconds);
      return reply.code(200).send({ mfaVerifiedAt: mfaVerifiedAt.toISOString() });
    }
  );
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.principal?.kind !== "user" || req.principal.role !== "admin") {
    reply.code(403).send({ error: "forbidden" });
    return false;
  }
  return true;
}

function registerApiClientRoutes(
  app: FastifyInstance,
  deps: IdentityRouteDeps,
  requireAuth: PreHandler
): void {
  const repo = deps.apiClientRepo;
  if (!repo) return;

  app.get(
    "/api/v1/identity/api-clients",
    {
      preHandler: requireAuth,
      schema: {
        description: "List API clients (service identities).",
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
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      const clients = await repo.findAll();
      return reply.send({ clients: clients.map(toPublicApiClient) });
    }
  );

  app.post(
    "/api/v1/identity/api-clients",
    {
      preHandler: requireAuth,
      schema: {
        description: "Create an API client. The secret is returned exactly once.",
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
      if (!requireAdmin(req, reply)) return;
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
      preHandler: requireAuth,
      schema: {
        description: "Rotate an API client secret. The previous secret stops working at once.",
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
      if (!requireAdmin(req, reply)) return;
      const { id } = req.params as { id: string };
      const rotated = await rotateApiClientSecret(repo, id);
      if (!rotated) return reply.code(404).send({ error: "not found" });
      return reply.send({ credential: rotated.credential });
    }
  );

  app.post(
    "/api/v1/identity/api-clients/:id/disable",
    {
      preHandler: requireAuth,
      schema: {
        description: "Disable an API client. Its credential is refused on the next request.",
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
      if (!requireAdmin(req, reply)) return;
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
      preHandler: requireAuth,
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
      preHandler: requireAuth,
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
      preHandler: requireAuth,
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
      preHandler: requireAuth,
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
