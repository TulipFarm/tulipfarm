import { type Static, Type } from "@sinclair/typebox";
import {
  McpAccountAccessError,
  McpOAuthError,
  type McpOAuthLifecycle,
} from "@tulipfarm/integrations";
import { McpOAuthConfigurationSchema } from "@tulipfarm/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import type { RequireAuthorization } from "../../authz/route-gate";
import { accountResponse } from "./routes";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const id = Type.String({ minLength: 1, maxLength: 256 });
const params = Type.Object({ key: id, accountId: id }, { additionalProperties: false });
const query = Type.Object(
  {
    state: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
    iss: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    error: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    error_description: Type.Optional(Type.String({ maxLength: 2048 })),
  },
  { additionalProperties: false }
);

function actor(request: FastifyRequest) {
  const principal = request.principal;
  if (principal?.kind !== "user" || principal.credential !== "session" || !principal.sessionId) {
    throw new McpAccountAccessError("account_access_denied");
  }
  return {
    businessId: principal.businessId,
    principalId: principal.id,
    sessionId: principal.sessionId,
  };
}

export function registerMcpOAuthRoutes(
  app: FastifyInstance,
  deps: {
    readonly oauth: McpOAuthLifecycle;
    readonly webUrl: () => Promise<string>;
  },
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const preHandler = [
    requireAuth,
    requireAuthorization({
      action: "integration.accounts.write",
      resourceType: "integration_account",
      fallback: "authenticated",
    }),
  ];
  const errors = {
    400: ErrorSchema,
    401: ErrorSchema,
    403: ErrorSchema,
    404: ErrorSchema,
    409: ErrorSchema,
    422: ErrorSchema,
    502: ErrorSchema,
  };
  const handle = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: () => Promise<T>
  ) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    return accountResponse(request, reply, async () => {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof McpOAuthError)) throw error;
        app.log.warn({ event: "integration.account.oauth_refused", code: error.code });
        const status =
          error.code === "oauth_invalid_state" || error.code === "oauth_issuer_mismatch"
            ? 400
            : error.code === "oauth_refresh_busy"
              ? 409
              : 502;
        return reply.code(status).send({ error: error.code });
      }
    });
  };
  app.get<{ Params: Static<typeof params> }>(
    "/api/v1/integrations/:key/accounts/:accountId/oauth/configuration",
    {
      preHandler,
      schema: {
        description: "Read the exact callback URL for this managed MCP OAuth account.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }],
        params,
        response: { 200: McpOAuthConfigurationSchema, ...errors },
      },
    },
    (request, reply) =>
      handle(request, reply, () =>
        deps.oauth.configuration(actor(request), request.params.key, request.params.accountId)
      )
  );
  app.post<{ Params: Static<typeof params> }>(
    "/api/v1/integrations/:key/accounts/:accountId/oauth/start",
    {
      preHandler,
      schema: {
        description: "Start session-bound MCP browser OAuth with one-use state and PKCE S256.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }],
        params,
        response: {
          200: Type.Object({ authorizationUrl: Type.String() }, { additionalProperties: false }),
          ...errors,
        },
      },
    },
    (request, reply) =>
      handle(request, reply, () =>
        deps.oauth.start(actor(request), request.params.key, request.params.accountId)
      )
  );
  app.get<{ Params: Static<typeof params>; Querystring: Static<typeof query> }>(
    "/api/v1/integrations/:key/accounts/:accountId/oauth/callback",
    {
      logLevel: "silent",
      preHandler,
      schema: {
        description:
          "Consume a session-, user-, account-, and issuer-bound MCP OAuth callback once.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }],
        params,
        querystring: query,
        response: { 302: Type.Null(), ...errors },
      },
    },
    (request, reply) =>
      handle(request, reply, async () => {
        const account = await deps.oauth.complete(
          actor(request),
          request.params.key,
          request.params.accountId,
          request.query
        );
        const url = new URL(
          `/integrations/${encodeURIComponent(request.params.key)}`,
          await deps.webUrl()
        );
        url.searchParams.set("account", account.id);
        url.searchParams.set("status", "connected");
        return reply.redirect(url.toString(), 302);
      })
  );
}
