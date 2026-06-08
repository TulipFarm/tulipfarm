import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cookieSecure } from "../cookie-secure";
import { generateCsrfToken, setCsrfCookie } from "../csrf";
import { SESSION_COOKIE } from "../middleware";
import { hashPassword, verifyPassword } from "../passwords";
import { ErrorSchema, PublicUserSchema } from "../schemas";
import { DEFAULT_SESSION_TTL_SECONDS, type SessionStore } from "../session-store";
import { type UserRepo, toPublicUser } from "../users";

// Precomputed lazily and reused: verifying against a dummy hash on unknown-user
// login keeps response timing similar to the known-user path (no user enumeration).
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("tulipfarm-timing-equalizer");
  }
  return dummyHashPromise;
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: cookieSecure(),
    path: "/",
    maxAge,
  };
}

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerSessionRoutes(
  app: FastifyInstance,
  store: SessionStore,
  repo: UserRepo,
  requireAuth: PreHandler,
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  rateLimitHook?: PreHandler
): void {
  app.post(
    "/api/v1/auth/login",
    {
      preHandler: rateLimitHook ?? [],
      schema: {
        description: "Authenticate with email and password. Sets session cookie.",
        tags: ["auth"],
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
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

      const sid = await store.create(user._id);
      reply.setCookie(SESSION_COOKIE, sid, cookieOptions(ttlSeconds));
      setCsrfCookie(reply, generateCsrfToken(), ttlSeconds);
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
}
