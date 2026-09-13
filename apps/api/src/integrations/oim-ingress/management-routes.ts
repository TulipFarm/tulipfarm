import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import type { AuthorizationCheck, RequireAuthorization } from "../../authz/route-gate";
import { OimConnectionRequestError } from "../connections/service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface OimWebhookRegistrationView {
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly state: string;
  readonly desiredState: "active" | "removed";
  readonly callbackUrl: string;
  readonly lastError: string | null;
}

export interface OimWebhookManagementActor {
  readonly principalId: string;
  readonly mayManageShared: boolean;
}

export interface OimWebhookManagementService {
  register(
    integrationKey: string,
    connectionId: string,
    actor: OimWebhookManagementActor
  ): Promise<OimWebhookRegistrationView>;
  remove(
    integrationKey: string,
    connectionId: string,
    actor: OimWebhookManagementActor
  ): Promise<OimWebhookRegistrationView | null>;
  reconcile(
    integrationKey: string,
    connectionId: string,
    actor: OimWebhookManagementActor
  ): Promise<OimWebhookRegistrationView>;
}

export class OimWebhookManagementRequestError extends Error {
  constructor(
    readonly statusCode: 403 | 404 | 409 | 502,
    readonly code: string
  ) {
    super(code);
    this.name = "OimWebhookManagementRequestError";
  }
}

export interface OimWebhookManagementRoutesDeps {
  readonly service: OimWebhookManagementService;
  readonly requireAuth: PreHandler;
  readonly requireAuthorization: RequireAuthorization;
  readonly authorizationCheck: AuthorizationCheck;
}

const ParamsSchema = {
  type: "object",
  required: ["key", "connectionId"],
  properties: {
    key: { type: "string", minLength: 1, maxLength: 128 },
    connectionId: { type: "string", minLength: 1, maxLength: 256 },
  },
};

const RegistrationSchema = {
  type: "object",
  required: [
    "connectionId",
    "integrationId",
    "integrationMajorVersion",
    "state",
    "desiredState",
    "callbackUrl",
    "lastError",
  ],
  properties: {
    connectionId: { type: "string" },
    integrationId: { type: "string" },
    integrationMajorVersion: { type: "integer" },
    state: { type: "string" },
    desiredState: { type: "string", enum: ["active", "removed"] },
    callbackUrl: { type: "string" },
    lastError: { type: ["string", "null"] },
  },
};

async function actorFor(
  request: FastifyRequest,
  authorizationCheck: AuthorizationCheck
): Promise<OimWebhookManagementActor> {
  const principal = request.principal;
  if (principal?.kind !== "user") throw new OimWebhookManagementRequestError(403, "forbidden");
  const mayManageShared = await authorizationCheck(principal, {
    action: "integration_connection.manage_shared",
    resourceType: "integration_connection",
    conditions: { scope: "shared" },
    fallback: "admin",
  });
  return { principalId: principal.id, mayManageShared };
}

export function registerOimWebhookManagementRoutes(
  app: FastifyInstance,
  deps: OimWebhookManagementRoutesDeps
): void {
  const protectedRoute = {
    preHandler: [
      deps.requireAuth,
      deps.requireAuthorization({
        action: "integration_connection.manage",
        resourceType: "integration_connection",
        fallback: "authenticated",
      }),
    ],
  };
  const responses = {
    200: RegistrationSchema,
    401: ErrorSchema,
    403: ErrorSchema,
    404: ErrorSchema,
    409: ErrorSchema,
    502: ErrorSchema,
  };
  const schema: FastifySchema = {
    description: "Manage the provider webhook registration for an exact Connection.",
    tags: ["integrations"],
    security: [{ sessionCookie: [] }, { bearerToken: [] }],
    params: ParamsSchema,
    response: responses,
  };
  const params = (request: FastifyRequest) =>
    request.params as { key: string; connectionId: string };
  const run = async (
    reply: FastifyReply,
    operation: () => Promise<OimWebhookRegistrationView | null>
  ) => {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof OimWebhookManagementRequestError ||
        error instanceof OimConnectionRequestError
      ) {
        return reply.code(error.statusCode).send({ error: error.code });
      }
      throw error;
    }
  };

  app.post(
    "/api/v1/integrations/:key/connections/:connectionId/webhook-registration",
    { ...protectedRoute, schema },
    async (request, reply) => {
      const { key, connectionId } = params(request);
      return run(reply, async () =>
        deps.service.register(key, connectionId, await actorFor(request, deps.authorizationCheck))
      );
    }
  );
  app.post(
    "/api/v1/integrations/:key/connections/:connectionId/webhook-registration/reconcile",
    { ...protectedRoute, schema },
    async (request, reply) => {
      const { key, connectionId } = params(request);
      return run(reply, async () =>
        deps.service.reconcile(key, connectionId, await actorFor(request, deps.authorizationCheck))
      );
    }
  );
  app.delete(
    "/api/v1/integrations/:key/connections/:connectionId/webhook-registration",
    {
      ...protectedRoute,
      schema: {
        ...schema,
        response: {
          ...responses,
          200: {
            oneOf: [RegistrationSchema, { type: "null" }],
          },
        },
      },
    },
    async (request, reply) => {
      const { key, connectionId } = params(request);
      return run(reply, async () =>
        deps.service.remove(key, connectionId, await actorFor(request, deps.authorizationCheck))
      );
    }
  );
}
