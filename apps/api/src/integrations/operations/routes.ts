import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import type { AuthorizationCheck, RequireAuthorization } from "../../authz/route-gate";
import { OimConnectionRequestError } from "../connections/service";
import {
  IntegrationOperationsSchema,
  KnowledgeSubscriptionSchema,
  SaveKnowledgeSubscriptionSchema,
} from "./schemas";
import type { IntegrationOperationsService, SaveKnowledgeSubscription } from "./service";

export function registerIntegrationOperationsRoutes(
  app: FastifyInstance,
  service: IntegrationOperationsService,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  requireAuthorization: RequireAuthorization,
  authorizationCheck: AuthorizationCheck
): void {
  const preHandler = [
    requireAuth,
    requireAuthorization({
      action: "integration_connection.manage",
      resourceType: "integration_connection",
      fallback: "authenticated",
    }),
  ];
  const actor = async (request: FastifyRequest) => {
    if (request.principal?.kind !== "user") throw new OimConnectionRequestError(403, "forbidden");
    return {
      principalId: request.principal.id,
      mayManageShared: await authorizationCheck(request.principal, {
        action: "integration_connection.manage_shared",
        resourceType: "integration_connection",
        conditions: { scope: "shared" },
        fallback: "admin",
      }),
    };
  };
  const responses = {
    400: ErrorSchema,
    401: ErrorSchema,
    403: ErrorSchema,
    404: ErrorSchema,
    409: ErrorSchema,
  };
  const schema: FastifySchema = {
    tags: ["integrations"],
    security: [{ sessionCookie: [] }, { bearerToken: [] }],
    params: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string", minLength: 1, maxLength: 128 },
        connectionId: { type: "string", minLength: 1, maxLength: 256 },
      },
    },
    response: responses,
  };
  const run = async (reply: FastifyReply, operation: () => Promise<unknown>) => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof OimConnectionRequestError) {
        return reply.code(error.statusCode).send({ error: error.code });
      }
      throw error;
    }
  };
  app.get<{ Params: { key: string } }>(
    "/api/v1/integrations/:key/operations",
    {
      preHandler,
      schema: {
        ...schema,
        description:
          "Read durable operational evidence for Connections the caller may manage. No provider requests.",
        response: { ...responses, 200: IntegrationOperationsSchema },
      },
    },
    (request, reply) =>
      run(reply, async () => service.read(request.params.key, await actor(request)))
  );
  app.put<{ Params: { key: string; connectionId: string }; Body: SaveKnowledgeSubscription }>(
    "/api/v1/integrations/:key/connections/:connectionId/knowledge-subscription",
    {
      preHandler,
      schema: {
        ...schema,
        description:
          "Create, replace selected scopes, or disable a durable Knowledge subscription. Existing source ACLs are not changed.",
        body: SaveKnowledgeSubscriptionSchema,
        response: { ...responses, 200: KnowledgeSubscriptionSchema },
      },
    },
    (request, reply) =>
      run(reply, async () =>
        service.save(
          request.params.key,
          request.params.connectionId,
          await actor(request),
          request.body
        )
      )
  );
}
