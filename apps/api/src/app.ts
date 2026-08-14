import type { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import scalar from "@scalar/fastify-api-reference";
import type { GuardrailsService } from "@tulipfarm/agent-runtime";
import type { LlmService } from "@tulipfarm/llm";
import type { BatchingLogSink } from "@tulipfarm/observability";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import type { HookExecutor } from "@tulipfarm/sandbox";
import type { SecretsService } from "@tulipfarm/secrets";
import type { GitSyncService, SoulLoader, SoulWriter } from "@tulipfarm/soul";
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
import type { AuditReadService } from "./audit/read-service";
import { registerAuditRoutes } from "./audit/routes";
import type { AuditService } from "./audit/service";
import { makeSoulAuditWriter } from "./audit/soul-write";
import type { TokenRepo } from "./auth/api-tokens";
import { csrfHook, makeCsrfHook } from "./auth/csrf";
import type { UserInviteRepo } from "./auth/invites";
import { makeRequireAuth } from "./auth/middleware";
import { registerAuthRoutes } from "./auth/routes";
import type { SessionStore } from "./auth/session-store";
import type { PasswordWriteRepo, ProfileWriteRepo, UserAdminRepo, UserRepo } from "./auth/users";
import { buildCapabilityCatalog } from "./authz/capabilities";
import { registerAuthzRoutes } from "./authz/routes";
import type { AuthzAdminService } from "./authz/service";
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
import type { PrincipalProviderTokenRepo } from "./integrations/principal-tokens";
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
import { registerKillSwitchRoutes } from "./kill-switches/routes";
import type { KillSwitchService } from "./kill-switches/service";
import { registerKnowledgeRoutes } from "./knowledge/routes";
import type { KnowledgeService } from "./knowledge/service";
import { registerKvRoutes } from "./kv/routes";
import type { KvService } from "./kv/service";
import type { MemoryExtractionService } from "./memory/extraction-service";
import type { MemoryLifecycleService } from "./memory/lifecycle-service";
import { registerMemoryRoutes } from "./memory/routes";
import type { MemoryService } from "./memory/service";
import type { ObservabilityConfig } from "./observability/config";
import type { LogRepo } from "./observability/log-repo";
import { createLogTeeStream } from "./observability/log-stream";
import type { ResourceRepo } from "./observability/resource-repo";
import { registerObservabilityRoutes } from "./observability/routes";
import type { ObservabilityService } from "./observability/service";
import { registerOnboardingRoutes } from "./onboarding/routes";
import { registerPreferenceRoutes } from "./preferences/routes";
import type { RateLimiter } from "./rate-limit";
import type { RecordAuthorizer } from "./resources/authorize";
import type { CounterStore, ResourceRepoFactory } from "./resources/repo";
import { registerResourceRoutes } from "./resources/routes";
import type { CanonicalRoutineAuthoringService } from "./routines/authoring";
import { registerRoutineAuthoringRoutes } from "./routines/authoring-routes";
import type { RoutineCatalog } from "./routines/catalog";
import { registerRoutineCatalogRoutes } from "./routines/catalog-routes";
import { type RunEventRouteDeps, registerRunEventRoutes } from "./runs/events";
import { type RunReplayDeps, registerRunReplayRoutes } from "./runs/replay";
import { registerSecretsRoutes } from "./secrets/routes";
import type { SetupAdminCreator } from "./setup/first-admin";
import { registerSetupRoutes, registerSetupStatusRoute } from "./setup/routes";
import { isHeadlessBoot } from "./setup/service";
import { registerAgentRoutes } from "./soul/agents/routes";
import type { BundledIntegration } from "./soul/integrations/bundled";
import { makeLlmCascadeOnSecretDelete } from "./soul/llm-config/cascade";
import { registerLlmConfigRoutes } from "./soul/llm-config/routes";
import { registerResourceTypeRoutes } from "./soul/resource-types/routes";
import { registerAccessLevelRoutes } from "./soul/roles/routes";
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
  setupAdminCreator?: SetupAdminCreator;
  gitSync?: GitSyncService;
  /**
   * The ADR-007 write gateway. Every authoring surface writes the Soul tree through this; a route
   * that reaches for `fs` plus `gitSync.withSync` instead bypasses validation, atomicity, conflict
   * detection and bundle publication at once.
   */
  soulWriter?: SoulWriter;
  soulLoader?: SoulLoader;
  bundledSkills?: ReadonlyMap<string, BundledSkill>;
  disabledBundledSkills?: Set<string>;
  bundledIntegrations?: ReadonlyMap<string, BundledIntegration>;
  slackBind?: {
    integrations: IntegrationStore;
    businessId: string;
    verifyBotToken?: SlackBindDeps["verifyBotToken"];
  };
  githubInstall?: Pick<
    GitHubInstallDeps,
    "integrations" | "secretsService" | "businessId" | "http" | "soulRepositories"
  >;
  githubStatus?: { integrations: IntegrationStore; businessId: string };
  /**
   * Generic Integration auth broker. Absent in tests that never exercise a provider round trip;
   * `fetchImpl` lets those that do avoid real network calls.
   */
  integrationAuth?: {
    repo: IntegrationAuthRequestRepo;
    fetchImpl?: typeof globalThis.fetch;
    /**
     * Where a *personal* provider credential is sealed (D7). Absent means this deployment cannot
     * hold them and a user-scoped connect is refused — which must stay in step with
     * `CredentialResolver`, or a Tool will deny a call for want of a credential and point the
     * person at a connect flow that cannot issue one.
     */
    tokens: PrincipalProviderTokenRepo | undefined;
  };
  hookExecutor?: HookExecutor;
  resourceRepoFactory?: ResourceRepoFactory;
  counterStore?: CounterStore;
  /**
   * Decides record authority for the REST record routes. Absent leaves them authenticated-only,
   * which is what every test and the pre-authorization boot path want; production wires it.
   */
  recordAuthorizer?: RecordAuthorizer;
  reconcileResources?: () => Promise<void>;
  /**
   * Projects authored Soul Roles into durable rows. Wired alongside `gitSync` + `toolRegistry` to
   * enable the access-level authoring routes; absent leaves them unregistered, so a deployment
   * without a Soul repository cannot be asked to write one.
   */
  reconcileSoulRoles?: () => Promise<void>;
  domainEventEmitter?: EventEmitter;
  llmService?: LlmService;
  conversationRepo?: ConversationRepo;
  messageRepo?: MessageRepo;
  feedbackRepo?: FeedbackRepo;
  runEvents?: RunEventRouteDeps;
  runReplay?: RunReplayDeps;
  memoryService?: MemoryService;
  memoryExtractionService?: MemoryExtractionService;
  memoryLifecycleService?: MemoryLifecycleService;
  kvService?: KvService;
  triggerInvoke?: TriggerInvokeDeps;
  forms?: FormsRoutesDeps;
  knowledgeService?: KnowledgeService;
  toolRegistry?: ToolRegistry;
  /**
   * Composed in `index.ts`, where the effect ledger and secrets service live; absent in tests that
   * never exercise integration Tools.
   */
  declarativeTools?: { sync: () => number; countFor: (slug: string) => number };
  guardrailsService?: GuardrailsService;
  surfaceArtifactStore?: SurfaceArtifactStore;
  surfaceActionStore?: SurfaceActionStore;
  activityService?: ActivityService;
  auditService?: AuditService;
  auditReadService?: AuditReadService;
  observabilityService?: ObservabilityService;
  observabilityConfig?: ObservabilityConfig;
  routineAuthoring?: CanonicalRoutineAuthoringService;
  routineCatalog?: RoutineCatalog;
  approvalsRepo?: ApprovalsRepo;
  routineApprovals?: RoutineApprovalService;
  toolApprovals?: ToolApprovalService;
  /**
   * What `apps/integration-worker` calls back into for the Channel ports it cannot implement
   * locally (identity resolution, Run minting, reply reading, approval decisions). Built per-app
   * rather than eagerly because identity resolution logs through Fastify's logger, which does not
   * exist until `buildApp` has run.
   */
  channels?(log: FastifyBaseLogger): ChannelInternalRouteDeps;
  ingress?: IngressRoutesDeps;
  hookIngress?: HookIngressDeps;
  systemRoutes?: SystemRoutesDeps;
  operationalApi?: OperationalApiDeps;
  /** Stage 3 admin authorization surface — read/assign/group/explain over durable authority. */
  authzAdmin?: AuthzAdminService;
  /** Operator emergency stops over mutating Tool effects. */
  killSwitches?: KillSwitchService;
  /** Persist-first authority shared by Chat and every Trigger ingress. */
  invocations?: DurableInvocationGateway;
  /**
   * Durable Turns for Chat submissions. Required alongside `invocations` — a Run whose request was
   * never recorded as a Turn is not reconstructable, so the chat routes refuse the half-wired pair.
   */
  conversationStore?: ConversationStore;
  runCancel?: ChatRunCanceller;
  /**
   * The turn machinery the Worker calls back into while it cannot import this app. Service
   * principals only; PR 4 moves the implementations into the Worker and this surface goes away.
   */
  internalTurns?: InternalTurnRouteDeps;
  /**
   * Datastore handle backing `/readyz`. Absent (tests, partial assemblies) means readiness reports
   * ok on process liveness alone.
   */
  readiness?: QueryableProbeTarget;
  /**
   * Tees `error`/`fatal` log records into `log_event` so the observability UI can show them. Absent
   * (tests, partial assemblies) leaves logging on stdout exactly as it was.
   */
  logSink?: BatchingLogSink;
  logRepo?: LogRepo;
  resourceRepo?: ResourceRepo;
}

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({
    // enabling it never costs the operator output they had before.
    logger: opts.logSink ? { stream: createLogTeeStream(opts.logSink) } : true,
    forceCloseConnections: true,
    maxParamLength: 512,
  });

  const webDist = process.env.WEB_DIST;
  const serveSpa = !!webDist;
  if (serveSpa && webDist && !existsSync(webDist)) {
    throw new Error(`WEB_DIST does not exist: ${webDist}`);
  }

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
    exposedHeaders: ["X-Conversation-Id", "X-Stream-Id", "X-Message-Id", "X-Agent-Id", "X-Run-Id"],
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });

  await app.register(cookie);

  /*
   * Dynamic response compression. Static assets do NOT rely on this — the web build ships
   * precompressed `.br`/`.gz` siblings that `@fastify/static` serves directly (see the SPA
   * registration below) — so this only covers JSON payloads.
   *
   * gzip/deflate only, deliberately: brotli's encode cost is paid per request on hardware that may
   * be a Raspberry Pi, and for JSON of this size it buys little over gzip. The responses where
   * brotli genuinely pays are the immutable build assets, which are compressed at build time.
   *
   * Both SSE endpoints (chat and run events) call `reply.hijack()`, which detaches the reply from
   * the framework's `onSend` chain, so this plugin can never buffer a live stream.
   */
  await app.register(compress, { global: true, encodings: ["gzip", "deflate"] });

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
      if (!spaCspHeader) throw new Error("SPA CSP header is unavailable while serving WEB_DIST");
      reply.header("content-security-policy", spaCspHeader);
    }
  });

  // CSRF is session-bound when a session store is available (a double-submit pair alone is not
  // sufficient); the stateless hook remains for deployments assembled without session auth.
  app.addHook("preHandler", opts.sessionStore ? makeCsrfHook(opts.sessionStore) : csrfHook);

  // Kubernetes-shaped probe trio. Liveness must never consult a dependency — a Postgres
  // Readiness does, so an instance that cannot reach its datastore is pulled out of the
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

  // its own per-integration HMAC verification and must work without session deps (mirrors the
  // routines webhook posture — no session auth, no CSRF).
  if (opts.ingress) {
    await registerIngressRoutes(app, opts.ingress);
  }

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
    // Headless boot omits wizard routes (404), but status stays reachable.
    const soulPath = opts.gitSync?.path;
    if (soulPath) {
      registerSetupStatusRoute(app, {
        userRepo: opts.userRepo,
        soulPath,
        rateLimiter: opts.rateLimiter,
      });
    }
    if (!isHeadlessBoot() && opts.secretsService && opts.gitSync && soulPath) {
      registerSetupRoutes(app, {
        userRepo: opts.userRepo,
        sessionStore: opts.sessionStore,
        secretsService: opts.secretsService,
        ...(opts.setupAdminCreator ? { setupAdminCreator: opts.setupAdminCreator } : {}),
        gitSync: opts.gitSync,
        soulPath,
        requireAuth,
      });
    }
    if (opts.secretsService) {
      registerSecretsRoutes(app, opts.secretsService, requireAuth, {
        onSecretDeleted:
          opts.soulLoader && opts.soulWriter && opts.llmService
            ? makeLlmCascadeOnSecretDelete(
                opts.soulLoader,
                opts.soulWriter,
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
    if (opts.auditReadService) {
      registerAuditRoutes(app, opts.auditReadService, requireAuth);
    }
    if (opts.authzAdmin) {
      registerAuthzRoutes(app, opts.authzAdmin, requireAuth, opts.rateLimiter);
    }
    if (opts.killSwitches) {
      registerKillSwitchRoutes(app, opts.killSwitches, requireAuth, opts.rateLimiter);
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
        opts.observabilityConfig,
        opts.logRepo,
        opts.resourceRepo
      );
    }
    if (opts.gitSync && opts.soulWriter) {
      registerSoulRoutes(
        app,
        opts.gitSync,
        opts.soulWriter,
        requireAuth,
        opts.secretsService,
        opts.auditService
      );
      if (opts.soulLoader && opts.soulWriter) {
        registerResourceTypeRoutes(
          app,
          opts.soulWriter,
          opts.gitSync.path,
          opts.soulLoader,
          requireAuth,
          opts.reconcileResources,
          opts.rateLimiter,
          opts.auditService
        );
        registerAgentRoutes(app, opts.soulLoader, requireAuth);
        if (opts.toolRegistry && opts.reconcileSoulRoles && opts.soulWriter) {
          const toolRegistry = opts.toolRegistry;
          const reconcileRoles = opts.reconcileSoulRoles;
          registerAccessLevelRoutes(app, {
            soulWriter: opts.soulWriter,
            requireAuth,
            auditWrite: makeSoulAuditWriter(opts.auditService),
            catalog: () => buildCapabilityCatalog(toolRegistry.getAll()),
            reconcile: reconcileRoles,
            ...(opts.rateLimiter === undefined ? {} : { rateLimiter: opts.rateLimiter }),
          });
        }
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
          const onConnected = async (name: string) => {
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
            opts.soulWriter,
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
            opts.declarativeTools,
            opts.auditService
          );
          registerIntegrationMarketplaceRoutes(
            app,
            opts.soulLoader,
            opts.soulWriter,
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
                soulWriter: opts.soulWriter,
                secrets: opts.secretsService,
                repo: opts.integrationAuth.repo,
                bundled: opts.bundledIntegrations ?? new Map(),
                endpoints: resolveAuthEndpoints(),
                fetchImpl: opts.integrationAuth.fetchImpl,
                onConnected,
                tokens: opts.integrationAuth.tokens,
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
            opts.soulWriter,
            opts.llmService,
            requireAuth,
            opts.activityService,
            opts.bundledSkills,
            opts.disabledBundledSkills,
            opts.auditService
          );
          if (opts.secretsService) {
            registerLlmConfigRoutes(
              app,
              opts.soulLoader,
              opts.soulWriter,
              opts.llmService,
              opts.secretsService,
              requireAuth,
              opts.auditService
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
        opts.domainEventEmitter,
        opts.recordAuthorizer
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
  // routes and a JSON 404 for the API.
  if (serveSpa && webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      // Serve the `.br`/`.gz` siblings written by the web build's precompress step. Compressing on
      // the fly is too expensive on the small self-hosted boxes this ships to.
      preCompressed: true,
      setHeaders(reply, path) {
        // Everything under /assets carries a content hash in its filename, so it can never change
        // behind a cached copy. index.html has no hash and names those files — it must revalidate,
        // otherwise a browser keeps loading the previous deploy's asset graph.
        const immutable = path.includes(`${sep}assets${sep}`);
        reply.header(
          "cache-control",
          immutable ? "public, max-age=31536000, immutable" : "no-cache"
        );
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if ((req.method === "GET" || req.method === "HEAD") && !isAppApiPath(req.url)) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not Found" });
    });
  }

  return app;
}
