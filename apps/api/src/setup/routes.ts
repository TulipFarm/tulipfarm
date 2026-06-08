import type { SecretsService } from "@tulipfarm/secrets";
import type { GitSyncService } from "@tulipfarm/soul";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { cookieSecure } from "../auth/cookie-secure";
import { generateCsrfToken, setCsrfCookie } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { ErrorSchema, PublicUserSchema } from "../auth/schemas";
import type { SessionStore } from "../auth/session-store";
import { type UserRepo, createUser, toPublicUser } from "../auth/users";
import { patchSoulConfig, readSoulConfig } from "./soul-config";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface SetupDeps {
  userRepo: UserRepo;
  sessionStore: SessionStore;
  secretsService: SecretsService;
  gitSync: GitSyncService;
  soulPath: string;
  requireAuth: PreHandler;
  ttlSeconds: number;
}

function setSessionCookies(reply: FastifyReply, sid: string, ttlSeconds: number): void {
  reply.setCookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/",
    maxAge: ttlSeconds,
  });
  setCsrfCookie(reply, generateCsrfToken(), ttlSeconds);
}

// First-run setup wizard (INST-003), wizard mode only. admin-create is open until
// an admin exists then 403; the post-login steps are admin-only and lock once
// setup is marked complete. Soul backup is configured via GIT_REMOTE_URL env
// (main's soul-git is env-driven), so there is no interactive git step.
export function registerSetupRoutes(app: FastifyInstance, deps: SetupDeps): void {
  const { userRepo, sessionStore, secretsService, gitSync, soulPath, requireAuth, ttlSeconds } =
    deps;

  async function requireSetupOpen(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if ((await userRepo.count()) > 0) {
      return reply.code(403).send({ error: "setup already complete" });
    }
  }

  async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (req.user?.role !== "admin") {
      return reply.code(403).send({ error: "admin role required" });
    }
  }

  async function requireSetupIncomplete(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if ((await readSoulConfig(soulPath)).setupComplete === true) {
      return reply.code(403).send({ error: "setup already complete" });
    }
  }

  const wizardStep: PreHandler[] = [requireAuth, requireAdmin, requireSetupIncomplete];

  app.get(
    "/api/v1/setup/status",
    {
      schema: {
        description: "Whether first-run setup is still required.",
        tags: ["setup"],
        response: {
          200: {
            type: "object",
            properties: { needsSetup: { type: "boolean" } },
            required: ["needsSetup"],
          },
        },
      },
    },
    async () => ({ needsSetup: (await userRepo.count()) === 0 })
  );

  app.post(
    "/api/v1/setup/admin",
    {
      preHandler: requireSetupOpen,
      schema: {
        description: "Create the first admin and start a session (open until an admin exists).",
        tags: ["setup"],
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8 },
          },
        },
        response: {
          201: { type: "object", properties: { user: PublicUserSchema }, required: ["user"] },
          400: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
      const email = typeof body.email === "string" ? body.email : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!email || password.length < 8) {
        return reply.code(400).send({ error: "email and a password (min 8 chars) are required" });
      }
      const user = await createUser(userRepo, email, password, "admin");
      const sid = await sessionStore.create(user._id);
      setSessionCookies(reply, sid, ttlSeconds);
      return reply.code(201).send({ user: toPublicUser(user) });
    }
  );

  app.post(
    "/api/v1/setup/business",
    {
      preHandler: wizardStep,
      schema: {
        description: "Record the business name + description into the soul.",
        tags: ["setup"],
        security: [{ sessionCookie: [] }],
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" }, description: { type: "string" } },
        },
        response: { 204: { type: "null" }, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { name?: unknown; description?: unknown };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const description = typeof body.description === "string" ? body.description : "";
      if (!name) {
        return reply.code(400).send({ error: "name is required" });
      }
      await patchSoulConfig(soulPath, { businessName: name, businessDescription: description });
      await gitSync.commit("chore: set business profile").catch(() => {});
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/v1/setup/llm",
    {
      preHandler: wizardStep,
      schema: {
        description: "Store an LLM provider key (encrypted). Validated on first use.",
        tags: ["setup"],
        security: [{ sessionCookie: [] }],
        body: {
          type: "object",
          required: ["provider", "apiKey"],
          properties: {
            provider: { type: "string", enum: ["anthropic", "openai"] },
            apiKey: { type: "string" },
          },
        },
        response: { 204: { type: "null" }, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { provider?: unknown; apiKey?: unknown };
      const provider = body.provider === "openai" ? "openai" : "anthropic";
      const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
      if (!apiKey) {
        return reply.code(400).send({ error: "apiKey is required" });
      }
      await secretsService.set(`${provider}-api-key`, apiKey);
      return reply.code(204).send();
    }
  );

  app.post(
    "/api/v1/setup/complete",
    {
      preHandler: [requireAuth, requireAdmin],
      schema: {
        description: "Mark first-run setup complete.",
        tags: ["setup"],
        security: [{ sessionCookie: [] }],
        response: { 204: { type: "null" }, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (_req, reply) => {
      await patchSoulConfig(soulPath, { setupComplete: true });
      await gitSync.commit("chore: complete setup").catch(() => {});
      return reply.code(204).send();
    }
  );
}
