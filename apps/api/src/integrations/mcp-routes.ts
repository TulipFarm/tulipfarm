import { Type } from "@sinclair/typebox";
import {
  McpAccountAccessError,
  type McpCaller,
  type McpCapabilityReview,
  McpCapabilityReviewSchema,
  type McpConfigure,
  McpConfigureSchema,
  McpIntegrationDefinitionSchema,
  McpIntegrationError,
  type McpIntegrationService,
} from "@tulipfarm/integrations";
import { McpError } from "@tulipfarm/mcp";
import { type CommitActor, isSoulWriteError, soulWriteHttpError } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization } from "../authz/route-gate";
import { commitActorFromRequest } from "../soul/commit-actor";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const params = Type.Object({ slug: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }) });
const serverResponse = Type.Object({ server: McpIntegrationDefinitionSchema });
const chatId = Type.Optional(Type.String({ minLength: 1, maxLength: 256 }));
const accountId = Type.Optional(Type.String({ minLength: 1, maxLength: 256 }));
const readBody = Type.Object(
  { uri: Type.String({ minLength: 1, maxLength: 4096 }), chatId, accountId },
  { additionalProperties: false }
);
const promptBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    arguments: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 16_384 }))),
    chatId,
    accountId,
  },
  { additionalProperties: false }
);
const jsonObject = Type.Record(Type.String(), Type.Unknown());
const security: Record<string, string[]>[] = [{ sessionCookie: [] }, { bearerToken: [] }];
const common = {
  tags: ["Integrations"],
  security,
};
const failures = {
  400: ErrorSchema,
  401: ErrorSchema,
  403: ErrorSchema,
  404: ErrorSchema,
  409: ErrorSchema,
  422: ErrorSchema,
  500: ErrorSchema,
  502: ErrorSchema,
  503: ErrorSchema,
};

export interface McpIntegrationRouteDeps {
  readonly service: McpIntegrationService<CommitActor>;
  readonly catalog: readonly Record<string, unknown>[];
  readonly caller: (request: FastifyRequest, chatId?: string) => Promise<McpCaller>;
  readonly accountConfiguration?: (id: string) => Promise<{
    readonly authentication: "none" | "token" | "oauth";
    readonly requiredSlots: readonly string[];
    readonly sharedAllowed: boolean;
  }>;
}

async function respond(reply: FastifyReply, operation: () => Promise<unknown>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof McpAccountAccessError) {
      const status =
        error.code === "account_access_denied" ||
        error.code === "principal_inactive" ||
        error.code === "private_context_required"
          ? 403
          : error.code === "account_not_found"
            ? 404
            : 409;
      return reply
        .code(status)
        .send({ error: error.code, code: error.code, message: error.message });
    }
    if (error instanceof McpIntegrationError) {
      const status =
        error.code === "not_found"
          ? 404
          : error.code === "selection_required" ||
              error.code === "consent_required" ||
              error.code === "reconnect_required" ||
              error.code === "capability_changed"
            ? 409
            : error.code === "forbidden" ||
                error.code === "disabled" ||
                error.code === "review_required"
              ? 403
              : error.code === "unavailable"
                ? 503
                : 422;
      return reply
        .code(status)
        .send({ error: error.code, code: error.code, message: error.message });
    }
    if (error instanceof McpError) {
      return reply
        .code(502)
        .send({ error: "mcp_request_failed", code: error.code, message: error.message });
    }
    if (isSoulWriteError(error)) {
      const mapped = soulWriteHttpError(error);
      return reply.code(mapped.status).send(mapped.body);
    }
    throw error;
  }
}

export function registerMcpIntegrationRoutes(
  app: FastifyInstance,
  deps: McpIntegrationRouteDeps,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  async function callerForAccount(
    request: FastifyRequest,
    selection: { readonly chatId?: string; readonly accountId?: string }
  ): Promise<McpCaller> {
    if (selection.chatId !== undefined && selection.accountId !== undefined) {
      throw new McpAccountAccessError("account_access_denied");
    }
    const caller = await deps.caller(request, selection.chatId);
    return selection.accountId === undefined
      ? caller
      : { ...caller, accountId: selection.accountId };
  }
  const read = [
    requireAuth,
    requireAuthorization({
      action: "integration.read",
      resourceType: "integration",
      fallback: "authenticated",
    }),
  ];
  const configure = [
    requireAuth,
    requireAuthorization({
      action: "integration.connect",
      resourceType: "integration",
      fallback: "admin",
    }),
  ];
  app.get<{ Params: { slug: string } }>(
    "/api/v1/integrations/:slug/accounts/configuration",
    {
      preHandler: read,
      schema: {
        ...common,
        description: "Read non-secret account setup requirements from the active MCP definition.",
        params,
        response: {
          200: Type.Object(
            {
              authentication: Type.Union([
                Type.Literal("none"),
                Type.Literal("token"),
                Type.Literal("oauth"),
              ]),
              requiredSlots: Type.Array(Type.String()),
              sharedAllowed: Type.Boolean(),
            },
            { additionalProperties: false }
          ),
          ...failures,
        },
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        deps.service.get(request.params.slug);
        if (!deps.accountConfiguration) {
          throw new McpIntegrationError(
            "unavailable",
            "Account setup requirements are unavailable."
          );
        }
        const configuration = await deps.accountConfiguration(request.params.slug);
        return {
          authentication: configuration.authentication,
          requiredSlots: [...configuration.requiredSlots],
          sharedAllowed: configuration.sharedAllowed,
        };
      })
  );
  app.get(
    "/api/v1/integrations",
    {
      preHandler: read,
      schema: {
        ...common,
        description: "List configured MCP servers and reviewed capabilities.",
        response: {
          200: Type.Object({ servers: Type.Array(McpIntegrationDefinitionSchema) }),
          ...failures,
        },
      },
    },
    async () => ({ servers: deps.service.list() })
  );
  app.get(
    "/api/v1/integrations/catalog",
    {
      preHandler: read,
      schema: {
        ...common,
        description: "Browse publisher-verified MCP setup metadata; listings grant no capability.",
        response: { 200: Type.Object({ entries: Type.Array(jsonObject) }), ...failures },
      },
    },
    async () => ({ entries: deps.catalog })
  );
  app.get<{ Params: { slug: string } }>(
    "/api/v1/integrations/:slug",
    {
      preHandler: read,
      schema: {
        ...common,
        description: "Read an MCP server definition.",
        params,
        response: { 200: serverResponse, ...failures },
      },
    },
    async (request, reply) =>
      respond(reply, async () => ({ server: deps.service.get(request.params.slug) }))
  );
  app.put<{ Params: { slug: string }; Body: McpConfigure }>(
    "/api/v1/integrations/:slug",
    {
      preHandler: configure,
      schema: {
        ...common,
        description:
          "Configure or enable an MCP server through the Soul write gateway. Changed servers require fresh capability review.",
        params,
        body: McpConfigureSchema,
        response: { 200: serverResponse, ...failures },
      },
    },
    async (request, reply) =>
      respond(reply, async () => ({
        server: await deps.service.configure(
          request.params.slug,
          request.body,
          commitActorFromRequest(request)
        ),
      }))
  );
  app.delete<{ Params: { slug: string } }>(
    "/api/v1/integrations/:slug",
    {
      preHandler: [
        requireAuth,
        requireAuthorization({
          action: "integration.remove",
          resourceType: "integration",
          fallback: "admin",
        }),
      ],
      schema: {
        ...common,
        description: "Remove an MCP server definition and revoke its published capabilities.",
        params,
        response: { 204: Type.Null(), ...failures },
      },
    },
    async (request, reply) =>
      respond(reply, async () => {
        await deps.service.remove(request.params.slug, commitActorFromRequest(request));
        return reply.code(204).send();
      })
  );
  app.post<{ Params: { slug: string }; Body: { chatId?: string; accountId?: string } }>(
    "/api/v1/integrations/:slug/discover",
    {
      preHandler: configure,
      schema: {
        ...common,
        description:
          "Discover MCP capabilities under the caller's authorized account without enabling them.",
        params,
        body: Type.Object({ chatId, accountId }, { additionalProperties: false }),
        response: { 200: Type.Object({ capabilities: McpCapabilityReviewSchema }), ...failures },
      },
    },
    async (request, reply) =>
      respond(reply, async () => ({
        capabilities: await deps.service.discover(
          request.params.slug,
          await callerForAccount(request, request.body)
        ),
      }))
  );
  app.get<{ Params: { slug: string } }>(
    "/api/v1/integrations/:slug/capabilities",
    {
      preHandler: read,
      schema: {
        ...common,
        description: "List the exact reviewed, enabled MCP capabilities.",
        params,
        response: { 200: Type.Object({ capabilities: McpCapabilityReviewSchema }), ...failures },
      },
    },
    async (request, reply) =>
      respond(reply, async () => ({
        capabilities: deps.service.get(request.params.slug).reviewed,
      }))
  );
  app.put<{
    Params: { slug: string };
    Body: McpCapabilityReview;
    Querystring: { chatId?: string; accountId?: string };
  }>(
    "/api/v1/integrations/:slug/capabilities",
    {
      preHandler: configure,
      schema: {
        ...common,
        description:
          "Review and enable an exact discovery snapshot; server hints do not authorize execution.",
        params,
        body: McpCapabilityReviewSchema,
        querystring: Type.Object({ chatId, accountId }, { additionalProperties: false }),
        response: { 200: serverResponse, ...failures },
      },
    },
    async (request, reply) =>
      respond(reply, async () => ({
        server: await deps.service.review(
          request.params.slug,
          request.body,
          await callerForAccount(request, request.query),
          commitActorFromRequest(request)
        ),
      }))
  );
  app.post<{
    Params: { slug: string };
    Body: { uri: string; chatId?: string; accountId?: string };
  }>(
    "/api/v1/integrations/:slug/resources/read",
    {
      preHandler: read,
      schema: {
        ...common,
        description: "Read one reviewed MCP resource using current account authority.",
        params,
        body: readBody,
        response: { 200: Type.Object({ contents: Type.Array(jsonObject) }), ...failures },
      },
    },
    async (request, reply) =>
      respond(reply, async () =>
        deps.service.readResource(
          request.params.slug,
          await callerForAccount(request, request.body),
          request.body.uri
        )
      )
  );
  app.post<{
    Params: { slug: string };
    Body: { name: string; arguments?: Record<string, string>; chatId?: string; accountId?: string };
  }>(
    "/api/v1/integrations/:slug/prompts/render",
    {
      preHandler: read,
      schema: {
        ...common,
        description: "Render a reviewed MCP prompt as untrusted content, without executing it.",
        params,
        body: promptBody,
        response: {
          200: Type.Object({
            description: Type.Optional(Type.String()),
            messages: Type.Array(
              Type.Object({
                role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
                content: jsonObject,
              })
            ),
          }),
          ...failures,
        },
      },
    },
    async (request, reply) =>
      respond(reply, async () =>
        deps.service.renderPrompt(
          request.params.slug,
          await callerForAccount(request, request.body),
          request.body.name,
          request.body.arguments ?? {}
        )
      )
  );
}
