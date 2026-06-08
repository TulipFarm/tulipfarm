import type { EventEmitter } from "node:events";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
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
import { registerResourceTypeRoutes } from "./soul/resource-types/routes";
import { registerSoulRoutes } from "./soul/routes";
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

  await app.register(helmet, {
    contentSecurityPolicy: {
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
  }

  return app;
}
