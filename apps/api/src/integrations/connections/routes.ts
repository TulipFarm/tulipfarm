import type { OimConnection } from "@tulipfarm/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../../auth/schemas";
import type { AuthorizationCheck, RequireAuthorization } from "../../authz/route-gate";
import { AuthBrokerError } from "../auth-broker";
import {
  type ConnectionActor,
  OimConnectionRequestError,
  type OimConnectionService,
} from "./service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface OimConnectionRoutesDeps {
  readonly service: OimConnectionService;
  readonly requireAuth: PreHandler;
  readonly requireAuthorization: RequireAuthorization;
  readonly authorizationCheck: AuthorizationCheck;
}

const ParamsSchema = {
  type: "object",
  required: ["key"],
  properties: {
    key: { type: "string", minLength: 1, maxLength: 128 },
    connectionId: { type: "string", minLength: 1, maxLength: 256 },
    stepId: { type: "string", minLength: 1, maxLength: 64 },
  },
};

const ConnectionSchema = {
  type: "object",
  required: [
    "id",
    "integration",
    "label",
    "owner",
    "status",
    "isDefault",
    "configuration",
    "availableCredentialSlots",
    "health",
    "expiresAt",
  ],
  properties: {
    id: { type: "string" },
    integration: {
      type: "object",
      required: ["id", "majorVersion"],
      properties: { id: { type: "string" }, majorVersion: { type: "integer" } },
    },
    label: { type: "string" },
    owner: { type: "object", additionalProperties: true },
    status: { type: "string", enum: ["active", "revoked"] },
    isDefault: { type: "boolean" },
    configuration: { type: "object", additionalProperties: true },
    availableCredentialSlots: { type: "array", items: { type: "string" } },
    health: { type: "object", additionalProperties: true },
    expiresAt: { type: ["string", "null"] },
  },
};

const StartActionSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["redirect", "form_post", "completed"] },
    url: { type: "string" },
    field: { type: "string" },
    value: { type: "string" },
  },
};

function safeConnection(connection: Awaited<ReturnType<OimConnectionService["get"]>>) {
  return {
    id: connection.id,
    integration: connection.integration,
    label: connection.label,
    owner: connection.owner,
    status: connection.status,
    isDefault: connection.isDefault,
    configuration: connection.configuration,
    availableCredentialSlots: Object.keys(connection.secretBindings).sort(),
    health: connection.health,
    expiresAt: connection.expiresAt,
  };
}

async function actorFor(
  req: FastifyRequest,
  authorizationCheck: AuthorizationCheck
): Promise<ConnectionActor> {
  const principal = req.principal;
  if (principal?.kind !== "user") throw new OimConnectionRequestError(403, "forbidden");
  const mayManageShared = await authorizationCheck(principal, {
    action: "integration_connection.manage_shared",
    resourceType: "integration_connection",
    conditions: { scope: "shared" },
    fallback: "admin",
  });
  return { principalId: principal.id, mayManageShared };
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof OimConnectionRequestError) {
    return reply.code(error.statusCode).send({ error: error.code });
  }
  if (error instanceof AuthBrokerError) {
    const status =
      error.reason === "exchange_failed" ? 502 : error.reason === "unknown_step" ? 404 : 409;
    return reply.code(status).send({ error: error.message });
  }
  throw error;
}

export function registerOimConnectionRoutes(
  app: FastifyInstance,
  deps: OimConnectionRoutesDeps
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
  const authorizationRoute = {
    preHandler: [
      deps.requireAuth,
      deps.requireAuthorization({
        action: "integration_connection.authorize",
        resourceType: "integration_connection",
        fallback: "authenticated",
      }),
    ],
  };

  app.get(
    "/api/v1/integrations/:key/connections",
    {
      ...protectedRoute,
      schema: {
        description: "List authorized Connections for one exact versioned Integration package.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ParamsSchema,
        response: {
          200: {
            type: "object",
            required: ["connections"],
            properties: { connections: { type: "array", items: ConnectionSchema } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { key } = req.params as { key: string };
        const rows = await deps.service.list(key, await actorFor(req, deps.authorizationCheck));
        return { connections: rows.map(safeConnection) };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get(
    "/api/v1/integrations/:key/connections/:connectionId",
    {
      ...protectedRoute,
      schema: {
        description: "Read one authorized Connection bound to an exact Integration major.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ParamsSchema,
        response: {
          200: ConnectionSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { key, connectionId } = req.params as { key: string; connectionId: string };
        return safeConnection(
          await deps.service.get(key, connectionId, await actorFor(req, deps.authorizationCheck))
        );
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/integrations/:key/connections",
    {
      ...protectedRoute,
      schema: {
        description: "Create a Connection for one exact versioned Integration package.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ParamsSchema,
        body: {
          type: "object",
          required: ["label", "ownerScope", "values"],
          additionalProperties: false,
          properties: {
            label: { type: "string", minLength: 1, maxLength: 128 },
            ownerScope: { type: "string", enum: ["personal", "team", "organization"] },
            ownerId: { type: "string", minLength: 1, maxLength: 256 },
            values: {
              type: "object",
              propertyNames: { pattern: "^[a-z][a-z0-9_]*$" },
              additionalProperties: { type: "string" },
            },
            isDefault: { type: "boolean" },
          },
        },
        response: {
          201: {
            type: "object",
            required: ["connectionId"],
            properties: { connectionId: { type: "string" } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { key } = req.params as { key: string };
        const body = req.body as {
          label: string;
          ownerScope: OwnerScope;
          ownerId?: string;
          values: Record<string, string>;
          isDefault?: boolean;
        };
        const actor = await actorFor(req, deps.authorizationCheck);
        const owner = ownerFrom(body.ownerScope, body.ownerId, actor.principalId);
        const result = await deps.service.create(key, actor, {
          label: body.label,
          owner,
          values: body.values,
          isDefault: body.isDefault,
        });
        return reply.code(201).send(result);
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/integrations/:key/connections/:connectionId/auth/:stepId",
    {
      ...authorizationRoute,
      schema: {
        description: "Start one browser authorization step for an exact Connection.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ParamsSchema,
        body: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: {
            org: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              description: "Optional provider organization selected by an app-manifest step.",
            },
          },
        },
        response: {
          200: StartActionSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          502: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { key, connectionId, stepId } = req.params as {
          key: string;
          connectionId: string;
          stepId: string;
        };
        const body = req.body as { org?: string } | undefined;
        return await deps.service.startAuthorization(
          key,
          connectionId,
          stepId,
          await actorFor(req, deps.authorizationCheck),
          body?.org?.trim() || undefined
        );
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/integrations/:key/connections/:connectionId/refresh",
    {
      ...protectedRoute,
      schema: {
        description: "Refresh every expiring OAuth step for an exact Connection.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ParamsSchema,
        response: {
          200: { type: "object", additionalProperties: true },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          502: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { key, connectionId } = req.params as { key: string; connectionId: string };
        return await deps.service.refresh(
          key,
          connectionId,
          await actorFor(req, deps.authorizationCheck)
        );
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.delete(
    "/api/v1/integrations/:key/connections/:connectionId",
    {
      ...protectedRoute,
      schema: {
        description:
          "Revoke a Connection and all credentials through its exact installed Integration package.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: ParamsSchema,
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: { status: { type: "string", enum: ["revoked"] } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { key, connectionId } = req.params as { key: string; connectionId: string };
        await deps.service.revoke(key, connectionId, await actorFor(req, deps.authorizationCheck));
        return { status: "revoked" };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.delete(
    "/api/v1/integration-connections/:connectionId",
    {
      ...protectedRoute,
      schema: {
        description:
          "Revoke a Connection and all credentials by durable id, even if its manifest is absent.",
        tags: ["integrations"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["connectionId"],
          properties: { connectionId: { type: "string", minLength: 1, maxLength: 256 } },
        },
        response: {
          200: {
            type: "object",
            required: ["status"],
            properties: { status: { type: "string", enum: ["revoked"] } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { connectionId } = req.params as { connectionId: string };
        await deps.service.revokeById(connectionId, await actorFor(req, deps.authorizationCheck));
        return { status: "revoked" };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );
}

type OwnerScope = OimConnection["owner"]["scope"];

function ownerFrom(scope: OwnerScope, ownerId: string | undefined, principalId: string) {
  if (scope === "personal") {
    if (ownerId !== undefined && ownerId !== principalId) {
      throw new OimConnectionRequestError(403, "forbidden");
    }
    return { scope, principalKind: "user", principalId } as const;
  }
  if (scope === "team") {
    if (ownerId === undefined) throw new OimConnectionRequestError(400, "owner_id_required");
    return { scope, teamId: ownerId } as const;
  }
  return { scope } as const;
}
