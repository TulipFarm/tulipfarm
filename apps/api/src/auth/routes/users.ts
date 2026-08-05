import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateTempPassword } from "../passwords";
import { ErrorSchema, PublicUserSchema } from "../schemas";
import {
  createUser,
  EmailAlreadyExistsError,
  toPublicUser,
  type UserAdminRepo,
  type UserRepo,
} from "../users";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.user?.role !== "admin") {
    return reply.code(403).send({ error: "admin role required" });
  }
}

export function registerAdminUserRoutes(
  app: FastifyInstance,
  repo: UserRepo,
  userAdminRepo: UserAdminRepo,
  requireAuth: PreHandler,
  rateLimitHook?: PreHandler
): void {
  const adminOnly: PreHandler[] = rateLimitHook
    ? [rateLimitHook, requireAuth, requireAdmin]
    : [requireAuth, requireAdmin];

  app.post(
    "/api/v1/users",
    {
      preHandler: adminOnly,
      schema: {
        description:
          "Create a member user with a system-generated temporary password. The password is " +
          "returned once for the admin to share out-of-band (e.g. Slack); the new user must " +
          "reset it on first login.",
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
              temporaryPassword: { type: "string" },
            },
            required: ["user", "temporaryPassword"],
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

      const temporaryPassword = generateTempPassword();
      try {
        const user = await createUser(repo, email, temporaryPassword, "member", true);
        return reply.code(201).send({ user: toPublicUser(user), temporaryPassword });
      } catch (err) {
        if (err instanceof EmailAlreadyExistsError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
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
        description: "Enable or disable a user. An admin cannot disable their own account.",
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
      if (target.role === "admin") {
        return reply.code(400).send({ error: "cannot change the admin's status" });
      }

      await userAdminRepo.setStatus(id, status);
      return reply.send({ user: toPublicUser({ ...target, status }) });
    }
  );
}
