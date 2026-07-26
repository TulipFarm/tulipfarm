import type { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import type { A2uiSurfaceStore } from "./a2ui/artifact-surface";
import { registerActivityRoutes } from "./activity/routes";
import type { ActivityService } from "./activity/service";
import { type OperationalApiDeps, registerOperationalRoutes } from "./admin/routes";
import { DurableApprovalGate } from "./approvals/chat-gate";
import { registerApprovalRoutes } from "./approvals/routes";
import type { ApprovalsRepo } from "./approvals/runtime-repo";
import type { TokenRepo } from "./auth/api-tokens";
import { csrfHook, makeCsrfHook } from "./auth/csrf";
import { makeRequireAuth } from "./auth/middleware";
import { registerAuthRoutes } from "./auth/routes";
import type { SessionStore } from "./auth/session-store";
import type { UserRepo } from "./auth/users";
import type { ToolRegistry } from "./broker/tool-adapter";
import type { ConversationRepo } from "./chat/conversations";
import type { MessageRepo } from "./chat/messages";
import type { PendingInteractionRepo } from "./chat/pending-interactions";
import { registerChatRoutes } from "./chat/routes";
import { StreamHub } from "./chat/stream-hub";
import { MemoryStreamResumeRepo, type StreamResumeRepo } from "./chat/stream-resume";
import type { FeedbackRepo } from "./feedback/repo";
import { registerFeedbackRoutes } from "./feedback/routes";
import { type FormsRoutesDeps, registerFormRoutes } from "./forms/routes";
import type { GuardrailsService } from "./guardrails";
import type { HookExecutor } from "./hooks/hook-executor";
import { type HookIngressDeps, registerHookIngressRoutes } from "./hooks/routes";
import type { IdentityRouteDeps } from "./identity/routes";
import { type IngressRoutesDeps, registerIngressRoutes } from "./ingress/routes";
import { registerKnowledgeRoutes } from "./knowledge/routes";
import type { KnowledgeService } from "./knowledge/service";
import { registerKvRoutes } from "./kv/routes";
import type { KvService } from "./kv/service";
import { registerMemoryRoutes } from "./memory/routes";
import type { WorkingMemoryService } from "./memory/service";
import type { ObservabilityConfig } from "./observability/config";
import { registerObservabilityRoutes } from "./observability/routes";
import type { ObservabilityService } from "./observability/service";
import { registerOnboardingRoutes } from "./onboarding/routes";
import type { RateLimiter } from "./rate-limit";
import type { CounterStore, ResourceRepoFactory } from "./resources/repo";
import { registerResourceRoutes } from "./resources/routes";
import type { CanonicalRoutineAuthoringService } from "./routines/authoring";
import { registerRoutineAuthoringRoutes } from "./routines/authoring-routes";
import type { RoutineRoutesDeps } from "./routines/routes";
import { registerRoutineRoutes } from "./routines/routes";
import { type RunEventRouteDeps, registerRunEventRoutes } from "./runs/events";
import { type RunReplayDeps, registerRunReplayRoutes } from "./runs/replay";
import type { DurableInvocationGateway } from "./runtime/invocation-gateway";
import { registerSecretsRoutes } from "./secrets/routes";
import { registerSetupRoutes, registerSetupStatusRoute } from "./setup/routes";
import { isHeadlessBoot } from "./setup/service";
import { registerAgentRoutes } from "./soul/agents/routes";
import { makeLlmCascadeOnSecretDelete } from "./soul/llm-config/cascade";
import { registerLlmConfigRoutes } from "./soul/llm-config/routes";
import { registerResourceTypeRoutes } from "./soul/resource-types/routes";
import { registerSoulRoutes } from "./soul/routes";
import { registerSkillRoutes } from "./soul/skills/routes";
import { registerSystemRoutes, type SystemRoutesDeps } from "./system/routes";
import { buildToolRegistry } from "./tools/setup";
import { registerTriggerRoutes, type TriggerInvokeDeps } from "./triggers/routes";

export interface AppOptions {
  sessionStore?: SessionStore;
  userRepo?: UserRepo;
  tokenRepo?: TokenRepo;
  identity?: Omit<IdentityRouteDeps, "sessionStore" | "userRepo" | "ttlSeconds">;
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
  feedbackRepo?: FeedbackRepo;
  runEvents?: RunEventRouteDeps;
  runReplay?: RunReplayDeps;
  streamResumeRepo?: StreamResumeRepo;
  streamHub?: StreamHub;
  workingMemoryService?: WorkingMemoryService;
  kvService?: KvService;
  /** Caller-initiated invocation of manual / internal-API Triggers. */
  triggerInvoke?: TriggerInvokeDeps;
  /** Standalone and resumable governed form submissions. */
  forms?: FormsRoutesDeps;
  knowledgeService?: KnowledgeService;
  toolRegistry?: ToolRegistry;
  approvalRegistry?: DurableApprovalGate;
  guardrailsService?: GuardrailsService;
  pendingInteractionRepo?: PendingInteractionRepo;
  a2uiSurfaceStore?: A2uiSurfaceStore;
  activityService?: ActivityService;
  observabilityService?: ObservabilityService;
  observabilityConfig?: ObservabilityConfig;
  /** Routine engine surface (v0.11): registry + runs repo + trigger service + enqueuers. */
  routines?: RoutineRoutesDeps;
  /** Canonical proposal-only Routine authoring and simulation boundary. */
  routineAuthoring?: CanonicalRoutineAuthoringService;
  /** DB approvals store — enables routine_state approvals on the approvals routes. */
  approvalsRepo?: ApprovalsRepo;
  /** Integration ingress (v0.12): the generic /hooks/integrations/:name webhook receiver. */
  ingress?: IngressRoutesDeps;
  /** Trigger ingress: the canonical signed /hooks/:provider/:trigger webhook receiver. */
  hookIngress?: HookIngressDeps;
  /** System routes overrides (update-check fetch injection for tests). */
  systemRoutes?: SystemRoutesDeps;
  /** Authorized Phase 9 browser read models and server-side command authorities. */
  operationalApi?: OperationalApiDeps;
  /** Persist-first authority shared by Chat and every Trigger ingress. */
  invocations?: DurableInvocationGateway;
}

export async function buildApp(opts: AppOptions = {}) {
  // forceCloseConnections: destroy lingering keep-alive / SSE (chat stream) connections on close,
  // so `app.close()` frees the port immediately instead of hanging on an open EventSource.
  // maxParamLength: lift the find-my-way default (100) so path params like a memory `:key` (up to
  // MAX_KEY_CHARS=128) route instead of 404ing.
  const app = Fastify({ logger: true, forceCloseConnections: true, maxParamLength: 512 });

  // Single-image SPA serving (AC-010 / ARCH-V1-006): when the built web client is
  // bundled into the image, the Dockerfile sets WEB_DIST and Fastify serves it. Unset
  // in native `pnpm dev` (Vite serves the SPA), so this whole layer is inert there.
  const webDist = process.env.WEB_DIST;
  const serveSpa = !!webDist && existsSync(webDist);

  // Read the full CSP header value written by the Vite csp-hash plugin at build time.
  // Falls back to unsafe-inline only when the file is absent (e.g. local dev builds that
  // bypass the Vite build). In the shipped image the file is always present (SEC-V1-002).
  const spaCspHeader = (() => {
    if (!serveSpa || !webDist) return null;
    try {
      return readFileSync(join(webDist, ".csp-header.txt"), "utf8").trim();
    } catch {
      return null;
    }
  })();
  // Non-SPA surfaces keep their own handling: the API (JSON), the Scalar docs UI, the
  // OpenAPI doc, and the health probe. Everything else is a client-routed SPA path.
  const isAppApiPath = (url: string) =>
    url.startsWith("/api") ||
    url.startsWith("/docs") ||
    url.startsWith("/health") ||
    url.startsWith("/openapi");

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
    // Without explicit methods the preflight rejects PUT/DELETE — the write verbs the SPA uses for
    // secrets, resources, and config. Custom headers (CSRF echo + optimistic-concurrency If-Match).
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-csrf-token",
      "If-Match",
      "Idempotency-Key",
    ],
    // The chat SSE response carries these; the browser can only read them cross-origin if exposed.
    // X-Message-Id is the just-streamed reply's persisted id, so the client can attach feedback to it.
    exposedHeaders: ["X-Conversation-Id", "X-Stream-Id", "X-Message-Id", "X-Agent-Id", "X-Run-Id"],
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
    } else if (serveSpa && !isAppApiPath(req.url)) {
      // helmet's API-grade `default-src 'none'` would render the SPA blank. Relax CSP
      // for the app shell + its assets to a same-origin policy (INST-003c posture).
      // script-src uses build-time SHA-256 hashes (computed by the Vite csp-hash plugin)
      // so only the exact inline scripts Remix bakes into index.html are allowed (SEC-V1-002).
      reply.header(
        "content-security-policy",
        spaCspHeader ??
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
      );
    }
  });

  // CSRF is session-bound when a session store is available (a double-submit pair alone is not
  // sufficient); the stateless hook remains for deployments assembled without session auth.
  app.addHook("preHandler", opts.sessionStore ? makeCsrfHook(opts.sessionStore) : csrfHook);

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

  // Integration ingress is deliberately outside the session-auth block: the hook route carries
  // its own per-integration HMAC verification and must work without session deps (mirrors the
  // routines webhook posture — no session auth, no CSRF).
  if (opts.ingress) {
    await registerIngressRoutes(app, opts.ingress);
  }

  // Same posture as integration ingress: the Trigger hook route carries its own signature
  // verification and must work without any session dependency.
  if (opts.hookIngress) {
    await registerHookIngressRoutes(app, {
      ...opts.hookIngress,
      rateLimiter: opts.hookIngress.rateLimiter ?? opts.rateLimiter,
    });
  }

  if (opts.sessionStore && opts.userRepo && opts.tokenRepo) {
    registerAuthRoutes(app, opts.sessionStore, opts.userRepo, opts.tokenRepo, {
      rateLimiter: opts.rateLimiter,
      ...(opts.identity && { identity: opts.identity }),
    });
    const requireAuth = makeRequireAuth({
      store: opts.sessionStore,
      userRepo: opts.userRepo,
      tokenRepo: opts.tokenRepo,
      ...(opts.identity?.apiClientRepo && { apiClientRepo: opts.identity.apiClientRepo }),
    });
    // Setup status: always registered so the web app gets an explicit 200 in all boot modes.
    // In headless boot the wizard step routes below are absent (404), but status is always reachable.
    const soulPath = process.env.SOUL_PATH;
    if (soulPath) {
      registerSetupStatusRoute(app, {
        userRepo: opts.userRepo,
        soulPath,
        rateLimiter: opts.rateLimiter,
      });
    }
    // Wizard step routes: only registered when NOT in headless boot (AC-005).
    if (!isHeadlessBoot() && opts.secretsService && opts.gitSync && soulPath) {
      registerSetupRoutes(app, {
        userRepo: opts.userRepo,
        sessionStore: opts.sessionStore,
        secretsService: opts.secretsService,
        gitSync: opts.gitSync,
        soulPath,
        requireAuth,
      });
    }
    if (opts.secretsService) {
      registerSecretsRoutes(app, opts.secretsService, requireAuth, {
        onSecretDeleted:
          opts.soulLoader && opts.gitSync && opts.llmService
            ? makeLlmCascadeOnSecretDelete(
                opts.soulLoader,
                opts.gitSync,
                opts.llmService,
                opts.secretsService,
                app.log
              )
            : undefined,
      });
    }
    if (opts.triggerInvoke) {
      registerTriggerRoutes(app, opts.triggerInvoke, requireAuth, opts.rateLimiter);
    }
    if (opts.forms) {
      registerFormRoutes(app, opts.forms, requireAuth);
    }
    if (opts.routineAuthoring) {
      registerRoutineAuthoringRoutes(app, opts.routineAuthoring, requireAuth);
    }

    if (opts.kvService) {
      registerKvRoutes(app, opts.kvService, requireAuth);
    }
    registerSystemRoutes(app, { kv: opts.kvService, ...opts.systemRoutes }, requireAuth);
    if (opts.activityService) {
      registerActivityRoutes(app, opts.activityService, requireAuth);
    }
    if (opts.workingMemoryService) {
      registerMemoryRoutes(app, opts.workingMemoryService, requireAuth);
    }
    if (opts.observabilityService) {
      registerObservabilityRoutes(
        app,
        opts.observabilityService,
        requireAuth,
        opts.observabilityConfig
      );
    }
    if (opts.gitSync) {
      registerSoulRoutes(app, opts.gitSync, requireAuth, opts.secretsService);
      if (opts.soulLoader) {
        registerResourceTypeRoutes(
          app,
          opts.gitSync,
          opts.soulLoader,
          requireAuth,
          opts.reconcileResources,
          opts.rateLimiter
        );
        registerAgentRoutes(app, opts.soulLoader, requireAuth);
        const knowledgeService = opts.knowledgeService;
        registerOnboardingRoutes(app, opts.soulLoader, requireAuth, {
          kvService: opts.kvService,
          llmService: opts.llmService,
          hasAnyKnowledgePage: knowledgeService
            ? () => knowledgeService.hasAnyKnowledgePage()
            : undefined,
        });
        if (opts.llmService) {
          registerSkillRoutes(
            app,
            opts.soulLoader,
            opts.gitSync,
            opts.llmService,
            requireAuth,
            opts.activityService
          );
          if (opts.secretsService) {
            registerLlmConfigRoutes(
              app,
              opts.soulLoader,
              opts.gitSync,
              opts.llmService,
              opts.secretsService,
              requireAuth
            );
          }
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
          kv: opts.kvService,
          knowledge: opts.knowledgeService,
        });
      const approvalRegistry = opts.approvalRegistry ?? new DurableApprovalGate();
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
        toolRegistry,
        approvalRegistry,
        opts.guardrailsService,
        opts.pendingInteractionRepo,
        opts.a2uiSurfaceStore,
        opts.invocations
      );
      registerApprovalRoutes(
        app,
        approvalRegistry,
        requireAuth,
        opts.approvalsRepo && opts.routines
          ? {
              approvalsRepo: opts.approvalsRepo,
              enqueueWake: (job) => {
                if (!opts.routines) return Promise.resolve();
                return opts.routines.enqueuers.enqueueWake(job);
              },
            }
          : undefined
      );
    }
    if (opts.runEvents) {
      registerRunEventRoutes(app, opts.runEvents, requireAuth, opts.rateLimiter);
    }
    if (opts.runReplay) {
      registerRunReplayRoutes(app, opts.runReplay, requireAuth, opts.rateLimiter);
    }
    if (opts.operationalApi) {
      registerOperationalRoutes(app, opts.operationalApi, requireAuth, opts.rateLimiter);
    }
    if (opts.feedbackRepo) {
      registerFeedbackRoutes(app, opts.feedbackRepo, requireAuth);
    }
    if (opts.routines) {
      registerRoutineRoutes(app, opts.routines, requireAuth);
    }
    // The retrieval spine is optional — only the page-search branch needs it (index.ts wires it in
    // prod). Knowledge routes register whenever the service is present; page mode degrades to chunk
    // search if the spine is absent, rather than dropping the whole knowledge surface.
    if (opts.knowledgeService) {
      registerKnowledgeRoutes(
        app,
        opts.knowledgeService,
        requireAuth,
        undefined,
        opts.activityService
      );
    }
  }

  // SPA last, so it never shadows an API/docs/health route. `wildcard: false` serves
  // only real files (index.html, /assets/*, favicon) and lets unknown paths fall
  // through to the not-found handler below — which returns the SPA shell for client
  // routes and a JSON 404 for the API.
  if (serveSpa && webDist) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if ((req.method === "GET" || req.method === "HEAD") && !isAppApiPath(req.url)) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not Found" });
    });
  }

  return app;
}
