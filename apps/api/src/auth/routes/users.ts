import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RequireAuthorization, RouteAuthorization } from "../../authz/route-gate";
import { issueInvite, type UserInviteRepo } from "../invites";
import { ErrorSchema, InviteSchema, PublicUserSchema } from "../schemas";
import {
  EmailAlreadyExistsError,
  inviteUser,
  toPublicUser,
  type UserAdminRepo,
  type UserRepo,
} from "../users";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const USER_MANAGE: RouteAuthorization = {
  action: "user.manage",
  resourceType: "user",
  fallback: "admin",
};

export function registerAdminUserRoutes(
  app: FastifyInstance,
  repo: UserRepo,
  userAdminRepo: UserAdminRepo,
  inviteRepo: UserInviteRepo,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  rateLimitHook?: PreHandler
): void {
  const gate = requireAuthorization(USER_MANAGE);
  const adminOnly: PreHandler[] = rateLimitHook
    ? [rateLimitHook, requireAuth, gate]
    : [requireAuth, gate];

  app.post(
    "/api/v1/users",
    {
      preHandler: adminOnly,
      schema: {
        description:
          "Create a member account with no password and issue its invite link. The link is " +
          "returned once for the admin to share out-of-band; the invited person chooses their " +
          "own password by redeeming it, so no credential is ever relayed on their behalf.",
        tags: ["users"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              user: PublicUserSchema,
              invite: InviteSchema,
            },
            required: ["user", "invite"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { email?: unknown };
      const email = typeof body.email === "string" ? body.email : "";
      if (!email) {
        return reply.code(400).send({ error: "email is required" });
      }
      if (!req.user) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      try {
        const user = await inviteUser(repo, email);
        const invite = await issueInvite(inviteRepo, {
          userId: user._id,
          createdBy: req.user._id,
        });
        return reply.code(201).send({
          user: toPublicUser(user),
          invite: { token: invite.token, expiresAt: invite.expiresAt.toISOString() },
        });
      } catch (err) {
        if (err instanceof EmailAlreadyExistsError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/users/:id/invite",
    {
      preHandler: adminOnly,
      schema: {
        description:
          "Issue a fresh invite link for an existing user, revoking any link still outstanding. " +
          "For an account that has not accepted yet this replaces a lost link; for an active one " +
          "it is the password recovery path. The account is left untouched — an existing " +
          "password keeps working until the new link is redeemed.",
        tags: ["users"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: { invite: InviteSchema },
            required: ["invite"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!req.user) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const target = await repo.findById(id);
      if (!target) {
        return reply.code(404).send({ error: "user not found" });
      }
      // A disabled account was switched off deliberately; handing out a link that sets a working
      // password on it would undo that decision without ever naming it. Re-enable it first.
      if (target.status === "disabled") {
        return reply.code(400).send({ error: "cannot invite a disabled user" });
      }

      const invite = await issueInvite(inviteRepo, { userId: id, createdBy: req.user._id });
      return reply.send({
        invite: { token: invite.token, expiresAt: invite.expiresAt.toISOString() },
      });
    }
  );

  app.get(
    "/api/v1/users",
    {
      preHandler: adminOnly,
      schema: {
        description: "List all users.",
        tags: ["users"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              items: { type: "array", items: PublicUserSchema },
            },
            required: ["items"],
          },
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (_req, reply) => {
      const users = await userAdminRepo.listAll();
      return reply.send({ items: users.map(toPublicUser) });
    }
  );

  app.patch(
    "/api/v1/users/:id/status",
    {
      preHandler: adminOnly,
      schema: {
        description:
          "Enable or disable a user. An admin cannot disable their own account. Re-enabling an " +
          "account that never accepted its invite resolves to `invited` rather than `active`, " +
          "since it has no password to be active with — so the returned status may differ from " +
          "the requested one.",
        tags: ["users"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["active", "disabled"] },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { user: PublicUserSchema },
            required: ["user"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { status?: unknown };
      const status = body.status === "active" || body.status === "disabled" ? body.status : null;
      if (!status) {
        return reply.code(400).send({ error: "status must be 'active' or 'disabled'" });
      }
      if (id === req.user?._id) {
        return reply.code(400).send({ error: "cannot change your own status" });
      }

      const target = await repo.findById(id);
      if (!target) {
        return reply.code(404).send({ error: "user not found" });
      }
      // Domain invariant about the target row, not a decision about the caller: the deployment
      // must not be able to lock out its own admin.
      if (target.role === "admin") {
        return reply.code(400).send({ error: "cannot change the admin's status" });
      }

      // Re-enabling an account that never chose a password returns it to `invited`, not `active`:
      // it has no credential to be active with, and saying otherwise would show the admin a
      // working account that cannot sign in.
      const resolved = status === "active" && target.passwordHash === null ? "invited" : status;
      await userAdminRepo.setStatus(id, resolved);
      return reply.send({ user: toPublicUser({ ...target, status: resolved }) });
    }
  );
}
