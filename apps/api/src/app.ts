import type { EventEmitter } from "node:events";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import scalar from "@scalar/fastify-api-reference";
import type { LlmService } from "@tulipfarm/llm";
import type { SecretsService } from "@tulipfarm/secrets";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import Fastify from "fastify";
import type { TokenRepo } from "./auth/api-tokens";
import { csrfHook } from "./auth/csrf";
import { makeRequireAuth } from "./auth/middleware";
import { registerAuthRoutes } from "./auth/routes";
import type { SessionStore } from "./auth/session-store";
import type { UserRepo } from "./auth/users";
import type { ConversationRepo } from "./chat/conversations";
import type { MessageRepo } from "./chat/messages";
import { registerChatRoutes } from "./chat/routes";
import { StreamHub } from "./chat/stream-hub";
import { MemoryStreamResumeRepo, type StreamResumeRepo } from "./chat/stream-resume";
import type { HookExecutor } from "./hooks/hook-executor";
import { registerKnowledgeRoutes } from "./knowledge/routes";
import type { KnowledgeService } from "./knowledge/service";
import type { WorkingMemoryService } from "./memory/service";
import type { RateLimiter } from "./rate-limit";
import type { CounterStore, ResourceRepoFactory } from "./resources/repo";
import { registerResourceRoutes } from "./resources/routes";
import { registerSecretsRoutes } from "./secrets/routes";
import { registerSetupRoutes } from "./setup/routes";
import { isManagedMode } from "./setup/service";
import { registerAgentRoutes } from "./soul/agents/routes";
import { registerResourceTypeRoutes } from "./soul/resource-types/routes";
import { registerSoulRoutes } from "./soul/routes";
import { registerSkillRoutes } from "./soul/skills/routes";
import type { ToolRegistry } from "./tools/registry";
import { buildToolRegistry } from "./tools/setup";

export interface AppOptions {
  sessionStore?: SessionStore;
  userRepo?: UserRepo;
  tokenRepo?: TokenRepo;
  rateLimiter?: RateLimiter;
  secretsService?: SecretsService;
  gitSync?: GitSyncService;
  soulLoader?: SoulLoader;
  hookExecutor?: HookExecutor;
  resourceRepoFactory?: ResourceRepoFactory;
  counterStore?: CounterStore;
  reconcileResources?: () => Promise<void>;
  domainEventEmitter?: EventEmitter;
  llmService?: LlmService;
  conversationRepo?: ConversationRepo;
  messageRepo?: MessageRepo;
  streamResumeRepo?: StreamResumeRepo;
  streamHub?: StreamHub;
  workingMemoryService?: WorkingMemoryService;
  knowledgeService?: KnowledgeService;
  toolRegistry?: ToolRegistry;
}

const DEFAULT_SESSION_TTL_SECONDS = 604800;

// Parse SESSION_TTL_SECONDS, falling back to the default when missing or malformed — a
// NaN/≤0 maxAge makes the cookie serializer throw and turns POST /setup/admin into a 500.
function parseTtlSeconds(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_TTL_SECONDS;
}

// Client-routing paths the SPA fallback must NOT swallow — they belong to the API/docs/
// health surfaces. Matched as a whole path or a path prefixed with the segment + "/".
function isServerPath(url: string): boolean {
  const path = url.split("?")[0];
  return ["/api", "/docs", "/health"].some((p) => path === p || path.startsWith(`${p}/`));
}

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({ logger: true });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "TulipFarm API", version: "1.0.0" },
      components: {
        securitySchemes: {
          sessionCookie: { type: "apiKey", in: "cookie", name: "tf_sid" },
          bearerToken: { type: "http", scheme: "bearer" },
        },
      },
    },
  });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? `http://localhost:${process.env.VITE_PORT ?? 4000}`,
    credentials: true,
  });

  // When this image also serves the built SPA (WEB_DIST set), a `default-src 'none'`
  // CSP would block the SPA's own scripts/styles and every fetch/SSE back to /api/v1/*,
  // and helmet's default `upgrade-insecure-requests` breaks plain-http installs. Use a
  // self-origin policy for that mode; keep the strict lockdown for API-only deployments.
  //
  // scriptSrc/styleSrc include 'unsafe-inline' because the built index.html ships two
  // inline scripts (the no-flash theme init and Remix's window.__remixContext hydration
  // bootstrap); a static file server can't inject a per-response nonce. This is an
  // acceptable trade-off here — the page shell is immutable build output and user content
  // is rendered escaped (react-markdown, no raw HTML), so nothing untrusted reaches an
  // inline-script context.
  const servingWeb = Boolean(process.env.WEB_DIST);
  await app.register(helmet, {
    contentSecurityPolicy: servingWeb
      ? {
          useDefaults: false,
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'", "data:"],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
          },
        }
      : {
          directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
        },
  });

  await app.register(cookie);

  // Relax CSP for the Scalar UI page so it can load its scripts and styles.
  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/docs")) {
      reply.header(
        "content-security-policy",
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"
      );
    }
  });

  app.addHook("preHandler", csrfHook);

  app.get(
    "/health",
    {
      schema: {
        description: "Health check",
        tags: ["system"],
        response: {
          200: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
          },
        },
      },
    },
    async () => ({ status: "ok" })
  );

  app.get("/api/v1/openapi.json", async () => app.swagger());

  await app.register(scalar, {
    routePrefix: "/docs",
    configuration: { spec: { url: "/api/v1/openapi.json" } },
  });

  if (opts.sessionStore && opts.userRepo && opts.tokenRepo) {
    registerAuthRoutes(app, opts.sessionStore, opts.userRepo, opts.tokenRepo, {
      rateLimiter: opts.rateLimiter,
    });
    const requireAuth = makeRequireAuth(opts.sessionStore, opts.userRepo, opts.tokenRepo);
    if (opts.secretsService) {
      registerSecretsRoutes(app, opts.secretsService, requireAuth);
    }
    if (opts.gitSync) {
      registerSoulRoutes(app, opts.gitSync, requireAuth);
      if (opts.soulLoader) {
        registerResourceTypeRoutes(
          app,
          opts.gitSync,
          opts.soulLoader,
          requireAuth,
          opts.reconcileResources
        );
        registerAgentRoutes(app, opts.soulLoader, requireAuth);
        if (opts.llmService) {
          registerSkillRoutes(app, opts.soulLoader, opts.gitSync, opts.llmService, requireAuth);
        }
      }
    }
    if (opts.resourceRepoFactory && opts.counterStore && opts.soulLoader) {
      registerResourceRoutes(
        app,
        opts.resourceRepoFactory,
        opts.counterStore,
        opts.soulLoader,
        requireAuth,
        opts.hookExecutor,
        opts.domainEventEmitter
      );
    }
    if (opts.llmService && opts.conversationRepo && opts.messageRepo) {
      const toolRegistry =
        opts.toolRegistry ??
        buildToolRegistry({
          workingMemory: opts.workingMemoryService,
          knowledge: opts.knowledgeService,
        });
      registerChatRoutes(
        app,
        opts.llmService,
        opts.conversationRepo,
        opts.messageRepo,
        opts.streamResumeRepo ?? new MemoryStreamResumeRepo(),
        opts.streamHub ?? new StreamHub(),
        requireAuth,
        opts.workingMemoryService,
        opts.knowledgeService,
        opts.soulLoader,
        opts.domainEventEmitter,
        toolRegistry
      );
    }
    if (opts.knowledgeService) {
      registerKnowledgeRoutes(app, opts.knowledgeService, requireAuth);
    }

    // First-run setup wizard (INST-003) — wizard mode only; managed mode leaves
    // /api/v1/setup/* unregistered -> 404. Git/soul backup is env-driven
    // (GIT_REMOTE_URL), so the wizard has no interactive git step.
    if (!isManagedMode() && opts.secretsService && opts.gitSync) {
      registerSetupRoutes(app, {
        userRepo: opts.userRepo,
        sessionStore: opts.sessionStore,
        secretsService: opts.secretsService,
        gitSync: opts.gitSync,
        soulPath: process.env.SOUL_PATH as string,
        requireAuth,
        ttlSeconds: parseTtlSeconds(process.env.SESSION_TTL_SECONDS),
      });
    }
  }

  // Single-image SPA serving (ARCH-V1-006): serve the built client and fall back
  // to index.html for client-side routes. API/docs/health take precedence.
  const webDist = process.env.WEB_DIST;
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if ((req.method === "GET" || req.method === "HEAD") && !isServerPath(req.url)) {
        return reply.type("text/html").sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}
