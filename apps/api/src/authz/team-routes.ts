import { GROUP_COMPATIBILITY_DEPRECATION } from "@tulipfarm/schema";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { makeRateLimitHook, type RateLimiter } from "../rate-limit";
import type { RequireAuthorization, RouteAuthorization } from "./route-gate";
import {
  AccessExplanationBodySchema,
  AdminRecoveryBodySchema,
  BulkMemberAddBodySchema,
  BulkMemberRemoveBodySchema,
  BulkResultSchema,
  CreatedGrantSchema,
  DelegationPolicyBodySchema,
  DelegationPolicySchema,
  DeprecatedMembershipSchema,
  DeprecatedOkSchema,
  LeaveDecisionBodySchema,
  LeaveRequestListSchema,
  LeaveRequestSchema,
  LegacyGroupCreateBodySchema,
  LegacyGroupListSchema,
  LegacyGroupMemberBodySchema,
  LegacyGroupMemberParamsSchema,
  LegacyGroupParamsSchema,
  LegacyGroupResponseSchema,
  LegacyGroupRoleParamsSchema,
  MoveConfirmBodySchema,
  MovePreviewBodySchema,
  MovePreviewSchema,
  RevisionBodySchema,
  TEAM_SECURITY,
  TeamAccessExplanationSchema,
  TeamActivityQuerySchema,
  TeamActivitySchema,
  TeamAuthoritySchema,
  TeamCreateRequestSchema,
  TeamGrantBodySchema,
  TeamGrantParamsSchema,
  TeamHierarchyResponseSchema,
  TeamIdParamsSchema,
  TeamLeaveParamsSchema,
  TeamListSchema,
  TeamMemberBodySchema,
  TeamMemberParamsSchema,
  TeamMembershipSchema,
  TeamMembersSchema,
  TeamMemberUpdateBodySchema,
  TeamRoleBodySchema,
  TeamRoleParamsSchema,
  TeamSchema,
  TeamUpdateRequestSchema,
} from "./team-schemas";
import {
  type TeamApiService,
  TeamAuthorityAssignmentError,
  TeamServiceError,
} from "./team-service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
const WRITE_LIMIT = 60;
const WRITE_WINDOW_MS = 60_000;
const OK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", const: "ok" } },
} as const;

function teamAuthorization(
  action: string,
  fallback: RouteAuthorization["fallback"],
  recordId?: string
): RouteAuthorization {
  return {
    action,
    resourceType: "team",
    fallback,
    ...(recordId === undefined ? {} : { recordId }),
  };
}

function params(req: FastifyRequest): { teamId: string } {
  return req.params as { teamId: string };
}

function actor(req: FastifyRequest, service: TeamApiService) {
  if (!req.principal) throw new TeamServiceError("forbidden", "Authentication required");
  return service.actor(req.principal);
}

function status(error: unknown): 400 | 403 | 404 | 409 {
  if (error instanceof TeamServiceError) {
    if (error.reason === "forbidden") return 403;
    if (error.reason === "not_found") return 404;
    if (
      error.reason === "conflict" ||
      error.reason === "final_admin" ||
      error.reason === "not_empty"
    ) {
      return 409;
    }
    return 400;
  }
  if (error instanceof TeamAuthorityAssignmentError) {
    if (error.reason === "not_found") return 404;
    if (error.reason === "not_delegated") return 403;
    return 400;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /unique|conflict|final Team admin/i.test(message) ? 409 : 400;
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  return reply.code(status(error)).send({
    error: error instanceof Error ? error.message : String(error),
  });
}

async function send<T>(reply: FastifyReply, work: () => Promise<T>): Promise<FastifyReply> {
  try {
    return reply.send(await work());
  } catch (error) {
    return sendError(reply, error);
  }
}

export function registerTeamRoutes(
  app: FastifyInstance,
  service: TeamApiService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  rateLimiter?: RateLimiter
): void {
  const rateLimit = rateLimiter
    ? makeRateLimitHook(rateLimiter, (req) => `rl:teams:${req.ip}`, WRITE_LIMIT, WRITE_WINDOW_MS)
    : undefined;
  const staticGate = (authorization: RouteAuthorization, write = false): PreHandler[] => [
    ...(write && rateLimit ? [rateLimit] : []),
    requireAuth,
    requireAuthorization(authorization),
  ];
  const teamGate = (action: string, fallback: RouteAuthorization["fallback"], write = false) => [
    ...(write && rateLimit ? [rateLimit] : []),
    requireAuth,
    async (req: FastifyRequest, reply: FastifyReply) => {
      await requireAuthorization(teamAuthorization(action, fallback, params(req).teamId))(
        req,
        reply
      );
    },
  ];
  const commonErrors = {
    400: ErrorSchema,
    401: ErrorSchema,
    403: ErrorSchema,
    404: ErrorSchema,
    409: ErrorSchema,
    429: ErrorSchema,
  };

  app.get(
    "/api/v1/team-notifications",
    {
      preHandler: requireAuth,
      schema: {
        description:
          "List recipient-scoped Team notifications without exposing Team identity details.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["items"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "kind", "title", "createdAt"],
                  properties: {
                    id: { type: "string", format: "uuid" },
                    kind: {
                      type: "string",
                      enum: [
                        "membership_added",
                        "membership_removed",
                        "admin_promoted",
                        "admin_demoted",
                        "expiry_warning",
                        "membership_expired",
                        "hierarchy_access_changed",
                      ],
                    },
                    title: { type: "string" },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          401: ErrorSchema,
        },
      },
    },
    (req, reply) => {
      if (!req.principal) return reply.code(401).send({ error: "Authentication required" });
      return service.notifications(req.principal.id);
    }
  );

  app.get(
    "/api/v1/teams",
    {
      preHandler: staticGate(teamAuthorization("team.directory.read", "authenticated")),
      schema: {
        description: "List the Team directory.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        response: { 200: TeamListSchema, 401: ErrorSchema, 403: ErrorSchema, 429: ErrorSchema },
      },
    },
    () => service.list()
  );

  app.get(
    "/api/v1/teams/hierarchy",
    {
      preHandler: staticGate(teamAuthorization("team.directory.read", "authenticated")),
      schema: {
        description: "List the Team hierarchy with parent and ancestor evidence.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        response: {
          200: TeamHierarchyResponseSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    () => service.hierarchy()
  );

  app.post(
    "/api/v1/teams",
    {
      preHandler: staticGate(teamAuthorization("team.create", "admin"), true),
      schema: {
        description: "Create a Team below an existing parent with at least one human admin.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        body: TeamCreateRequestSchema,
        response: { 201: TeamSchema, ...commonErrors },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        slug: string;
        displayName: string;
        description?: string;
        labels?: string[];
        parentTeamId: string;
        initialAdminUserIds: string[];
      };
      try {
        return reply.code(201).send(await service.create(body, await actor(req, service)));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get(
    "/api/v1/teams/:teamId",
    {
      preHandler: teamGate("team.read", "authenticated"),
      schema: {
        description: "Get Team identity and lifecycle details.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        response: { 200: TeamSchema, ...commonErrors },
      },
    },
    (req, reply) => send(reply, () => service.get(params(req).teamId))
  );

  app.patch(
    "/api/v1/teams/:teamId",
    {
      preHandler: teamGate("team.write", "admin", true),
      schema: {
        description: "Update the editable name, description, or labels of an exact Team.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: TeamUpdateRequestSchema,
        response: { 200: TeamSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () =>
        service.update(
          params(req).teamId,
          req.body as {
            displayName?: string;
            description?: string | null;
            labels?: string[];
            revision: number;
          },
          await actor(req, service)
        )
      )
  );

  app.get(
    "/api/v1/teams/:teamId/members",
    {
      preHandler: teamGate("team.member.read", "admin"),
      schema: {
        description: "List direct and inherited Team members separately with source paths.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        response: { 200: TeamMembersSchema, ...commonErrors },
      },
    },
    (req, reply) => send(reply, () => service.members(params(req).teamId))
  );

  app.post(
    "/api/v1/teams/:teamId/members",
    {
      preHandler: teamGate("team.member.manage", "admin", true),
      schema: {
        description: "Add one direct Team member with level and optional expiry.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: TeamMemberBodySchema,
        response: { 201: TeamMembershipSchema, ...commonErrors },
      },
    },
    async (req, reply) => {
      try {
        return reply.code(201).send(
          await service.addMember(
            params(req).teamId,
            req.body as {
              principalId: string;
              level: "member" | "admin";
              expiresAt?: string;
            },
            await actor(req, service)
          )
        );
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/teams/:teamId/members/bulk",
    {
      preHandler: teamGate("team.member.manage", "admin", true),
      schema: {
        description: "Add up to 100 direct Team members with per-item results.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: BulkMemberAddBodySchema,
        response: { 200: BulkResultSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () =>
        service.bulkAddMembers(
          params(req).teamId,
          (
            req.body as {
              members: {
                principalId: string;
                level: "member" | "admin";
                expiresAt?: string;
              }[];
            }
          ).members,
          await actor(req, service)
        )
      )
  );

  app.patch(
    "/api/v1/teams/:teamId/members/:principalId",
    {
      preHandler: teamGate("team.member.manage", "admin", true),
      schema: {
        description: "Change a direct member level or expiry using its revision.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamMemberParamsSchema,
        body: TeamMemberUpdateBodySchema,
        response: { 200: TeamMembershipSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        const route = req.params as { teamId: string; principalId: string };
        return service.updateMember(
          route.teamId,
          route.principalId,
          req.body as { level: "member" | "admin"; expiresAt?: string | null; revision: number },
          await actor(req, service)
        );
      })
  );

  app.delete(
    "/api/v1/teams/:teamId/members/:principalId",
    {
      preHandler: teamGate("team.member.manage", "admin", true),
      schema: {
        description: "Remove a direct Team member using its revision.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamMemberParamsSchema,
        body: RevisionBodySchema,
        response: { 200: OK_SCHEMA, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        const route = req.params as { teamId: string; principalId: string };
        await service.removeMember(
          route.teamId,
          route.principalId,
          (req.body as { revision: number }).revision,
          await actor(req, service)
        );
        return { status: "ok" };
      })
  );

  app.post(
    "/api/v1/teams/:teamId/members/bulk-remove",
    {
      preHandler: teamGate("team.member.manage", "admin", true),
      schema: {
        description: "Remove up to 100 direct Team members with per-item results.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: BulkMemberRemoveBodySchema,
        response: { 200: BulkResultSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () =>
        service.bulkRemoveMembers(
          params(req).teamId,
          (req.body as { members: { principalId: string; revision: number }[] }).members,
          await actor(req, service)
        )
      )
  );

  app.post(
    "/api/v1/teams/:teamId/leave-requests",
    {
      preHandler: teamGate("team.leave.request", "authenticated", true),
      schema: {
        description: "Request removal of the caller's direct Team membership.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        response: { 201: LeaveRequestSchema, ...commonErrors },
      },
    },
    async (req, reply) => {
      try {
        return reply
          .code(201)
          .send(await service.requestLeave(params(req).teamId, await actor(req, service)));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get(
    "/api/v1/teams/:teamId/leave-requests",
    {
      preHandler: teamGate("team.leave.decide", "admin"),
      schema: {
        description: "List Team leave requests for decision.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        response: { 200: LeaveRequestListSchema, ...commonErrors },
      },
    },
    (req, reply) => send(reply, () => service.leaveRequests(params(req).teamId))
  );

  app.post(
    "/api/v1/teams/:teamId/leave-requests/:requestId/decision",
    {
      preHandler: teamGate("team.leave.decide", "admin", true),
      schema: {
        description: "Approve or reject a pending Team leave request.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamLeaveParamsSchema,
        body: LeaveDecisionBodySchema,
        response: { 200: LeaveRequestSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        const route = req.params as { teamId: string; requestId: string };
        return service.decideLeave(
          route.teamId,
          route.requestId,
          req.body as { decision: "approved" | "rejected"; revision: number },
          await actor(req, service)
        );
      })
  );

  app.get(
    "/api/v1/teams/:teamId/authority",
    {
      preHandler: teamGate("team.authority.read", "admin"),
      schema: {
        description: "List direct and inherited Team Roles and grants with source evidence.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        response: { 200: TeamAuthoritySchema, ...commonErrors },
      },
    },
    (req, reply) => send(reply, () => service.authorityView(params(req).teamId))
  );

  app.post(
    "/api/v1/teams/:teamId/roles",
    {
      preHandler: teamGate("team.role.manage", "admin", true),
      schema: {
        description: "Assign a Team-compatible Role within the Team delegation policy.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: TeamRoleBodySchema,
        response: { 200: OK_SCHEMA, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        await service.assignRole(
          params(req).teamId,
          req.body as { roleId: string; expiresAt?: string },
          await actor(req, service)
        );
        return { status: "ok" };
      })
  );

  app.delete(
    "/api/v1/teams/:teamId/roles/:roleId",
    {
      preHandler: teamGate("team.role.manage", "admin", true),
      schema: {
        description: "Revoke a direct Team Role within the Team delegation policy.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamRoleParamsSchema,
        response: { 200: OK_SCHEMA, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        const route = req.params as { teamId: string; roleId: string };
        await service.revokeRole(route.teamId, route.roleId, await actor(req, service));
        return { status: "ok" };
      })
  );

  app.post(
    "/api/v1/teams/:teamId/grants",
    {
      preHandler: teamGate("team.grant.manage", "admin", true),
      schema: {
        description: "Create one direct Team grant within the Team delegation policy.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: TeamGrantBodySchema,
        response: { 201: CreatedGrantSchema, ...commonErrors },
      },
    },
    async (req, reply) => {
      try {
        return reply.code(201).send(
          await service.addGrant(
            params(req).teamId,
            req.body as {
              action: string;
              resourceType: string;
              effect: "allow" | "deny";
              expiresAt?: string;
            },
            await actor(req, service)
          )
        );
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.delete(
    "/api/v1/teams/:teamId/grants/:grantId",
    {
      preHandler: teamGate("team.grant.manage", "admin", true),
      schema: {
        description: "Delete one direct Team grant within the Team delegation policy.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamGrantParamsSchema,
        response: { 200: OK_SCHEMA, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        const route = req.params as { teamId: string; grantId: string };
        await service.deleteGrant(route.teamId, route.grantId, await actor(req, service));
        return { status: "ok" };
      })
  );

  app.get(
    "/api/v1/teams/:teamId/delegation-policy",
    {
      preHandler: teamGate("team.authority.read", "admin"),
      schema: {
        description: "Get the exact Team delegation policy.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        response: { 200: DelegationPolicySchema, ...commonErrors },
      },
    },
    (req, reply) => send(reply, () => service.delegationPolicy(params(req).teamId))
  );

  app.put(
    "/api/v1/teams/:teamId/delegation-policy",
    {
      preHandler: teamGate("team.delegation.manage", "admin", true),
      schema: {
        description: "Replace a Team delegation policy using optimistic revision control.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: DelegationPolicyBodySchema,
        response: { 200: DelegationPolicySchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () =>
        service.putDelegationPolicy(
          params(req).teamId,
          req.body as {
            allowedRoleIds: string[];
            allowedGrantScopes: { actions: string[]; resourceTypes: string[] }[];
            revision: number;
          },
          await actor(req, service)
        )
      )
  );

  app.post(
    "/api/v1/teams/:teamId/move-preview",
    {
      preHandler: teamGate("team.hierarchy.manage", "admin", true),
      schema: {
        description:
          "Preview a Team move without mutation, including affected identities, authority, assets, and likely access changes.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: MovePreviewBodySchema,
        response: { 200: MovePreviewSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, () => {
        const body = req.body as { parentTeamId: string; revision: number };
        return service.previewMove(params(req).teamId, body.parentTeamId, body.revision);
      })
  );

  app.post(
    "/api/v1/teams/:teamId/move",
    {
      preHandler: teamGate("team.hierarchy.manage", "admin", true),
      schema: {
        description:
          "Confirm a previewed Team move with its one-use token; stale or expired previews are rejected.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: MoveConfirmBodySchema,
        response: { 200: TeamSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () =>
        service.move(
          params(req).teamId,
          req.body as { parentTeamId: string; previewToken: string },
          await actor(req, service)
        )
      )
  );

  app.post(
    "/api/v1/teams/:teamId/admin-recovery",
    {
      preHandler: teamGate("team.emergency_override", "admin", true),
      schema: {
        description:
          "Recover an active Team with no active human admins by assigning one active person as its exact-Team admin.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: AdminRecoveryBodySchema,
        response: { 200: TeamMembershipSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () =>
        service.recoverAdmin(
          params(req).teamId,
          req.body as { principalId: string; revision: number },
          await actor(req, service)
        )
      )
  );

  app.post(
    "/api/v1/teams/:teamId/archive",
    {
      preHandler: teamGate("team.archive", "admin", true),
      schema: {
        description: "Archive an empty childless Team and disable its authority immediately.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: RevisionBodySchema,
        response: { 200: TeamSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () =>
        service.archive(
          params(req).teamId,
          (req.body as { revision: number }).revision,
          await actor(req, service)
        )
      )
  );

  app.delete(
    "/api/v1/teams/:teamId",
    {
      preHandler: teamGate("team.delete", "admin", true),
      schema: {
        description: "Permanently delete an empty archived Team.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: RevisionBodySchema,
        response: { 200: OK_SCHEMA, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        await service.delete(
          params(req).teamId,
          (req.body as { revision: number }).revision,
          await actor(req, service)
        );
        return { status: "ok" };
      })
  );

  app.get(
    "/api/v1/teams/:teamId/activity",
    {
      preHandler: teamGate("team.activity.read", "admin"),
      schema: {
        description: "Query Team Activity by action.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        querystring: TeamActivityQuerySchema,
        response: { 200: TeamActivitySchema, ...commonErrors },
      },
    },
    (req, reply) => {
      const query = req.query as { limit?: number; action?: string };
      return send(reply, () =>
        service.activity(params(req).teamId, {
          limit: query.limit ?? 50,
          ...(query.action ? { action: query.action } : {}),
        })
      );
    }
  );

  app.post(
    "/api/v1/teams/:teamId/access-explanations",
    {
      preHandler: staticGate({
        action: "authz.explain",
        resourceType: "authz",
        fallback: "admin",
      }),
      schema: {
        description:
          "Explain live access with Team membership, hierarchy, Role, and grant evidence.",
        tags: ["teams"],
        security: TEAM_SECURITY,
        params: TeamIdParamsSchema,
        body: AccessExplanationBodySchema,
        response: { 200: TeamAccessExplanationSchema, ...commonErrors },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        principalId: string;
        action: string;
        resourceType: string;
        agentId?: string;
      };
      const result = await service.explain(body);
      if ("notFound" in result) {
        return reply.code(404).send({ error: `${result.notFound} does not exist` });
      }
      return reply.send({
        allowed: result.allowed,
        reason: result.reason,
        action: body.action,
        resource: body.resourceType,
        evidence: result.evidence,
      });
    }
  );

  registerGroupAliases(app, service, staticGate, teamGate, commonErrors);
}

function registerGroupAliases(
  app: FastifyInstance,
  service: TeamApiService,
  staticGate: (authorization: RouteAuthorization, write?: boolean) => PreHandler[],
  teamGate: (
    action: string,
    fallback: RouteAuthorization["fallback"],
    write?: boolean
  ) => PreHandler[],
  commonErrors: Record<number, typeof ErrorSchema>
): void {
  app.get(
    "/api/v1/authz/groups",
    {
      preHandler: staticGate(teamAuthorization("team.directory.read", "authenticated")),
      schema: {
        deprecated: true,
        description: "Deprecated group alias for the Team directory.",
        tags: ["authz", "teams"],
        security: TEAM_SECURITY,
        response: {
          200: LegacyGroupListSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async () => ({ ...(await service.list()), deprecation: GROUP_COMPATIBILITY_DEPRECATION })
  );

  app.post(
    "/api/v1/authz/groups",
    {
      preHandler: staticGate(teamAuthorization("team.create", "admin"), true),
      schema: {
        deprecated: true,
        description: "Deprecated group create alias; creates a Team.",
        tags: ["authz", "teams"],
        security: TEAM_SECURITY,
        body: LegacyGroupCreateBodySchema,
        response: { 201: LegacyGroupResponseSchema, ...commonErrors },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body as {
          id: string;
          displayName?: string;
          description?: string;
          parentTeamId?: string;
          initialAdminUserIds?: string[];
        };
        if (!req.principal) throw new TeamServiceError("forbidden", "Authentication required");
        const team = await service.create(
          {
            slug: body.id,
            displayName: body.displayName ?? body.id,
            ...(body.description ? { description: body.description } : {}),
            parentTeamId: body.parentTeamId ?? (await service.everyoneId()),
            initialAdminUserIds: body.initialAdminUserIds ?? [req.principal.id],
          },
          await actor(req, service)
        );
        await service.putLegacyMapping(body.id, team.id);
        return reply.code(201).send({ team, deprecation: GROUP_COMPATIBILITY_DEPRECATION });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get(
    "/api/v1/authz/groups/:groupId",
    {
      preHandler: [requireLegacyAuth(service, teamGate, "team.read", "authenticated")],
      schema: {
        deprecated: true,
        description: "Deprecated group detail alias; returns Team-shaped data.",
        tags: ["authz", "teams"],
        security: TEAM_SECURITY,
        params: LegacyGroupParamsSchema,
        response: { 200: LegacyGroupResponseSchema, ...commonErrors },
      },
    },
    async (req, reply) => {
      const teamId = await service.legacyTeamId((req.params as { groupId: string }).groupId);
      if (!teamId) return (reply as FastifyReply).code(404).send({ error: "Team was not found" });
      return send(reply, async () => ({
        team: await service.get(teamId),
        deprecation: GROUP_COMPATIBILITY_DEPRECATION,
      }));
    }
  );

  app.patch(
    "/api/v1/authz/groups/:groupId",
    {
      preHandler: [requireLegacyAuth(service, teamGate, "team.write", "admin", true)],
      schema: {
        deprecated: true,
        description: "Deprecated group update alias; updates Team identity.",
        tags: ["authz", "teams"],
        security: TEAM_SECURITY,
        params: LegacyGroupParamsSchema,
        body: TeamUpdateRequestSchema,
        response: { 200: LegacyGroupResponseSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => ({
        team: await service.update(
          await requiredLegacyTeamId(service, req),
          req.body as { displayName?: string; description?: string | null; revision: number },
          await actor(req, service)
        ),
        deprecation: GROUP_COMPATIBILITY_DEPRECATION,
      }))
  );

  app.delete(
    "/api/v1/authz/groups/:groupId",
    {
      preHandler: [requireLegacyAuth(service, teamGate, "team.delete", "admin", true)],
      schema: {
        deprecated: true,
        description: "Deprecated group delete alias; deletes an empty archived Team.",
        tags: ["authz", "teams"],
        security: TEAM_SECURITY,
        params: LegacyGroupParamsSchema,
        body: RevisionBodySchema,
        response: { 200: DeprecatedOkSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        await service.delete(
          await requiredLegacyTeamId(service, req),
          (req.body as { revision: number }).revision,
          await actor(req, service)
        );
        return { status: "ok", deprecation: GROUP_COMPATIBILITY_DEPRECATION };
      })
  );

  app.post(
    "/api/v1/authz/groups/:groupId/members",
    {
      preHandler: [requireLegacyAuth(service, teamGate, "team.member.manage", "admin", true)],
      schema: {
        deprecated: true,
        description: "Deprecated group member alias; adds a direct Team member.",
        tags: ["authz", "teams"],
        security: TEAM_SECURITY,
        params: LegacyGroupParamsSchema,
        body: LegacyGroupMemberBodySchema,
        response: { 201: DeprecatedMembershipSchema, ...commonErrors },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body as {
          principalId: string;
          level?: "member" | "admin";
          expiresAt?: string;
        };
        const membership = await service.addMember(
          await requiredLegacyTeamId(service, req),
          {
            principalId: body.principalId,
            level: body.level ?? "member",
            ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
          },
          await actor(req, service)
        );
        return reply.code(201).send({ membership, deprecation: GROUP_COMPATIBILITY_DEPRECATION });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.patch(
    "/api/v1/authz/groups/:groupId/members/:principalId",
    {
      preHandler: [requireLegacyAuth(service, teamGate, "team.member.manage", "admin", true)],
      schema: {
        deprecated: true,
        description: "Deprecated group member alias; changes Team membership level or expiry.",
        tags: ["authz", "teams"],
        security: TEAM_SECURITY,
        params: LegacyGroupMemberParamsSchema,
        body: TeamMemberUpdateBodySchema,
        response: { 200: DeprecatedMembershipSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        const route = req.params as { principalId: string };
        return {
          membership: await service.updateMember(
            await requiredLegacyTeamId(service, req),
            route.principalId,
            req.body as { level: "member" | "admin"; expiresAt?: string | null; revision: number },
            await actor(req, service)
          ),
          deprecation: GROUP_COMPATIBILITY_DEPRECATION,
        };
      })
  );

  app.delete(
    "/api/v1/authz/groups/:groupId/members/:principalId",
    {
      preHandler: [requireLegacyAuth(service, teamGate, "team.member.manage", "admin", true)],
      schema: {
        deprecated: true,
        description: "Deprecated group member alias; removes a direct Team member.",
        tags: ["authz", "teams"],
        security: TEAM_SECURITY,
        params: LegacyGroupMemberParamsSchema,
        body: RevisionBodySchema,
        response: { 200: DeprecatedOkSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        const route = req.params as { principalId: string };
        await service.removeMember(
          await requiredLegacyTeamId(service, req),
          route.principalId,
          (req.body as { revision: number }).revision,
          await actor(req, service)
        );
        return { status: "ok", deprecation: GROUP_COMPATIBILITY_DEPRECATION };
      })
  );

  app.post(
    "/api/v1/authz/groups/:groupId/roles",
    {
      preHandler: [requireLegacyAuth(service, teamGate, "team.role.manage", "admin", true)],
      schema: {
        deprecated: true,
        description: "Deprecated group Role alias; assigns a Role to a Team.",
        tags: ["authz", "teams"],
        security: TEAM_SECURITY,
        params: LegacyGroupParamsSchema,
        body: TeamRoleBodySchema,
        response: { 200: DeprecatedOkSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        await service.assignRole(
          await requiredLegacyTeamId(service, req),
          req.body as { roleId: string; expiresAt?: string },
          await actor(req, service)
        );
        return { status: "ok", deprecation: GROUP_COMPATIBILITY_DEPRECATION };
      })
  );

  app.delete(
    "/api/v1/authz/groups/:groupId/roles/:roleId",
    {
      preHandler: [requireLegacyAuth(service, teamGate, "team.role.manage", "admin", true)],
      schema: {
        deprecated: true,
        description: "Deprecated group Role alias; revokes a direct Team Role.",
        tags: ["authz", "teams"],
        security: TEAM_SECURITY,
        params: LegacyGroupRoleParamsSchema,
        response: { 200: DeprecatedOkSchema, ...commonErrors },
      },
    },
    (req, reply) =>
      send(reply, async () => {
        const route = req.params as { roleId: string };
        await service.revokeRole(
          await requiredLegacyTeamId(service, req),
          route.roleId,
          await actor(req, service)
        );
        return { status: "ok", deprecation: GROUP_COMPATIBILITY_DEPRECATION };
      })
  );
}

function requireLegacyAuth(
  service: TeamApiService,
  teamGate: (
    action: string,
    fallback: RouteAuthorization["fallback"],
    write?: boolean
  ) => PreHandler[],
  action: string,
  fallback: RouteAuthorization["fallback"],
  write = false
): PreHandler {
  return async (req, reply) => {
    const teamId = await service.legacyTeamId((req.params as { groupId: string }).groupId);
    if (!teamId) return;
    const original = req.params;
    req.params = { ...(original as Record<string, unknown>), teamId };
    for (const hook of teamGate(action, fallback, write)) await hook(req, reply);
    req.params = original;
  };
}

async function requiredLegacyTeamId(service: TeamApiService, req: FastifyRequest): Promise<string> {
  const teamId = await service.legacyTeamId((req.params as { groupId: string }).groupId);
  if (!teamId) throw new TeamServiceError("not_found", "Team was not found");
  return teamId;
}
