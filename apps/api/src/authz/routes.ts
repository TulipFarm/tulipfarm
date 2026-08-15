/** Admin-only grant editor; it does not enable enforcement on other requests. */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { makeRateLimitHook, type RateLimiter } from "../rate-limit";
import type { RequireAuthorization, RouteAuthorization } from "./route-gate";
import {
  AssigneeSchema,
  AUTHZ_SECURITY,
  EffectiveGrantsSchema,
  ExplainSchema,
  GroupDetailSchema,
  GroupViewSchema,
  IsoDateTime,
  OkSchema,
  PrincipalViewSchema,
  REGISTRABLE_PRINCIPAL_KINDS,
  RoleViewSchema,
} from "./schemas";
import {
  type AuthzActor,
  type AuthzAdminService,
  type MutationErrorCode,
  type MutationResult,
  type RegisterPrincipalInput,
  RoleAuthoringUnavailableError,
} from "./service";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const AUTHZ_WRITE_LIMIT = 60;
const AUTHZ_WRITE_WINDOW_MS = 60_000;

const idParam = { type: "string", minLength: 1 } as const;

/**
 * Authorization governs itself (authorization-design D8): without this, "can write Soul" becomes
 * "can grant myself anything" the moment Role definitions live in the Soul.
 */
function authz(action: string): RouteAuthorization {
  return { action, resourceType: "authz", fallback: "admin" };
}

function actorFrom(req: FastifyRequest): AuthzActor {
  return { actorId: req.principal?.id ?? null, correlationId: req.id };
}

const MUTATION_STATUS: Readonly<Record<MutationErrorCode, 400 | 404 | 409>> = {
  role_not_found: 404,
  principal_not_found: 404,
  group_not_found: 404,
  not_assignable: 400,
  user_principal_managed: 400,
  // 409: the id exists and the request is well-formed; re-pointing it at a different kind would
  // re-interpret every Role assignment already made against it.
  principal_kind_conflict: 409,
  // 409: the request is well-formed and the target exists; it conflicts with the invariant that
  // someone must hold `owner`.
  last_owner: 409,
};

function sendMutation(reply: FastifyReply, result: MutationResult): FastifyReply {
  if (result.ok) return reply.code(200).send({ status: "ok" });
  return reply.code(MUTATION_STATUS[result.code]).send({ error: result.message });
}

export function registerAuthzRoutes(
  app: FastifyInstance,
  service: AuthzAdminService,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  rateLimiter?: RateLimiter
): void {
  const rateLimitHook = rateLimiter
    ? makeRateLimitHook(
        rateLimiter,
        (req) => `rl:authz:${req.ip}`,
        AUTHZ_WRITE_LIMIT,
        AUTHZ_WRITE_WINDOW_MS
      )
    : undefined;
  const gate = (authorization: RouteAuthorization): PreHandler[] =>
    rateLimitHook
      ? [rateLimitHook, requireAuth, requireAuthorization(authorization)]
      : [requireAuth, requireAuthorization(authorization)];

  app.get(
    "/api/v1/authz/roles",
    {
      preHandler: gate(authz("authz.role.read")),
      schema: {
        description:
          "List every durable Role, distinguishing built-in bootstrap Roles (owner/admin/member) " +
          "from Soul-authored ones.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["roles"],
            properties: { roles: { type: "array", items: RoleViewSchema } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async () => ({ roles: await service.listRoles() })
  );

  app.get(
    "/api/v1/authz/roles/:roleId/assignees",
    {
      preHandler: gate(authz("authz.role.read")),
      schema: {
        description: "List the principals a Role is currently assigned to (unexpired only).",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["roleId"],
          properties: { roleId: idParam },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["assignees"],
            properties: { assignees: { type: "array", items: AssigneeSchema } },
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { roleId } = req.params as { roleId: string };
      const assignees = await service.listAssignees(roleId);
      if (assignees === null) {
        return reply.code(404).send({ error: `role ${roleId} does not exist` });
      }
      return { assignees };
    }
  );

  app.get(
    "/api/v1/authz/groups",
    {
      preHandler: gate(authz("authz.group.read")),
      schema: {
        description: "List every principal group.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["groups"],
            properties: { groups: { type: "array", items: GroupViewSchema } },
          },
          401: ErrorSchema,
          403: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async () => ({ groups: await service.listGroups() })
  );

  app.get(
    "/api/v1/authz/groups/:groupId",
    {
      preHandler: gate(authz("authz.group.read")),
      schema: {
        description: "Get a group with its unexpired members and the Roles it holds.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["groupId"],
          properties: { groupId: idParam },
        },
        response: {
          200: GroupDetailSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { groupId } = req.params as { groupId: string };
      const group = await service.getGroup(groupId);
      if (group === null) {
        return reply.code(404).send({ error: `group ${groupId} does not exist` });
      }
      return group;
    }
  );

  app.get(
    "/api/v1/authz/principals/:principalId/grants",
    {
      preHandler: gate(authz("authz.role.read")),
      schema: {
        description:
          "List a principal's effective grants — its direct Role assignments unioned with every " +
          "unexpired group-held Role it inherits — resolved through the live authority resolver.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["principalId"],
          properties: { principalId: idParam },
        },
        response: {
          200: EffectiveGrantsSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { principalId } = req.params as { principalId: string };
      const grants = await service.effectiveGrants(principalId);
      if (grants === null) {
        return reply.code(404).send({ error: `principal ${principalId} does not exist` });
      }
      return grants;
    }
  );

  app.get(
    "/api/v1/authz/principals",
    {
      preHandler: gate(authz("authz.role.read")),
      schema: {
        description:
          "List every principal in the deployment. Non-human principals (Integration adapters, " +
          "service identities, Agents) have no other source to enumerate them from.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        response: {
          200: { type: "array", items: PrincipalViewSchema },
          401: ErrorSchema,
          403: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    () => service.listPrincipals()
  );

  app.post(
    "/api/v1/authz/principals",
    {
      preHandler: gate(authz("authz.principal.register")),
      schema: {
        description:
          "Register a non-human principal so authority can be granted to it. Re-registering an " +
          "existing id with the same kind is idempotent; changing its kind is a conflict.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind"],
          properties: {
            id: idParam,
            kind: { type: "string", enum: [...REGISTRABLE_PRINCIPAL_KINDS] },
            expiresAt: IsoDateTime,
          },
        },
        response: {
          200: OkSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as RegisterPrincipalInput;
      return sendMutation(reply, await service.registerPrincipal(body, actorFrom(req)));
    }
  );

  app.post(
    "/api/v1/authz/explain",
    {
      preHandler: gate(authz("authz.explain")),
      schema: {
        description:
          "Explain the effective-permission decision for a principal + action + resource: the " +
          "decision, its reason code, and which authority layer denied. Calls the one decision " +
          "function (decideEffectivePermission) via the live resolver — it does not reimplement it. " +
          "Only the live layers are reachable here (caller, and the Agent when `agentId` is given); " +
          "the pinned run/guardrail/credential layers are not. Because the decision allows only " +
          "when EVERY layer allows, a denial is authoritative but an allow is an upper bound — " +
          "read `partial` and `unevaluatedLayers` before treating an allow as a gate guarantee.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["principalId", "action", "resourceType"],
          properties: {
            principalId: idParam,
            action: idParam,
            resourceType: idParam,
            agentId: { type: "string", minLength: 1 },
            domain: { type: "string", minLength: 1 },
            recordId: { type: "string", minLength: 1 },
            field: { type: "string", minLength: 1 },
            dataClass: { type: "string", minLength: 1 },
            destination: { type: "string", minLength: 1 },
            conditions: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        response: {
          200: ExplainSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        principalId: string;
        action: string;
        resourceType: string;
        agentId?: string;
        domain?: string;
        recordId?: string;
        field?: string;
        dataClass?: string;
        destination?: string;
        conditions?: Record<string, string>;
      };
      const decision = await service.explain(body);
      if ("notFound" in decision) {
        const missingId = decision.notFound === "agent" ? body.agentId : body.principalId;
        return reply.code(404).send({ error: `${decision.notFound} ${missingId} does not exist` });
      }
      return decision;
    }
  );

  app.post(
    "/api/v1/authz/roles",
    {
      preHandler: gate(authz("authz.role.author")),
      schema: {
        description:
          "Reserved for Role-definition authoring. Role definitions are the single writer of which " +
          "Soul owns; this surface must not write durable Role rows (they would be reaped on the " +
          "next soul sync), so it returns 501 naming the missing Soul authoring path.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        response: {
          401: ErrorSchema,
          403: ErrorSchema,
          429: ErrorSchema,
          501: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        await service.createRole();
      } catch (error) {
        if (error instanceof RoleAuthoringUnavailableError) {
          return reply.code(501).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  app.post(
    "/api/v1/authz/roles/:roleId/assignments",
    {
      preHandler: gate(authz("authz.role.assign")),
      schema: {
        description: "Assign a Role to a principal, optionally with an expiry.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["roleId"],
          properties: { roleId: idParam },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["principalId"],
          properties: { principalId: idParam, expiresAt: IsoDateTime },
        },
        response: {
          200: OkSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { roleId } = req.params as { roleId: string };
      const { principalId, expiresAt } = req.body as { principalId: string; expiresAt?: string };
      const result = await service.assignRole(
        { roleId, principalId, ...(expiresAt === undefined ? {} : { expiresAt }) },
        actorFrom(req)
      );
      return sendMutation(reply, result);
    }
  );

  app.delete(
    "/api/v1/authz/roles/:roleId/assignments/:principalId",
    {
      preHandler: gate(authz("authz.role.revoke")),
      schema: {
        description: "Revoke a Role from a principal. A no-op assignment still returns 200.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["roleId", "principalId"],
          properties: { roleId: idParam, principalId: idParam },
        },
        response: {
          200: OkSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { roleId, principalId } = req.params as { roleId: string; principalId: string };
      return sendMutation(reply, await service.revokeRole(roleId, principalId, actorFrom(req)));
    }
  );

  app.post(
    "/api/v1/authz/groups",
    {
      preHandler: gate(authz("authz.group.write")),
      schema: {
        description: "Create (or upsert) a principal group, optionally with an expiry.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: idParam, expiresAt: IsoDateTime },
        },
        response: {
          200: GroupViewSchema,
          201: GroupViewSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id, expiresAt } = req.body as { id: string; expiresAt?: string };
      const { created } = await service.createGroup(id, expiresAt, actorFrom(req));
      // 201 only for a genuine create. A re-statement of an existing group answers 200 so the
      // caller can tell it overwrote something — including, when `expiresAt` is omitted, an expiry.
      return reply.code(created ? 201 : 200).send({ id, expiresAt: expiresAt ?? null });
    }
  );

  app.delete(
    "/api/v1/authz/groups/:groupId",
    {
      preHandler: gate(authz("authz.group.write")),
      schema: {
        description:
          "Delete a group. Its memberships and group-held Roles cascade; the principals and Roles " +
          "themselves are untouched.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["groupId"],
          properties: { groupId: idParam },
        },
        response: {
          200: OkSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { groupId } = req.params as { groupId: string };
      return sendMutation(reply, await service.deleteGroup(groupId, actorFrom(req)));
    }
  );

  app.post(
    "/api/v1/authz/groups/:groupId/members",
    {
      preHandler: gate(authz("authz.group.member.write")),
      schema: {
        description: "Add a principal to a group, optionally with an expiry.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["groupId"],
          properties: { groupId: idParam },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["principalId"],
          properties: { principalId: idParam, expiresAt: IsoDateTime },
        },
        response: {
          200: OkSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { groupId } = req.params as { groupId: string };
      const { principalId, expiresAt } = req.body as { principalId: string; expiresAt?: string };
      const result = await service.addGroupMember(
        { groupId, principalId, ...(expiresAt === undefined ? {} : { expiresAt }) },
        actorFrom(req)
      );
      return sendMutation(reply, result);
    }
  );

  app.delete(
    "/api/v1/authz/groups/:groupId/members/:principalId",
    {
      preHandler: gate(authz("authz.group.member.write")),
      schema: {
        description: "Remove a principal from a group. A no-op membership still returns 200.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["groupId", "principalId"],
          properties: { groupId: idParam, principalId: idParam },
        },
        response: {
          200: OkSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { groupId, principalId } = req.params as { groupId: string; principalId: string };
      return sendMutation(
        reply,
        await service.removeGroupMember(groupId, principalId, actorFrom(req))
      );
    }
  );

  app.post(
    "/api/v1/authz/groups/:groupId/roles",
    {
      preHandler: gate(authz("authz.group.role.write")),
      schema: {
        description: "Grant a Role to a group; its members inherit it. Optional expiry.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["groupId"],
          properties: { groupId: idParam },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["roleId"],
          properties: { roleId: idParam, expiresAt: IsoDateTime },
        },
        response: {
          200: OkSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { groupId } = req.params as { groupId: string };
      const { roleId, expiresAt } = req.body as { roleId: string; expiresAt?: string };
      const result = await service.assignGroupRole(
        { groupId, roleId, ...(expiresAt === undefined ? {} : { expiresAt }) },
        actorFrom(req)
      );
      return sendMutation(reply, result);
    }
  );

  app.delete(
    "/api/v1/authz/groups/:groupId/roles/:roleId",
    {
      preHandler: gate(authz("authz.group.role.write")),
      schema: {
        description: "Revoke a Role from a group. A no-op holding still returns 200.",
        tags: ["authz"],
        security: AUTHZ_SECURITY,
        params: {
          type: "object",
          additionalProperties: false,
          required: ["groupId", "roleId"],
          properties: { groupId: idParam, roleId: idParam },
        },
        response: {
          200: OkSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          429: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { groupId, roleId } = req.params as { groupId: string; roleId: string };
      return sendMutation(reply, await service.revokeGroupRole(groupId, roleId, actorFrom(req)));
    }
  );
}
