import type { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import scalar from "@scalar/fastify-api-reference";
import type { GuardrailsService } from "@tulipfarm/agent-runtime";
import type { LlmService } from "@tulipfarm/llm";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import type { HookExecutor } from "@tulipfarm/sandbox";
import type { SecretsService } from "@tulipfarm/secrets";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import type { IntegrationStore } from "@tulipfarm/storage";
import Fastify, { type FastifyBaseLogger, type FastifyReply, type FastifyRequest } from "fastify";
import { registerActivityRoutes } from "./activity/routes";
import type { ActivityService } from "./activity/service";
import { postgresProbe, probeHealth, type QueryableProbeTarget } from "./admin/health";
import { type OperationalApiDeps, registerOperationalRoutes } from "./admin/routes";
import { registerApprovalRoutes } from "./approvals/routes";
import type { RoutineApprovalService } from "./approvals/routine-approvals";
import type { ApprovalsRepo } from "./approvals/runtime-repo";
import type { ToolApprovalService } from "./approvals/tool-approvals";
import type { TokenRepo } from "./auth/api-tokens";
import { csrfHook, makeCsrfHook } from "./auth/csrf";
import type { UserInviteRepo } from "./auth/invites";
import { makeRequireAuth } from "./auth/middleware";
import { registerAuthRoutes } from "./auth/routes";
import type { SessionStore } from "./auth/session-store";
import type { PasswordWriteRepo, ProfileWriteRepo, UserAdminRepo, UserRepo } from "./auth/users";
import type { ToolRegistry } from "./broker/tool-adapter";
import { registerConversationRoutes } from "./chat/conversation-routes";
import type { ConversationRepo } from "./chat/conversations";
import type { MessageRepo } from "./chat/messages";
import { type ChatRunCanceller, registerChatRoutes } from "./chat/routes";
import type { ConversationStore } from "./conversations/service";
import type { FeedbackRepo } from "./feedback/repo";
import { registerFeedbackRoutes } from "./feedback/routes";
import { type FormsRoutesDeps, registerFormRoutes } from "./forms/routes";
import { type HookIngressDeps, registerHookIngressRoutes } from "./hooks/routes";
import type { IdentityRouteDeps } from "./identity/routes";
import { type IngressRoutesDeps, registerIngressRoutes } from "./ingress/routes";
import { type IntegrationAuthRequestRepo, resolveAuthEndpoints } from "./integrations/auth-broker";
import { registerIntegrationAuthRoutes } from "./integrations/auth-routes";
import { ensureGitHubInstallation } from "./integrations/github-install";
import {
  type GitHubInstallDeps,
  registerGitHubInstallRoutes,
} from "./integrations/github-install-routes";
import { registerIntegrationMarketplaceRoutes } from "./integrations/marketplace-routes";
import { registerIntegrationRoutes } from "./integrations/routes";
import {
  ensureDefaultSlackRoute,
  registerSlackBindRoute,
  type SlackBindDeps,
} from "./integrations/slack-binding";
import {
  type ChannelInternalRouteDeps,
  registerChannelInternalRoutes,
} from "./internal/channel-routes";
import { type InternalTurnRouteDeps, registerInternalTurnRoutes } from "./internal/routes";
import { registerSurfaceInternalRoutes } from "./internal/surfaces-routes";
import { registerKnowledgeRoutes } from "./knowledge/routes";
import type { KnowledgeService } from "./knowledge/service";
import { registerKvRoutes } from "./kv/routes";
import type { KvService } from "./kv/service";
import type { MemoryExtractionService } from "./memory/extraction-service";
import type { MemoryLifecycleService } from "./memory/lifecycle-service";
import { registerMemoryRoutes } from "./memory/routes";
import type { MemoryService } from "./memory/service";
import type { ObservabilityConfig } from "./observability/config";
import { registerObservabilityRoutes } from "./observability/routes";
import type { ObservabilityService } from "./observability/service";
import { registerOnboardingRoutes } from "./onboarding/routes";
import { registerPreferenceRoutes } from "./preferences/routes";
import type { RateLimiter } from "./rate-limit";
import type { CounterStore, ResourceRepoFactory } from "./resources/repo";
import { registerResourceRoutes } from "./resources/routes";
import type { CanonicalRoutineAuthoringService } from "./routines/authoring";
import { registerRoutineAuthoringRoutes } from "./routines/authoring-routes";
import type { RoutineCatalog } from "./routines/catalog";
import { registerRoutineCatalogRoutes } from "./routines/catalog-routes";
import { type RunEventRouteDeps, registerRunEventRoutes } from "./runs/events";
import { type RunReplayDeps, registerRunReplayRoutes } from "./runs/replay";
import { registerSecretsRoutes } from "./secrets/routes";
import { registerSetupRoutes, registerSetupStatusRoute } from "./setup/routes";
import { isHeadlessBoot } from "./setup/service";
import { registerAgentRoutes } from "./soul/agents/routes";
import type { BundledIntegration } from "./soul/integrations/bundled";
import { makeLlmCascadeOnSecretDelete } from "./soul/llm-config/cascade";
import { registerLlmConfigRoutes } from "./soul/llm-config/routes";
import { registerResourceTypeRoutes } from "./soul/resource-types/routes";
import { registerSoulRoutes } from "./soul/routes";
import type { BundledSkill } from "./soul/skills/bundled";
import { registerSkillRoutes } from "./soul/skills/routes";
import { MemorySurfaceActionStore, type SurfaceActionStore } from "./surfaces/action-store";
import { MemorySurfaceArtifactStore, type SurfaceArtifactStore } from "./surfaces/artifact-store";
import { registerSurfaceRoutes } from "./surfaces/routes";
import { registerSystemRoutes, type SystemRoutesDeps } from "./system/routes";
import { buildToolRegistry } from "./tools/setup";
import { registerTriggerRoutes, type TriggerInvokeDeps } from "./triggers/routes";

export interface AppOptions {
  sessionStore?: SessionStore;
  userRepo?: UserRepo;
  userAdminRepo?: UserAdminRepo;
  passwordWriteRepo?: PasswordWriteRepo;
  profileWriteRepo?: ProfileWriteRepo;
  userInviteRepo?: UserInviteRepo;
  tokenRepo?: TokenRepo;
  identity?: Omit<IdentityRouteDeps, "sessionStore" | "userRepo" | "ttlSeconds">;
  rateLimiter?: RateLimiter;
  secretsService?: SecretsService;
  gitSync?: GitSyncService;
  soulLoader?: SoulLoader;
  bundledSkills?: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills?: Set<string>;
  bundledIntegrations?: ReadonlyMap<string, BundledIntegration>;
  /** Slack -> Agent routing-table bind route. Requires the Channel integration store + business id. */
  slackBind?: {
    integrations: IntegrationStore;
    businessId: string;
    /** Test-only override for the live Slack auth.test call. */
    verifyBotToken?: SlackBindDeps["verifyBotToken"];
  };
  /** GitHub App install flow. Requires the Channel integration store + business id. */
  githubInstall?: Pick<
    GitHubInstallDeps,
    "integrations" | "secretsService" | "businessId" | "http" | "soulRepositories"
  >;
  /** Live GitHub-install check backing per-turn tool visibility on the conversation debug route. */
  githubStatus?: { integrations: IntegrationStore; businessId: string };
  /**
   * Generic Integration auth broker. Absent in tests that never exercise a provider round trip;
   * `fetchImpl` lets those that do avoid real network calls.
   */
  integrationAuth?: {
    repo: IntegrationAuthRequestRepo;
    fetchImpl?: typeof globalThis.fetch;
  };
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
  memoryService?: MemoryService;
  /** Enables the Memory confirmation queue. Absent leaves `/api/v1/memory/pending` unregistered. */
  memoryExtractionService?: MemoryExtractionService;
  /** Enables procedural correction, forget-by-Assertion, and hard erasure routes. */
  memoryLifecycleService?: MemoryLifecycleService;
  kvService?: KvService;
  /** Caller-initiated invocation of manual / internal-API Triggers. */
  triggerInvoke?: TriggerInvokeDeps;
  /** Standalone and resumable governed form submissions. */
  forms?: FormsRoutesDeps;
  knowledgeService?: KnowledgeService;
  toolRegistry?: ToolRegistry;
  /**
   * Reconciles manifest-declared egress Tools against `toolRegistry` when an integration connects,
   * disconnects, or is removed. Composed in `index.ts`, where the effect ledger and secrets service
   * live; absent in tests that never exercise integration Tools.
   */
  declarativeTools?: { sync: () => number; countFor: (slug: string) => number };
  guardrailsService?: GuardrailsService;
  surfaceArtifactStore?: SurfaceArtifactStore;
  surfaceActionStore?: SurfaceActionStore;
  activityService?: ActivityService;
  observabilityService?: ObservabilityService;
  observabilityConfig?: ObservabilityConfig;
  /** Canonical proposal-only Routine authoring and simulation boundary. */
  routineAuthoring?: CanonicalRoutineAuthoringService;
  /** Published Routine browser catalogue from the verified active bundle. */
  routineCatalog?: RoutineCatalog;
  /** DB approvals store — enables routine_state approvals on the approvals routes. */
  approvalsRepo?: ApprovalsRepo;
  routineApprovals?: RoutineApprovalService;
  /** Tool approvals as durable kernel waits — a decision signals the wait its Run parked on. */
  toolApprovals?: ToolApprovalService;
  /**
   * What `apps/integration-worker` calls back into for the Channel ports it cannot implement
   * locally (identity resolution, Run minting, reply reading, approval decisions). Built per-app
   * rather than eagerly because identity resolution logs through Fastify's logger, which does not
   * exist until `buildApp` has run.
   */
  channels?(log: FastifyBaseLogger): ChannelInternalRouteDeps;
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
  /**
   * Durable Turns for Chat submissions. Required alongside `invocations` — a Run whose request was
   * never recorded as a Turn is not reconstructable, so the chat routes refuse the half-wired pair.
   */
  conversationStore?: ConversationStore;
  /**
   * Stops a Run a chat participant abandoned. Absent means the stop control reports 503 rather than
   * pretending a turn was halted.
   */
  runCancel?: ChatRunCanceller;
  /**
   * The turn machinery the Worker calls back into while it cannot import this app. Service
   * principals only; PR 4 moves the implementations into the Worker and this surface goes away.
   */
  internalTurns?: InternalTurnRouteDeps;
  /**
   * Datastore handle backing `/readyz`. Absent (tests, partial assemblies) means readiness
   * reports ok on process liveness alone.
   */
  readiness?: QueryableProbeTarget;
}

export async function buildApp(opts: AppOptions = {}) {
  // forceCloseConnections: destroy lingering keep-alive / SSE (chat stream) connections on close,
  // so `app.close()` frees the port immediately instead of hanging on an open EventSource.
  // maxParamLength: lift the find-my-way default (100) so path params like a memory `:key` (up to
  // MAX_KEY_CHARS=128) route instead of 404ing.
  const app = Fastify({ logger: true, forceCloseConnections: true, maxParamLength: 512 });

  // Single-image SPA serving: when the built web client is
  // bundled into the image, the Dockerfile sets WEB_DIST and Fastify serves it. Unset
  // in native `pnpm dev` (Vite serves the SPA), so this whole layer is inert there.
  const webDist = process.env.WEB_DIST;
  const serveSpa = !!webDist;
  if (serveSpa && webDist && !existsSync(webDist)) {
    throw new Error(`WEB_DIST does not exist: ${webDist}`);
  }

  // Read and validate the full CSP header value written after the complete production web build.
  // A served production bundle without this artifact is a startup error (SEC-V1-002).
  const spaCspHeader = (() => {
    if (!serveSpa || !webDist) return null;
    const cspPath = join(webDist, ".csp-header.txt");
    try {
      const header = readFileSync(cspPath, "utf8").trim();
      const scriptSrc = header.match(/(?:^|;)\s*script-src\s+([^;]+)/)?.[1] ?? "";
      if (
        !header ||
        !scriptSrc.includes("'self'") ||
        !scriptSrc.includes("'unsafe-eval'") ||
        !/'sha256-[^']+'/.test(scriptSrc) ||
        scriptSrc.includes("'unsafe-inline'")
      ) {
        throw new Error("CSP artifact is missing required hash-based script-src directives");
      }
      return header;
    } catch (error) {
      throw new Error(
        `WEB_DIST is enabled but ${cspPath} is missing or invalid; run the production web build`,
        { cause: error }
      );
    }
  })();
  // Non-SPA surfaces keep their own handling: the API (JSON), the Scalar docs UI, the
  // OpenAPI doc, and the health probes. Everything else is a client-routed SPA path.
  const isAppApiPath = (url: string) =>
    url.startsWith("/api") ||
    url.startsWith("/docs") ||
    url.startsWith("/health") ||
    url.startsWith("/livez") ||
    url.startsWith("/readyz") ||
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
    // PUBLIC_URL is the origin users actually reach in a deployed install; CORS_ORIGIN stays an
    // independent override for split-origin setups. The localhost fallback is the dev SPA.
    origin:
      process.env.CORS_ORIGIN ??
      process.env.PUBLIC_URL ??
      `http://localhost:${process.env.VITE_PORT ?? 4000}`,
    credentials: true,
    // Without explicit methods the preflight rejects PUT/DELETE — the write verbs the SPA uses for
    // secrets, resources, and config. Custom headers (CSRF echo + optimistic-concurrency If-Match).
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
  // Scoped to known CDN origins — never wildcard — so an XSS in Scalar cannot
  // load arbitrary external scripts (SEC-AUDIT H-1).
  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/docs")) {
      reply.header(
        "content-security-policy",
        [
          "default-src 'self'",
          "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
          "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
          "img-src 'self' data: https://cdn.jsdelivr.net",
          "font-src 'self' data: https://cdn.jsdelivr.net",
          "connect-src 'self'",
          "frame-ancestors 'none'",
        ].join("; ")
      );
    } else if (serveSpa && !isAppApiPath(req.url)) {
      // helmet's API-grade `default-src 'none'` would render the SPA blank. Relax CSP
      // for the app shell + its assets to a same-origin policy.
      // script-src uses build-time SHA-256 hashes from the completed web build
      // so only the exact inline scripts Remix bakes into index.html are allowed (SEC-V1-002).
      if (!spaCspHeader) throw new Error("SPA CSP header is unavailable while serving WEB_DIST");
      reply.header("content-security-policy", spaCspHeader);
    }
  });

  // CSRF is session-bound when a session store is available (a double-submit pair alone is not
  // sufficient); the stateless hook remains for deployments assembled without session auth.
  app.addHook("preHandler", opts.sessionStore ? makeCsrfHook(opts.sessionStore) : csrfHook);

  // Kubernetes-shaped probe trio. Liveness must never consult a dependency — a Postgres
  // outage should not make the orchestrator kill and restart an otherwise-fine process.
  // Readiness does, so an instance that cannot reach its datastore is pulled out of the
  // load balancer instead of serving errors.
  //
  // Migration completion needs no explicit signal: `index.ts` runs `runPgMigrations` before
  // `buildApp`, and the server does not listen until that resolves, so anything able to
  // answer these routes at all is already migrated.
  const probeStatusSchema = {
    type: "object",
    properties: { status: { type: "string" } },
    required: ["status"],
  } as const;

  app.get(
    "/livez",
    {
      schema: {
        description: "Liveness probe — the process is running. Checks no dependencies.",
        tags: ["system"],
        response: { 200: probeStatusSchema },
      },
    },
    async () => ({ status: "ok" })
  );

  const readyHandler = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!opts.readiness) return { status: "ok" };
    const [postgres] = await probeHealth([postgresProbe(opts.readiness)]);
    if (postgres.status === "ok") return { status: "ok" };
    return reply.code(503).send({ status: postgres.status, detail: postgres.detail });
  };

  const readySchema = {
    description: "Readiness probe — the datastore is reachable and this instance can serve.",
    tags: ["system"],
    response: {
      200: probeStatusSchema,
      503: {
        type: "object",
        properties: { status: { type: "string" }, detail: { type: "string" } },
        required: ["status"],
      },
    },
  } as const;

  app.get("/readyz", { schema: readySchema }, readyHandler);
  // Retained alias: the installer's health poll, the compose healthcheck, and every published
  // doc reference /health. It tracks readiness, which is what those callers actually mean.
  app.get(
    "/health",
    { schema: { ...readySchema, description: "Alias of /readyz." } },
    readyHandler
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
      ...(opts.userAdminRepo && { userAdminRepo: opts.userAdminRepo }),
      ...(opts.passwordWriteRepo && { passwordWriteRepo: opts.passwordWriteRepo }),
      ...(opts.profileWriteRepo && { profileWriteRepo: opts.profileWriteRepo }),
      ...(opts.userInviteRepo && { inviteRepo: opts.userInviteRepo }),
    });
    const requireAuth = makeRequireAuth({
      store: opts.sessionStore,
      userRepo: opts.userRepo,
      tokenRepo: opts.tokenRepo,
      ...(opts.identity?.apiClientRepo && { apiClientRepo: opts.identity.apiClientRepo }),
    });
    // Setup status: always registered so the web app gets an explicit 200 in all boot modes. Read
    // off `gitSync.path` (not `process.env.SOUL_PATH`) so this keeps working once boot resolves a
    // per-business path under `SOUL_ROOT` instead of the legacy flat `SOUL_PATH`.
    // In headless boot the wizard step routes below are absent (404), but status is always reachable.
    const soulPath = opts.gitSync?.path;
    if (soulPath) {
      registerSetupStatusRoute(app, {
        userRepo: opts.userRepo,
        soulPath,
        rateLimiter: opts.rateLimiter,
      });
    }
    // Wizard step routes: only registered when NOT in headless boot.
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
    if (opts.routineCatalog) {
      registerRoutineCatalogRoutes(app, opts.routineCatalog, requireAuth);
    }

    if (opts.kvService) {
      registerKvRoutes(app, opts.kvService, requireAuth);
      registerPreferenceRoutes(app, opts.kvService, requireAuth);
    }
    registerSystemRoutes(app, { kv: opts.kvService, ...opts.systemRoutes }, requireAuth);
    if (opts.activityService) {
      registerActivityRoutes(app, opts.activityService, requireAuth);
    }
    if (opts.memoryService) {
      registerMemoryRoutes(
        app,
        opts.memoryService,
        requireAuth,
        opts.memoryExtractionService,
        opts.memoryLifecycleService
      );
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
        if (opts.secretsService) {
          const soulLoader = opts.soulLoader;
          const slackBindDeps: SlackBindDeps | undefined = opts.slackBind
            ? {
                soulLoader: opts.soulLoader,
                secretsService: opts.secretsService,
                integrations: opts.slackBind.integrations,
                businessId: opts.slackBind.businessId,
                verifyBotToken: opts.slackBind.verifyBotToken,
                requireAuth,
              }
            : undefined;
          // Shared by the connect route and the auth broker's callback: an integration is wired the
          // same way whether its credentials were pasted or came back from a provider redirect.
          const onConnected = async (name: string) => {
            // Manifest-declared Tools become callable the moment credentials land, whichever way
            // they arrived — a paste or an OAuth redirect. Runs first so a provider-specific step
            // below cannot leave an integration connected but toolless.
            opts.declarativeTools?.sync();
            if (name === "slack" && slackBindDeps) {
              await ensureDefaultSlackRoute(slackBindDeps);
            }
            if (name === "github" && opts.githubInstall) {
              // Written by the manifest's `install` step; without it there is no installation to
              // record, which is the pre-install state rather than a failure.
              const installationId =
                soulLoader.integrations.get("github")?.connection?.env?.GITHUB_INSTALLATION_ID;
              if (installationId) {
                await ensureGitHubInstallation(
                  {
                    integrations: opts.githubInstall.integrations,
                    secretsService: opts.githubInstall.secretsService,
                    businessId: opts.githubInstall.businessId,
                    http: opts.githubInstall.http,
                    log: app.log,
                  },
                  installationId
                );
              }
            }
          };
          registerIntegrationRoutes(
            app,
            opts.soulLoader,
            opts.gitSync,
            opts.secretsService,
            opts.bundledIntegrations ?? new Map(),
            requireAuth,
            onConnected,
            opts.githubInstall
              ? {
                  integrations: opts.githubInstall.integrations,
                  businessId: opts.githubInstall.businessId,
                }
              : undefined,
            opts.declarativeTools
          );
          registerIntegrationMarketplaceRoutes(
            app,
            opts.soulLoader,
            opts.gitSync,
            opts.bundledIntegrations ?? new Map(),
            requireAuth
          );
          if (slackBindDeps) {
            registerSlackBindRoute(app, slackBindDeps);
          }
          if (opts.integrationAuth && opts.secretsService) {
            registerIntegrationAuthRoutes(
              app,
              {
                soulLoader: opts.soulLoader,
                gitSync: opts.gitSync,
                secrets: opts.secretsService,
                repo: opts.integrationAuth.repo,
                bundled: opts.bundledIntegrations ?? new Map(),
                endpoints: resolveAuthEndpoints(),
                fetchImpl: opts.integrationAuth.fetchImpl,
                onConnected,
              },
              requireAuth
            );
          }
        }
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
            opts.activityService,
            opts.bundledSkills,
            opts.disabledBundledSkills
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
    if (opts.githubInstall) {
      registerGitHubInstallRoutes(app, {
        integrations: opts.githubInstall.integrations,
        secretsService: opts.githubInstall.secretsService,
        businessId: opts.githubInstall.businessId,
        http: opts.githubInstall.http,
        soulRepositories: opts.githubInstall.soulRepositories,
        requireAuth,
      });
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
      const surfaceArtifactStore = opts.surfaceArtifactStore ?? new MemorySurfaceArtifactStore();
      const surfaceActionStore = opts.surfaceActionStore ?? new MemorySurfaceActionStore();
      const toolRegistry =
        opts.toolRegistry ??
        buildToolRegistry({
          memory: opts.memoryService,
          ...(opts.memoryLifecycleService === undefined
            ? {}
            : { memoryLifecycle: opts.memoryLifecycleService }),
          kv: opts.kvService,
          knowledge: opts.knowledgeService,
        });
      registerConversationRoutes(
        app,
        {
          repo: opts.conversationRepo,
          messageRepo: opts.messageRepo,
          memory: opts.memoryService,
          knowledge: opts.knowledgeService,
          soulLoader: opts.soulLoader,
          toolRegistry,
          bundledSkills: opts.bundledSkills,
          disabledBundledSkills: opts.disabledBundledSkills,
          githubStatus: opts.githubStatus,
        },
        requireAuth
      );
      // Submitting a turn needs the durable trio: the Run, the Turn it answers, and the event stream
      // it is read back from. A half-composed assembly serves conversation history but refuses to
      // start a turn it could not reconstruct — it never falls back to running one in this process.
      if (opts.invocations && opts.conversationStore && opts.runEvents) {
        registerChatRoutes(
          app,
          {
            llmService: opts.llmService,
            repo: opts.conversationRepo,
            conversationStore: opts.conversationStore,
            invocations: opts.invocations,
            stream: opts.runEvents,
            ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
            ...(opts.runCancel ? { cancel: opts.runCancel } : {}),
            ...(opts.soulLoader ? { soulLoader: opts.soulLoader } : {}),
            ...(opts.domainEventEmitter ? { events: opts.domainEventEmitter } : {}),
          },
          requireAuth
        );
      }
      registerSurfaceRoutes(
        app,
        surfaceArtifactStore,
        surfaceActionStore,
        requireAuth,
        opts.domainEventEmitter,
        opts.guardrailsService,
        opts.soulLoader
      );
    }
    if (opts.approvalsRepo) {
      registerApprovalRoutes(
        app,
        {
          approvals: opts.approvalsRepo,
          ...(opts.toolApprovals ? { toolApprovals: opts.toolApprovals } : {}),
          ...(opts.routineApprovals ? { routineApprovals: opts.routineApprovals } : {}),
        },
        requireAuth
      );
    }
    if (opts.runEvents) {
      registerRunEventRoutes(app, opts.runEvents, requireAuth, opts.rateLimiter);
    }
    if (opts.internalTurns) {
      registerInternalTurnRoutes(app, opts.internalTurns, requireAuth);
    }
    if (opts.channels) {
      const channelDeps = opts.channels(app.log);
      registerChannelInternalRoutes(app, channelDeps, requireAuth);
      if (channelDeps.surfaceActionStore) {
        registerSurfaceInternalRoutes(
          app,
          {
            identity: channelDeps.identity,
            actions: channelDeps.surfaceActionStore,
            store: channelDeps.store,
            invocations: channelDeps.invocations,
            runDeliveries: channelDeps.runDeliveries,
            ...(opts.guardrailsService ? { guardrails: opts.guardrailsService } : {}),
          },
          requireAuth
        );
      }
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
