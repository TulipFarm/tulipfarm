import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sessionCookieOptions } from "../auth/cookie-security";
import { setCsrfCookie } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { ErrorSchema } from "../auth/schemas";
import {
  type AuthMethod,
  DEFAULT_SESSION_TTL_SECONDS,
  rotateSession,
  type SessionStore,
} from "../auth/session-store";
import { toPublicUser, type UserRepo } from "../auth/users";
import type { RequireAuthorization, RouteAuthorization } from "../authz/route-gate";
import { integrationSecretKey } from "../integrations/connection-env";
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
import * as S from "./schemas";
import type { MfaVerifierRegistry } from "./step-up";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
/** Just enough of `SecretsService` to read the sealed Slack bot token (narrow for testability). */
export interface IdentityBindSecretStore {
  get(key: string): Promise<string>;
}
export interface OidcConfig {
  readonly provider: OidcProvider;
  readonly requestRepo: OidcAuthRequestRepo;
  readonly redirectUri: string;
}
export interface IdentityRouteDeps {
  sessionStore: SessionStore;
  userRepo: UserRepo;
  apiClientRepo?: ApiClientRepo;
  externalIdentityRepo?: ExternalIdentityRepo;
  channelBind?: ChannelBindDeps;
  /** Resolves the sealed Slack bot token; absent → confirm still binds, just skips the reply. */
  channelBindSecrets?: IdentityBindSecretStore;
  oidc?: OidcConfig;
  mfa?: MfaVerifierRegistry;
  ttlSeconds?: number;
  rateLimitHook?: PreHandler;
  credentialRateLimitHook?: PreHandler;
}
function chain(...hooks: Array<PreHandler | undefined>): PreHandler[] {
  return hooks.filter((hook): hook is PreHandler => hook !== undefined);
}
const IDENTITY_LIMIT = 100;
const IDENTITY_WINDOW_MS = 60_000;
const CREDENTIAL_LIMIT = 10;
const CREDENTIAL_WINDOW_MS = 900_000;
const AUTH_METHODS: AuthMethod[] = ["password", "oidc", "totp", "passkey"];
const toLink = (mapping: {
  provider: string;
  externalSubject: string;
  userId: string;
  verifiedAt: Date;
}) => ({
  provider: mapping.provider,
  externalSubject: mapping.externalSubject,
  userId: mapping.userId,
  verifiedAt: mapping.verifiedAt.toISOString(),
});
function isAuthMethod(value: unknown): value is AuthMethod {
  return typeof value === "string" && (AUTH_METHODS as string[]).includes(value);
}

/**
 * Best-effort reply into the channel a bind offer was sent to, once the bind is confirmed.
 *
 * Mirrors the bind-offer route's self-posting exception (`apps/api/src/internal/channel-routes.ts`):
 * the offer's channel/thread never leaves this process, so this process posts the confirmation
 * itself rather than handing the ref to a Worker. Never throws — a failed reply must not undo an
 * already-successful bind.
 */
async function postBindConfirmation(
  deps: IdentityRouteDeps,
  mapping: { provider: string; channelId: string | null; threadId: string | null },
  log: FastifyRequest["log"]
): Promise<void> {
  if (mapping.provider !== "slack" || !mapping.channelId || !deps.channelBindSecrets) return;
  try {
    const botToken = await deps.channelBindSecrets.get(
      integrationSecretKey("slack", "SLACK_BOT_TOKEN")
    );
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: mapping.channelId,
        text: "Account connected. You can ask me again.",
        ...(mapping.threadId ? { thread_ts: mapping.threadId } : {}),
      }),
    });
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok) {
      log?.warn({ error: body.error }, "slack bind-confirm reply failed");
    }
  } catch (err) {
    log?.warn({ err }, "slack bind-confirm reply failed");
  }
}
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
        querystring: S.OidcStartQuerystringSchema,
        response: { 302: S.NullResponseSchema, 503: ErrorSchema },
      },
    },
    async (req, reply) => {
      if (!deps.oidc) {
        return reply.code(503).send({ error: "oidc is not configured" });
      }
      const query = (req.query ?? {}) as { redirectTo?: unknown };
      const { url } = await startOidcAuthorization(deps.oidc.requestRepo, deps.oidc.provider, {
        redirectUri: deps.oidc.redirectUri,
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
        ...S.OidcCallbackRouteSchema,
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
        ...S.StepUpRouteSchema,
      },
    },
    async (req, reply) => {
      const principal = req.principal;
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
const ADMIN_IDENTITY_AUTH = { resourceType: "identity", fallback: "admin" } as const;
const API_CLIENT_READ: RouteAuthorization = {
  action: "identity.api_client.read",
  ...ADMIN_IDENTITY_AUTH,
};
const API_CLIENT_CREATE: RouteAuthorization = {
  action: "identity.api_client.create",
  ...ADMIN_IDENTITY_AUTH,
};
const API_CLIENT_ROTATE: RouteAuthorization = {
  action: "identity.api_client.rotate",
  ...ADMIN_IDENTITY_AUTH,
};
const API_CLIENT_DISABLE: RouteAuthorization = {
  action: "identity.api_client.disable",
  ...ADMIN_IDENTITY_AUTH,
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
        ...S.ApiClientListRouteSchema,
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
        ...S.ApiClientCreateRouteSchema,
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
        ...S.ApiClientRotateRouteSchema,
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
        ...S.ApiClientDisableRouteSchema,
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
        ...S.ExternalLinkCreateRouteSchema,
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
        ...S.ExternalLinkRedeemRouteSchema,
      },
    },
    async (req, reply) => {
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
        return reply.code(201).send({ link: toLink(mapping) });
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
        ...S.ExternalLinkListRouteSchema,
      },
    },
    async (req, reply) => {
      const principal = req.principal;
      if (principal?.kind !== "user") {
        return reply.code(403).send({ error: "forbidden" });
      }
      const links = await repo.listMappingsForUser(principal.id);
      return reply.send({ links: links.map(toLink) });
    }
  );
  app.delete(
    "/api/v1/identity/external-links/:provider/:externalSubject",
    {
      preHandler: chain(deps.rateLimitHook, requireAuth),
      schema: {
        description: "Remove one of the current user's external identity links.",
        ...S.ExternalLinkDeleteRouteSchema,
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
      if (!mapping || mapping.userId !== principal.id) {
        return reply.code(404).send({ error: "not found" });
      }
      await repo.deleteMapping(provider, externalSubject);
      return reply.code(204).send();
    }
  );
}
function registerChannelBindRoutes(
  app: FastifyInstance,
  deps: IdentityRouteDeps,
  requireAuth: PreHandler
): void {
  const bind = deps.channelBind;
  if (!bind) return;
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
        ...S.ChannelBindPreviewRouteSchema,
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
          "Bind the channel identity named by a bind link to the signed-in account. Single use. " +
          "Best-effort posts a confirmation back into the channel the offer came from.",
        ...S.ChannelBindConfirmRouteSchema,
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
        await postBindConfirmation(deps, mapping, req.log);
        return reply.code(201).send({ link: toLink(mapping) });
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
