import { type Static, Type } from "@sinclair/typebox";
import {
  McpAccountAccessError,
  McpIntegrationError,
  type McpSetupService,
} from "@tulipfarm/integrations";
import {
  McpSetupCredentialsSchema,
  McpSetupEligibilitySchema,
  McpSetupStartSchema,
  McpSetupStatusSchema,
} from "@tulipfarm/schema";
import type { CommitActor } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import type { RequireAuthorization } from "../../authz/route-gate";
import { commitActorFromRequest } from "../../soul/commit-actor";
import { accountResponse } from "./routes";

export function registerMcpSetupRoutes(
  app: FastifyInstance,
  setup: McpSetupService<CommitActor>,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  requireAuthorization: RequireAuthorization
) {
  const params = Type.Object(
    { operationId: Type.String({ format: "uuid" }) },
    { additionalProperties: false }
  );
  const query = Type.Object(
    {
      integrationKey: Type.String({ minLength: 1, maxLength: 128 }),
      accountId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false }
  );
  const security: Record<string, string[]>[] = [{ sessionCookie: [] }, { bearerToken: [] }];
  const schema = {
    tags: ["Integrations"],
    security,
    response: {
      200: McpSetupStatusSchema,
      400: ErrorSchema,
      401: ErrorSchema,
      403: ErrorSchema,
      404: ErrorSchema,
      409: ErrorSchema,
      422: ErrorSchema,
      500: ErrorSchema,
    },
  };
  const gate = (write: boolean) => [
    requireAuth,
    requireAuthorization({
      action: write ? "integration.accounts.write" : "integration.accounts.read",
      resourceType: "integration_account",
      fallback: "authenticated",
    }),
  ];
  const caller = (request: FastifyRequest) => {
    if (request.principal?.kind !== "user")
      throw new McpAccountAccessError("account_access_denied");
    return request.principal;
  };
  const respond = (
    request: FastifyRequest,
    reply: FastifyReply,
    operation: () => Promise<unknown>
  ) =>
    accountResponse(request, reply, async () => {
      reply.header("Cache-Control", "no-store");
      try {
        return await operation();
      } catch (error) {
        if (error instanceof McpIntegrationError)
          return reply.code(error.code === "not_found" ? 404 : 422).send({ error: error.code });
        throw error;
      }
    });
  const definitionParams = Type.Object(
    {
      integrationKey: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
    },
    { additionalProperties: false }
  );
  app.get<{ Params: Static<typeof definitionParams> }>(
    "/api/v1/integrations/:integrationKey/setup",
    {
      preHandler: gate(false),
      schema: {
        ...schema,
        description:
          "Read published setup eligibility and its exact revision without discovering capabilities or writing consent.",
        params: definitionParams,
        response: { ...schema.response, 200: McpSetupEligibilitySchema },
      },
    },
    (request, reply) =>
      respond(request, reply, () => {
        const principal = caller(request);
        return setup.eligibility(principal.businessId, principal.id, request.params.integrationKey);
      })
  );
  app.get<{ Querystring: Static<typeof query> }>(
    "/api/v1/integration-setups",
    {
      preHandler: gate(false),
      schema: {
        ...schema,
        description:
          "Find this caller's saved setup consent for an exact account; never advances setup.",
        querystring: query,
        response: {
          ...schema.response,
          200: Type.Object({ operations: Type.Array(McpSetupStatusSchema) }),
        },
      },
    },
    (request, reply) =>
      respond(request, reply, async () => {
        const principal = caller(request);
        return {
          operations: await setup.list(
            principal.businessId,
            principal.id,
            request.query.integrationKey,
            request.query.accountId
          ),
        };
      })
  );
  app.get<{ Params: Static<typeof params> }>(
    "/api/v1/integration-setups/:operationId",
    {
      preHandler: gate(false),
      schema: {
        ...schema,
        description:
          "Read this caller's persisted setup progress without verification, discovery or policy writes.",
        params,
      },
    },
    (request, reply) =>
      respond(request, reply, () => {
        const principal = caller(request);
        return setup.status(principal.businessId, principal.id, request.params.operationId);
      })
  );
  app.post<{ Params: Static<typeof params>; Body: Static<typeof McpSetupStartSchema> }>(
    "/api/v1/integration-setups/:operationId",
    {
      preHandler: gate(true),
      schema: {
        ...schema,
        description:
          "Explicitly connect or finish an integration using durable account identity and initial-policy consent.",
        params,
        body: McpSetupStartSchema,
      },
    },
    (request, reply) =>
      respond(request, reply, () => {
        const principal = caller(request);
        return setup.start(
          principal.businessId,
          principal.id,
          request.params.operationId,
          request.body,
          commitActorFromRequest(request)
        );
      })
  );
  app.post<{ Params: Static<typeof params>; Body: Static<typeof McpSetupCredentialsSchema> }>(
    "/api/v1/integration-setups/:operationId/resume",
    {
      preHandler: gate(true),
      schema: {
        ...schema,
        description:
          "Explicitly resume the same setup consent and frozen snapshot after repair, sign-in or publication failure.",
        params,
        body: McpSetupCredentialsSchema,
      },
    },
    (request, reply) =>
      respond(request, reply, () => {
        const principal = caller(request);
        return setup.resume(
          principal.businessId,
          principal.id,
          request.params.operationId,
          request.body,
          commitActorFromRequest(request)
        );
      })
  );
}
