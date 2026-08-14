import { createModel, LlmProviderError, parseCodexAuth } from "@tulipfarm/llm";
import { LlmCredentialError } from "@tulipfarm/schema";
import { llmProviderById, providerField, type SecretsService } from "@tulipfarm/secrets";
import type { GitSyncService } from "@tulipfarm/soul";
import { generateText } from "ai";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sessionCookieOptions } from "../auth/cookie-security";
import { setCsrfCookie } from "../auth/csrf";
import { SESSION_COOKIE } from "../auth/middleware";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, validatePassword } from "../auth/passwords";
import { ErrorSchema, PublicUserSchema } from "../auth/schemas";
import { DEFAULT_SESSION_TTL_SECONDS, type SessionStore } from "../auth/session-store";
import { AdminAlreadyExistsError, createUser, toPublicUser, type UserRepo } from "../auth/users";
import { makeRateLimitHook, type RateLimiter } from "../rate-limit";
import { commitActorFromRequest } from "../soul/commit-actor";
import type { SetupAdminCreator } from "./first-admin";
import { isHeadlessBoot } from "./service";
import { patchSoulConfig, readSoulConfig } from "./soul-config";

// Cheapest models per provider, used only to validate the API key on setup.
const PROBE_MODEL: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  "claude-code": "haiku",
  codex: "gpt-5.6-luna",
};

/**
 * The probe runs inside the wizard's HTTP request. An API-keyed provider answers in seconds, but a
 * Subscription Provider spawns a CLI subprocess whose default per-call budget is ten minutes —
 * long enough that a bad token would look like a hung wizard rather than a rejected credential.
 */
const PROBE_TIMEOUT_MS = 30_000;

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface SetupDeps {
  userRepo: UserRepo;
  sessionStore: SessionStore;
  secretsService: SecretsService;
  gitSync: GitSyncService;
  soulPath: string;
  requireAuth: PreHandler;
  setupAdminCreator?: SetupAdminCreator;
  ttlSeconds?: number;
}

function setSessionCookies(
  reply: FastifyReply,
  sid: string,
  csrfToken: string,
  ttlSeconds: number
): void {
  reply.setCookie(SESSION_COOKIE, sid, sessionCookieOptions(ttlSeconds));
  setCsrfCookie(reply, csrfToken, ttlSeconds);
}

// Always-registered: returns needsSetup regardless of boot mode.
// In headless boot all wizard step routes are absent (404), but this endpoint is always available
// so the web client can rely on an explicit 200 rather than treating 404 as "not needed".
export function registerSetupStatusRoute(
  app: FastifyInstance,
  deps: Pick<SetupDeps, "userRepo" | "soulPath"> & { rateLimiter?: RateLimiter }
): void {
  const { userRepo, soulPath, rateLimiter } = deps;
  // 30 req/min per IP — generous for a status poll, protects DB/FS on cold path.
  const preHandler = rateLimiter
    ? makeRateLimitHook(rateLimiter, (req) => `rl:setup:${req.ip}`, 30, 60_000)
    : undefined;
  // Closure-scoped cache: once setup is confirmed complete, skip all I/O for the
  // lifetime of this process. Resets naturally on restart (one cold check per boot).
  let done = false;

  app.get(
    "/api/v1/setup/status",
    {
      ...(preHandler ? { preHandler } : {}),
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
    async () => {
      if (done) return { needsSetup: false };
      if (isHeadlessBoot()) {
        done = true;
        return { needsSetup: false };
      }
      const cfg = await readSoulConfig(soulPath);
      if (cfg.setupComplete === true) {
        done = true;
        return { needsSetup: false };
      }
      const hasUsers = (await userRepo.count()) > 0;
      if (hasUsers) {
        // Users exist but setupComplete missing from soul.yaml — soul.yaml was likely lost
        // (e.g. volume loss after wizard completed). Treat as done; cache for this process
        // lifetime but do NOT write setupComplete here: only POST /setup/complete owns that flag.
        // On next restart a single DB query runs again, which is acceptable.
        done = true;
        return { needsSetup: false };
      }
      return { needsSetup: true };
    }
  );
}

// First-run setup wizard. Routes are only registered when NOT in headless
// boot mode (isHeadlessBoot() === false, checked by caller in app.ts).
//
// Guard hierarchy:
//   POST /admin   → open only while no users exist (requireSetupOpen)
//   POST /business, /llm, /git → auth + admin + setupComplete=false (wizardStep)
//   POST /complete → auth + admin
export function registerSetupRoutes(app: FastifyInstance, deps: SetupDeps): void {
  const {
    userRepo,
    sessionStore,
    secretsService,
    gitSync,
    soulPath,
    requireAuth,
    setupAdminCreator,
    ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  } = deps;

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

  // Step 1: create the first admin and auto-login (sets session + CSRF cookies).
  app.post(
    "/api/v1/setup/admin",
    {
      preHandler: requireSetupOpen,
      schema: {
        description: "Create the first admin account and auto-login. Open until any admin exists.",
        tags: ["setup"],
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: {
              type: "string",
              minLength: MIN_PASSWORD_LENGTH,
              maxLength: MAX_PASSWORD_LENGTH,
            },
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
      if (!email) {
        return reply.code(400).send({ error: "email is required" });
      }
      const pwErr = validatePassword(password);
      if (pwErr) {
        return reply.code(400).send({ error: pwErr.message });
      }
      // requireSetupOpen's count() check is a fast-path only. The setup_bootstrap unique index
      // closes the race without limiting later admins: one first-admin claim wins; the loser gets
      // AdminAlreadyExistsError and no session (#172).
      let user: Awaited<ReturnType<typeof createUser>>;
      try {
        user = await createUser(userRepo, email, password, "admin", {
          setupBootstrap: true,
          ...(setupAdminCreator ? { insert: (record) => setupAdminCreator.create(record) } : {}),
        });
      } catch (err) {
        if (err instanceof AdminAlreadyExistsError) {
          return reply.code(403).send({ error: "setup already complete" });
        }
        throw err;
      }
      const session = await sessionStore.issue({ userId: user._id, authMethods: ["password"] });
      setSessionCookies(reply, session.sid, session.csrfToken, ttlSeconds);
      return reply.code(201).send({ user: toPublicUser(user) });
    }
  );

  // Step 2: record business name + description + website in soul.yaml.
  app.post(
    "/api/v1/setup/business",
    {
      preHandler: wizardStep,
      schema: {
        description: "Record the business name, description, and website in the soul.",
        tags: ["setup"],
        security: [{ sessionCookie: [] }],
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string" },
            website: { type: "string" },
          },
        },
        response: {
          204: { type: "null" },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        name?: unknown;
        description?: unknown;
        website?: unknown;
      };
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const description = typeof body.description === "string" ? body.description : "";
      const website = typeof body.website === "string" ? body.website.trim() : "";
      if (!name) return reply.code(400).send({ error: "name is required" });
      await patchSoulConfig(soulPath, {
        businessName: name,
        businessDescription: description,
        businessWebsite: website,
      });
      await gitSync
        .commit("chore: set business profile", commitActorFromRequest(req))
        .catch(() => {});
      return reply.code(204).send();
    }
  );

  // Step 3: store + live-validate the LLM API key.
  // Saves key first, then probes with a minimal generateText call.
  // On credential error: removes key and returns 400 with a clear message.
  // On transient error (network, rate-limit, 5xx): keeps the key and returns 204 with a warning
  // so a bad network at setup time doesn't block the user.
  app.post(
    "/api/v1/setup/llm",
    {
      preHandler: wizardStep,
      schema: {
        description: "Store an LLM provider API key and validate it with a live probe.",
        tags: ["setup"],
        security: [{ sessionCookie: [] }],
        body: {
          type: "object",
          required: ["provider", "apiKey"],
          properties: {
            provider: {
              type: "string",
              enum: ["anthropic", "openai", "claude-code", "codex"],
            },
            apiKey: { type: "string", minLength: 1 },
          },
        },
        response: {
          204: { type: "null" },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { provider?: unknown; apiKey?: unknown };
      const provider =
        body.provider === "openai" || body.provider === "claude-code" || body.provider === "codex"
          ? body.provider
          : "anthropic";
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      if (!apiKey) return reply.code(400).send({ error: "apiKey is required" });

      // Codex's credential is a JSON file, not a token, and only a subscription-mode one works.
      // Reject a malformed or API-key-mode blob here rather than storing it and letting the probe
      // fail thirty seconds later with a less specific message.
      if (provider === "codex") {
        try {
          parseCodexAuth(apiKey);
        } catch (err) {
          return reply
            .code(400)
            .send({ error: err instanceof Error ? err.message : "auth.json is invalid" });
        }
      }

      const providerInfo = llmProviderById(provider);
      const secretKey = providerInfo
        ? (providerField(providerInfo, "api_key")?.key ?? `${provider}-api-key`)
        : `${provider}-api-key`;
      await secretsService.set(secretKey, apiKey);

      // Live probe: validate the key is accepted by the provider.
      const probeModelId = PROBE_MODEL[provider] ?? "claude-haiku-4-5-20251001";
      try {
        const model = await createModel(
          { provider, model: probeModelId, api_key_ref: secretKey },
          secretsService,
          { timeoutMs: PROBE_TIMEOUT_MS }
        );
        await generateText({ model, prompt: "ping" });
      } catch (err) {
        if (err instanceof LlmCredentialError) {
          // Key is wrong — clean up and report the problem
          await secretsService.delete(secretKey).catch(() => {});
          return reply.code(400).send({ error: `API key is invalid: ${err.message}` });
        }
        // A Subscription Provider never produces LlmCredentialError — it rejects a bad token from
        // inside the turn, as a hard LlmProviderError. Without this branch the wizard would file a
        // known-bad credential under "transient" and keep it.
        if (err instanceof LlmProviderError && err.reason === "model_authentication_failed") {
          await secretsService.delete(secretKey).catch(() => {});
          return reply.code(400).send({ error: `Credential is invalid: ${err.message}` });
        }
        // Transient (network, 5xx, rate-limit) — keep the key, let first chat surface any real issue
        app.log.warn({ err }, "LLM probe returned a transient error during setup; key kept");
      }

      return reply.code(204).send();
    }
  );

  // Step 4 (optional): configure soul git backup. Stores remote URL in soul.yaml (Soul Config)
  // and credentials as an encrypted Secret ("soul-git-credential"), then syncs immediately —
  // clones/pulls the remote into the live GitSyncService instance, no restart required.
  app.post(
    "/api/v1/setup/git",
    {
      preHandler: wizardStep,
      schema: {
        description:
          "Configure soul git backup (optional). Persists remote URL + credentials and syncs immediately.",
        tags: ["setup"],
        security: [{ sessionCookie: [] }],
        body: {
          type: "object",
          required: ["remoteUrl"],
          properties: {
            remoteUrl: { type: "string", minLength: 1 },
            credentials: { type: "string" },
          },
        },
        response: {
          204: { type: "null" },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { remoteUrl?: unknown; credentials?: unknown };
      const remoteUrl = typeof body.remoteUrl === "string" ? body.remoteUrl.trim() : "";
      const credentials = typeof body.credentials === "string" ? body.credentials.trim() : "";
      if (!remoteUrl) return reply.code(400).send({ error: "remoteUrl is required" });

      await patchSoulConfig(soulPath, { gitRemoteUrl: remoteUrl });
      if (credentials) {
        await secretsService.set("soul-git-credential", credentials);
      }
      try {
        const resolvedCredentials = credentials || undefined;
        await gitSync.configureRemote(remoteUrl, async () => resolvedCredentials);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: `Failed to sync with remote: ${message}` });
      }
      return reply.code(204).send();
    }
  );

  // Final step: mark setup complete. Wizard steps become 403 after this.
  app.post(
    "/api/v1/setup/complete",
    {
      preHandler: [requireAuth, requireAdmin],
      schema: {
        description: "Mark first-run setup as complete.",
        tags: ["setup"],
        security: [{ sessionCookie: [] }],
        response: {
          204: { type: "null" },
          401: ErrorSchema,
          403: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      // Completing hides the wizard permanently, and the wizard is the only surface that writes
      // `llm:`. Marking an instance complete with no model chain therefore strands it: every Run
      // fails routing, and a participant sees a generic model failure with nothing to act on.
      const cfg = (await readSoulConfig(soulPath)) as { llm?: unknown };
      if (cfg.llm === undefined) {
        return reply.code(422).send({
          error:
            "Cannot complete setup without an LLM configuration. Configure a model provider first.",
        });
      }
      await patchSoulConfig(soulPath, { setupComplete: true });
      await gitSync
        .commit("chore: complete first-run setup", commitActorFromRequest(req))
        .catch(() => {});
      return reply.code(204).send();
    }
  );
}
