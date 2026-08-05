import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sessionCookieOptions } from "../cookie-security";
import { CSRF_COOKIE, setCsrfCookie } from "../csrf";
import { SESSION_COOKIE } from "../middleware";
import { hashPassword, MAX_PASSWORD_LENGTH, verifyPassword } from "../passwords";
import { ErrorSchema, PublicUserSchema } from "../schemas";
import { DEFAULT_SESSION_TTL_SECONDS, rotateSession, type SessionStore } from "../session-store";
import { type PasswordResetRepo, toPublicUser, type UserRepo } from "../users";

// Precomputed lazily and reused: verifying against a dummy hash on unknown-user
// login keeps response timing similar to the known-user path (no user enumeration).
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("tulipfarm-timing-equalizer");
  }
  return dummyHashPromise;
}

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerSessionRoutes(
  app: FastifyInstance,
  store: SessionStore,
  repo: UserRepo,
  requireAuth: PreHandler,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  rateLimitHook?: PreHandler,
  loginRateLimitHook?: PreHandler,
  passwordResetRepo?: PasswordResetRepo
): void {
  const loginPreHandlers = [rateLimitHook, loginRateLimitHook].filter(
    (hook): hook is PreHandler => hook !== undefined
  );

  app.post(
    "/api/v1/auth/login",
    {
      preHandler: loginPreHandlers,
      schema: {
        description: "Authenticate with email and password. Sets session cookie.",
        tags: ["auth"],
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", maxLength: MAX_PASSWORD_LENGTH },
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
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
      const email = typeof body.email === "string" ? body.email : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!email || !password) {
        return reply.code(400).send({ error: "email and password are required" });
      }

      const user = await repo.findByEmail(email);
      if (!user) {
        await verifyPassword(await getDummyHash(), password);
        return reply.code(401).send({ error: "invalid credentials" });
      }
      if (!(await verifyPassword(user.passwordHash, password))) {
        return reply.code(401).send({ error: "invalid credentials" });
      }
      // A disabled identity is denied with the same message as a bad password: whether an
      // account exists and whether it is disabled are both unobservable to the caller.
      if (user.status === "disabled") {
        return reply.code(401).send({ error: "invalid credentials" });
      }

      // Rotate: any session id the browser already carried is destroyed and replaced, so a
      // pre-planted session id is never upgraded into an authenticated one (session fixation).
      const session = await rotateSession(store, req.cookies[SESSION_COOKIE], {
        userId: user._id,
        authMethods: ["password"],
      });
      reply.setCookie(SESSION_COOKIE, session.sid, sessionCookieOptions(ttlSeconds));
      setCsrfCookie(reply, session.csrfToken, ttlSeconds);
      return reply.code(200).send({ user: toPublicUser(user) });
    }
  );

  app.post(
    "/api/v1/auth/logout",
    {
      preHandler: rateLimitHook ?? [],
      schema: {
        description: "Destroy the current session and clear the session cookie.",
        tags: ["auth"],
        response: { 204: { type: "null" } },
      },
    },
    async (req, reply) => {
      const sid = req.cookies[SESSION_COOKIE];
      if (sid) {
        await store.destroy(sid);
      }
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });
      return reply.code(204).send();
    }
  );

  app.get(
    "/api/v1/auth/session",
    {
      preHandler: rateLimitHook ? [rateLimitHook, requireAuth] : requireAuth,
      schema: {
        description: "Return the currently authenticated user.",
        tags: ["auth"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        response: {
          200: {
            type: "object",
            properties: { user: PublicUserSchema },
            required: ["user"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!req.user) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      return reply.send({ user: toPublicUser(req.user) });
    }
  );

  if (passwordResetRepo) {
    app.post(
      "/api/v1/auth/change-password",
      {
        preHandler: rateLimitHook ? [rateLimitHook, requireAuth] : requireAuth,
        schema: {
          description:
            "Set a new password for the current user. Required to clear a forced password reset " +
            "on an admin-created account; every other route 403s with password_reset_required " +
            "until this is called.",
          tags: ["auth"],
          security: [{ sessionCookie: [] }, { bearerToken: [] }],
          body: {
            type: "object",
            required: ["newPassword"],
            properties: {
              newPassword: { type: "string", minLength: 8 },
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
          },
        },
      },
      async (req, reply) => {
        if (!req.user) {
          return reply.code(401).send({ error: "unauthorized" });
        }
        const body = (req.body ?? {}) as { newPassword?: unknown };
        const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
        if (newPassword.length < 8) {
          return reply.code(400).send({ error: "password must be at least 8 characters" });
        }

        const passwordHash = await hashPassword(newPassword);
        await passwordResetRepo.updatePassword(req.user._id, passwordHash, false);

        // Rotate: a session minted under the temporary password shouldn't outlive the reset.
        const session = await rotateSession(store, req.cookies[SESSION_COOKIE], {
          userId: req.user._id,
          authMethods: ["password"],
        });
        reply.setCookie(SESSION_COOKIE, session.sid, sessionCookieOptions(ttlSeconds));
        setCsrfCookie(reply, session.csrfToken, ttlSeconds);
        return reply.send({
          user: toPublicUser({ ...req.user, mustResetPassword: false }),
        });
      }
    );
  }
}
