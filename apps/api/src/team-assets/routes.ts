import { TEAM_ASSET_ACCESS_LEVELS } from "@tulipfarm/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import {
  isDeploymentAdmin,
  type RequireAuthorization,
  type RouteAuthorization,
} from "../authz/route-gate";
import { AssetOwnershipError, type TeamAssetService } from "./service";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const ASSET_TYPES = ["agent", "skill", "routine", "file", "knowledge"] as const;
const ASSET_SOURCES = ["owned", "inherited", "shared"] as const;
const ASSET_LIFECYCLE_STATUSES = ["active", "archived", "pending"] as const;
const security = [{ sessionCookie: [] }, { bearerToken: [] }] as const;
const paramsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assetType", "assetId"],
  properties: {
    assetType: { type: "string", enum: ASSET_TYPES },
    assetId: { type: "string", minLength: 1 },
  },
} as const;
const ownershipSchema = {
  type: "object",
  required: ["businessId", "assetType", "assetId", "owners", "shares", "revision"],
  properties: {
    businessId: { type: "string" },
    assetType: { type: "string", enum: ASSET_TYPES },
    assetId: { type: "string" },
    owners: {
      type: "array",
      minItems: 1,
      items: {
        oneOf: [
          {
            type: "object",
            required: ["kind", "teamId"],
            properties: {
              kind: { type: "string", const: "team" },
              teamId: { type: "string", format: "uuid" },
            },
          },
          {
            type: "object",
            required: ["kind", "principalId", "principalKind"],
            properties: {
              kind: { type: "string", const: "principal" },
              principalId: { type: "string" },
              principalKind: { type: "string", const: "user" },
            },
          },
        ],
      },
    },
    shares: {
      type: "array",
      items: {
        type: "object",
        required: ["teamId", "access"],
        properties: {
          teamId: { type: "string", format: "uuid" },
          access: { type: "string", enum: TEAM_ASSET_ACCESS_LEVELS },
        },
      },
    },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

function principal(request: FastifyRequest) {
  if (!request.principal) throw new AssetOwnershipError("forbidden", "Authentication required");
  return { ...request.principal, companyAdmin: isDeploymentAdmin(request.principal) };
}

function params(request: FastifyRequest) {
  return request.params as {
    assetType: (typeof ASSET_TYPES)[number];
    assetId: string;
    operationId?: string;
  };
}

function teamAssetAuthorization(action: string, recordId?: string): RouteAuthorization {
  return {
    action,
    resourceType: "team_asset",
    fallback: "authenticated",
    ...(recordId === undefined ? {} : { recordId }),
  };
}

function status(error: unknown): 400 | 403 | 404 | 409 {
  if (!(error instanceof AssetOwnershipError)) return 400;
  if (error.reason === "forbidden") return 403;
  if (error.reason === "not_found") return 404;
  if (
    error.reason === "conflict" ||
    error.reason === "stale" ||
    error.reason === "pending_approval" ||
    error.reason === "already_completed"
  ) {
    return 409;
  }
  return 400;
}

async function send<T>(reply: FastifyReply, work: () => Promise<T>): Promise<FastifyReply> {
  try {
    return reply.send(await work());
  } catch (error) {
    return reply
      .status(status(error))
      .send({ error: error instanceof Error ? error.message : String(error) });
  }
}

export function registerTeamAssetRoutes(
  app: FastifyInstance,
  service: TeamAssetService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const staticGate = (action: string): PreHandler[] => [
    requireAuth,
    requireAuthorization(teamAssetAuthorization(action)),
  ];
  const assetGate = (action: string): PreHandler[] => [
    requireAuth,
    async (request, reply) => {
      const { assetType, assetId } = params(request);
      await requireAuthorization(teamAssetAuthorization(action, `${assetType}:${assetId}`))(
        request,
        reply
      );
    },
  ];
  const teamCatalogGate: PreHandler[] = [
    requireAuth,
    async (request, reply) => {
      const { teamId } = request.params as { teamId: string };
      await requireAuthorization(teamAssetAuthorization("team_asset.catalog.read", teamId))(
        request,
        reply
      );
    },
  ];

  app.get(
    "/api/v1/teams/:teamId/assets",
    {
      preHandler: teamCatalogGate,
      schema: {
        description:
          "List one Team's owned, inherited, and shared assets with server-computed access.",
        tags: ["teams", "team-assets"],
        security,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["teamId"],
          properties: { teamId: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ASSET_TYPES },
            source: { type: "string", enum: ASSET_SOURCES },
            access: { type: "string", enum: TEAM_ASSET_ACCESS_LEVELS },
            ownerTeamId: { type: "string", format: "uuid" },
            lifecycleStatus: { type: "string", enum: ASSET_LIFECYCLE_STATUSES },
            cursor: { type: "string", minLength: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["items", "nextCursor"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: [
                    "id",
                    "type",
                    "label",
                    "description",
                    "href",
                    "lifecycleStatus",
                    "source",
                    "sourceTeamIds",
                    "effectiveLevels",
                    "canManageOwnership",
                    "ownership",
                    "pendingApprovals",
                  ],
                  properties: {
                    id: { type: "string" },
                    type: { type: "string", enum: ASSET_TYPES },
                    label: { type: "string" },
                    description: { type: ["string", "null"] },
                    href: { type: ["string", "null"] },
                    lifecycleStatus: { type: "string", enum: ASSET_LIFECYCLE_STATUSES },
                    source: { type: "string", enum: ASSET_SOURCES },
                    sourceTeamIds: { type: "array", items: { type: "string", format: "uuid" } },
                    effectiveLevels: {
                      type: "array",
                      items: { type: "string", enum: TEAM_ASSET_ACCESS_LEVELS },
                    },
                    canManageOwnership: { type: "boolean" },
                    ownership: {
                      anyOf: [
                        {
                          type: "object",
                          required: ["revision", "owners", "shares"],
                          properties: {
                            revision: { type: "integer", minimum: 1 },
                            owners: ownershipSchema.properties.owners,
                            shares: ownershipSchema.properties.shares,
                          },
                        },
                        { type: "null" },
                      ],
                    },
                    pendingApprovals: {
                      type: "array",
                      items: {
                        type: "object",
                        required: [
                          "approvalId",
                          "operationId",
                          "action",
                          "risk",
                          "preview",
                          "riskSummary",
                          "status",
                          "requiredTeamIds",
                          "decisions",
                          "requiredDecisions",
                          "readyToComplete",
                          "representedTeamId",
                          "canDecide",
                          "expiresAt",
                          "createdAt",
                        ],
                        properties: {
                          approvalId: { type: "string", format: "uuid" },
                          operationId: { type: "string", format: "uuid" },
                          action: {
                            type: "string",
                            enum: ["add_owner", "remove_owner", "move", "archive", "delete"],
                          },
                          risk: { type: "string", enum: ["low", "medium", "high"] },
                          preview: { type: "string" },
                          riskSummary: { type: "string" },
                          status: { type: "string", enum: ["pending", "denied"] },
                          requiredTeamIds: {
                            type: "array",
                            items: { type: "string", format: "uuid" },
                          },
                          decisions: { type: "integer", minimum: 0 },
                          requiredDecisions: { type: "integer", minimum: 0 },
                          readyToComplete: { type: "boolean" },
                          representedTeamId: { type: ["string", "null"], format: "uuid" },
                          canDecide: { type: "boolean" },
                          expiresAt: { type: "string", format: "date-time" },
                          createdAt: { type: "string", format: "date-time" },
                        },
                      },
                    },
                  },
                },
              },
              nextCursor: { type: ["string", "null"] },
            },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    (request, reply) => {
      const { teamId } = request.params as { teamId: string };
      const query = request.query as {
        type?: (typeof ASSET_TYPES)[number];
        source?: (typeof ASSET_SOURCES)[number];
        access?: (typeof TEAM_ASSET_ACCESS_LEVELS)[number];
        ownerTeamId?: string;
        lifecycleStatus?: (typeof ASSET_LIFECYCLE_STATUSES)[number];
        cursor?: string;
        limit?: number;
      };
      return send(reply, () =>
        service.listCatalog(
          {
            teamId,
            limit: query.limit ?? 25,
            ...(query.type === undefined ? {} : { assetType: query.type }),
            ...(query.source === undefined ? {} : { source: query.source }),
            ...(query.access === undefined ? {} : { access: query.access }),
            ...(query.ownerTeamId === undefined ? {} : { ownerTeamId: query.ownerTeamId }),
            ...(query.lifecycleStatus === undefined
              ? {}
              : { lifecycleStatus: query.lifecycleStatus }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          },
          principal(request)
        )
      );
    }
  );

  app.get(
    "/api/v1/team-assets/approvals",
    {
      preHandler: staticGate("team_asset.approval.read"),
      schema: {
        description:
          "List ownership Approvals visible to the caller, optionally scoped to one exact Team.",
        tags: ["team-assets"],
        security,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            teamId: { type: "string", format: "uuid" },
            assetType: { type: "string", enum: ASSET_TYPES },
            assetId: { type: "string", minLength: 1 },
            cursor: { type: "string", minLength: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["items", "nextCursor"],
            properties: {
              items: { type: "array", items: { type: "object", additionalProperties: true } },
              nextCursor: { type: ["string", "null"] },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    (request, reply) => {
      const { teamId, assetType, assetId, cursor, limit } = request.query as {
        teamId?: string;
        assetType?: (typeof ASSET_TYPES)[number];
        assetId?: string;
        cursor?: string;
        limit?: number;
      };
      return send(reply, () =>
        service.listApprovalsPage(principal(request), {
          ...(teamId ? { teamId } : {}),
          ...(assetType ? { assetType } : {}),
          ...(assetId ? { assetId } : {}),
          ...(cursor ? { cursor } : {}),
          limit: limit ?? 25,
        })
      );
    }
  );

  app.get(
    "/api/v1/team-assets/:assetType/:assetId/access",
    {
      preHandler: assetGate("team_asset.access.read"),
      schema: {
        description: "Explain the signed-in principal's Team-derived access to a shared asset.",
        tags: ["team-assets"],
        security,
        params: paramsSchema,
        response: {
          200: {
            type: "object",
            required: ["ownership", "access"],
            properties: {
              ownership: ownershipSchema,
              access: {
                type: "object",
                required: ["levels", "canManageOwnership", "evidence"],
                properties: {
                  levels: {
                    type: "array",
                    items: { type: "string", enum: TEAM_ASSET_ACCESS_LEVELS },
                  },
                  canManageOwnership: { type: "boolean" },
                  evidence: {
                    type: "array",
                    items: { type: "object", additionalProperties: true },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    (request, reply) => {
      const { assetType, assetId } = params(request);
      return send(reply, () => service.projection(assetType, assetId, principal(request)));
    }
  );

  app.get(
    "/api/v1/team-assets/:assetType/:assetId/approvals",
    {
      preHandler: assetGate("team_asset.approval.read"),
      schema: {
        description: "List pending ownership Approvals for one affected asset.",
        tags: ["team-assets"],
        security,
        params: paramsSchema,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            cursor: { type: "string", minLength: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["items", "nextCursor"],
            properties: {
              items: { type: "array", items: { type: "object", additionalProperties: true } },
              nextCursor: { type: ["string", "null"] },
            },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    (request, reply) => {
      const { assetType, assetId } = params(request);
      const query = request.query as { cursor?: string; limit?: number };
      return send(reply, () =>
        service.listApprovalsPage(principal(request), {
          assetType,
          assetId,
          ...(query.cursor ? { cursor: query.cursor } : {}),
          limit: query.limit ?? 25,
        })
      );
    }
  );

  app.put(
    "/api/v1/team-assets/:assetType/:assetId/shares",
    {
      preHandler: assetGate("team_asset.share.manage"),
      schema: {
        description: "Replace Team shares for an Agent, Skill, Routine, File, or Knowledge item.",
        tags: ["team-assets"],
        security,
        params: paramsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["shares", "revision"],
          properties: {
            shares: ownershipSchema.properties.shares,
            revision: { type: "integer", minimum: 1 },
          },
        },
        response: {
          200: ownershipSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    (request, reply) => {
      const { assetType, assetId } = params(request);
      const body = request.body as {
        shares: { teamId: string; access: (typeof TEAM_ASSET_ACCESS_LEVELS)[number] }[];
        revision: number;
      };
      return send(reply, () =>
        service.updateShares(assetType, assetId, body.shares, body.revision, principal(request))
      );
    }
  );

  app.post(
    "/api/v1/team-assets/:assetType/:assetId/operations",
    {
      preHandler: assetGate("team_asset.operation.propose"),
      schema: {
        description:
          "Propose an owner change, move, archive, or deletion through unanimous Team Approval.",
        tags: ["team-assets"],
        security,
        params: paramsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["action", "revision", "expiresAt"],
          properties: {
            action: {
              type: "string",
              enum: ["add_owner", "remove_owner", "move", "archive", "delete"],
            },
            teamId: { type: "string", format: "uuid" },
            revision: { type: "integer", minimum: 1 },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
        response: {
          200: { type: "object", additionalProperties: true },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    (request, reply) => {
      const { assetType, assetId } = params(request);
      const body = request.body as {
        action: "add_owner" | "remove_owner" | "move" | "archive" | "delete";
        teamId?: string;
        revision: number;
        expiresAt: string;
      };
      return send(reply, () =>
        service.propose(
          {
            assetType,
            assetId,
            action: body.action,
            ...(body.teamId === undefined ? {} : { teamId: body.teamId }),
            expectedRevision: body.revision,
            expiresAt: new Date(body.expiresAt),
          },
          principal(request)
        )
      );
    }
  );

  app.post(
    "/api/v1/team-assets/:assetType/:assetId/operations/:operationId/decisions",
    {
      preHandler: assetGate("team_asset.operation.decide"),
      schema: {
        description: "Approve or deny an asset ownership operation for one exact owning Team.",
        tags: ["team-assets"],
        security,
        params: {
          ...paramsSchema,
          required: [...paramsSchema.required, "operationId"],
          properties: {
            ...paramsSchema.properties,
            operationId: { type: "string", format: "uuid" },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["teamId", "outcome"],
          properties: {
            teamId: { type: "string", format: "uuid" },
            outcome: { type: "string", enum: ["approved", "denied"] },
          },
        },
        response: {
          200: { type: "object", additionalProperties: true },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    (request, reply) => {
      const { operationId } = params(request);
      const body = request.body as { teamId: string; outcome: "approved" | "denied" };
      return send(reply, () =>
        service.decide(operationId as string, body.teamId, body.outcome, principal(request))
      );
    }
  );

  app.post(
    "/api/v1/team-assets/:assetType/:assetId/operations/:operationId/complete",
    {
      preHandler: assetGate("team_asset.operation.complete"),
      schema: {
        description: "Consume a fully approved asset ownership operation.",
        tags: ["team-assets"],
        security,
        params: {
          ...paramsSchema,
          required: [...paramsSchema.required, "operationId"],
          properties: {
            ...paramsSchema.properties,
            operationId: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: ownershipSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    (request, reply) => {
      const { assetType, assetId, operationId } = params(request);
      return send(reply, () =>
        service.complete(assetType, assetId, operationId as string, principal(request))
      );
    }
  );

  app.post(
    "/api/v1/team-assets/:assetType/:assetId/operations/:operationId/emergency-override",
    {
      preHandler: assetGate("team_asset.operation.emergency_override"),
      schema: {
        description:
          "Company-admin emergency authorization for one exact pending ownership or lifecycle operation.",
        tags: ["team-assets"],
        security,
        params: {
          ...paramsSchema,
          required: [...paramsSchema.required, "operationId"],
          properties: {
            ...paramsSchema.properties,
            operationId: { type: "string", format: "uuid" },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: { reason: { type: "string", minLength: 1 } },
        },
        response: {
          200: ownershipSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    (request, reply) => {
      const { assetType, assetId, operationId } = params(request);
      const { reason } = request.body as { reason: string };
      if (reason.trim().length === 0) {
        return reply.status(400).send({ error: "Emergency override requires a reason" });
      }
      return send(reply, () =>
        service.emergencyOverride(
          assetType,
          assetId,
          operationId as string,
          reason,
          principal(request)
        )
      );
    }
  );
}
