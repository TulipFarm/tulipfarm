import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import scalar from "@scalar/fastify-api-reference";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { acceptedInputModalities, type LlmConfig } from "@tulipfarm/schema";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { registerActivityRoutes } from "./activity/routes";
import { postgresProbe, probeHealth } from "./admin/health";
import { registerOperationalRoutes } from "./admin/routes";
import type { AppOptions } from "./app-options";
import { registerApprovalRoutes } from "./approvals/routes";
import { registerAuditRoutes } from "./audit/routes";
import { csrfHook, makeCsrfHook } from "./auth/csrf";
import { makeRequireAuth } from "./auth/middleware";
import { registerAuthRoutes } from "./auth/routes";
import { makeAuthorizationCheck, makeRequireAuthorization } from "./authz/route-gate";
import { registerAuthzRoutes } from "./authz/routes";
import { registerConversationRoutes } from "./chat/conversation-routes";
import { registerChatRoutes } from "./chat/routes";
import { registerCuratorReviewRoutes } from "./curator/review-routes";
import { registerFeedbackRoutes } from "./feedback/routes";
import { registerFileRoutes } from "./files/routes";
import { registerFormRoutes } from "./forms/routes";
import { registerHookIngressRoutes } from "./hooks/routes";
import { registerIngressRoutes } from "./ingress/routes";
import { registerGitHubInstallRoutes } from "./integrations/github-install-routes";
import { registerInternalRouteFamily } from "./internal/route-family";
import { registerKillSwitchRoutes } from "./kill-switches/routes";
import { registerKnowledgeRoutes } from "./knowledge/routes";
import { registerSubjectRoutes } from "./knowledge/subject-directory";
import { registerKvRoutes } from "./kv/routes";
import { registerMemoryDocumentRoute } from "./memory/document-routes";
import { createLogTeeStream } from "./observability/log-stream";
import { registerObservabilityRoutes } from "./observability/routes";
import { readCustomInstructions } from "./preferences/custom-instructions";
import { registerPreferenceRoutes } from "./preferences/routes";
import { registerResourceRoutes } from "./resources/routes";
import { registerRoutineAuthoringRoutes } from "./routines/authoring-routes";
import { registerRoutineCatalogRoutes } from "./routines/catalog-routes";
import { registerRoutineDetailRoutes } from "./routines/detail-routes";
import { registerRunEventRoutes } from "./runs/events";
import { registerRunReplayRoutes } from "./runs/replay";
import { registerSecretsRoutes } from "./secrets/routes";
import { registerSetupRoutes, registerSetupStatusRoute } from "./setup/routes";
import { isHeadlessBoot } from "./setup/service";
import { makeLlmCascadeOnSecretDelete } from "./soul/llm-config/cascade";
import { makeLlmCascadeOnSecretSet } from "./soul/llm-config/cascade-set";
import { registerSoulRouteFamily } from "./soul/route-family";
import { MemorySurfaceActionStore } from "./surfaces/action-store";
import { MemorySurfaceArtifactStore } from "./surfaces/artifact-store";
import { registerSurfaceRoutes } from "./surfaces/routes";
import { registerSystemRoutes } from "./system/routes";
import { registerTaskRoutes } from "./tasks/routes";
import { buildToolRegistry } from "./tools/setup";
import { registerTriggerRoutes } from "./triggers/routes";

export type { AppOptions } from "./app-options";

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({
    // enabling it never costs the operator output they had before.
    logger: opts.logSink ? { stream: createLogTeeStream(opts.logSink) } : true,
    forceCloseConnections: true,
    maxParamLength: 512,
  });

  const publicOrigins = opts.publicOrigins;

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
      (publicOrigins
        ? async (origin: string | undefined) =>
            origin === undefined || origin === publicOrigins.current().webOrigin
        : (process.env.PUBLIC_URL ?? `http://localhost:${process.env.VITE_PORT ?? 4000}`)),
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
    const requireAuthorization = makeRequireAuthorization(
      opts.routeAuthorizer,
      opts.authorizationGate
    );
    const authorizationCheck = makeAuthorizationCheck(opts.routeAuthorizer, opts.authorizationGate);
    registerAuthRoutes(app, opts.sessionStore, opts.userRepo, opts.tokenRepo, {
      rateLimiter: opts.rateLimiter,
      ...(opts.identity && { identity: opts.identity }),
      ...(opts.userAdminRepo && { userAdminRepo: opts.userAdminRepo }),
      ...(opts.passwordWriteRepo && { passwordWriteRepo: opts.passwordWriteRepo }),
      ...(opts.profileWriteRepo && { profileWriteRepo: opts.profileWriteRepo }),
      ...(opts.userInviteRepo && { inviteRepo: opts.userInviteRepo }),
      requireAuthorization,
      authorizationCheck,
      ...(opts.triggerCuratorSweep && { triggerCuratorSweep: opts.triggerCuratorSweep }),
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
        requireAuthorization,
        userRepo: opts.userRepo,
        sessionStore: opts.sessionStore,
        secretsService: opts.secretsService,
        ...(opts.setupAdminCreator ? { setupAdminCreator: opts.setupAdminCreator } : {}),
        gitSync: opts.gitSync,
        soulPath,
        requireAuth,
        ...(opts.triggerCuratorSweep && { triggerCuratorSweep: opts.triggerCuratorSweep }),
        ...(opts.soulLoader && {
          reloadSoul: () => opts.soulLoader?.reload() ?? Promise.resolve(),
        }),
      });
    }
    if (opts.secretsService) {
      registerSecretsRoutes(
        app,
        opts.secretsService,
        requireAuth,
        requireAuthorization,
        authorizationCheck,
        {
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
          onSecretSet:
            opts.soulLoader && opts.soulWriter && opts.llmService
              ? makeLlmCascadeOnSecretSet(
                  opts.soulLoader,
                  opts.soulWriter,
                  opts.llmService,
                  opts.secretsService,
                  app.log,
                  opts.triggerCuratorSweep
                )
              : undefined,
        }
      );
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
    if (opts.routineDetail) {
      registerRoutineDetailRoutes(app, opts.routineDetail, requireAuth, requireAuthorization);
    }

    if (opts.curatorReview) {
      registerCuratorReviewRoutes(
        app,
        opts.curatorReview,
        DEPLOYMENT_BUSINESS_ID,
        requireAuth,
        requireAuthorization
      );
    }
    if (opts.kvService) {
      registerKvRoutes(app, opts.kvService, requireAuth, requireAuthorization);
      registerPreferenceRoutes(app, opts.kvService, requireAuth);
    }
    registerSystemRoutes(
      app,
      {
        kv: opts.kvService,
        publicOrigins: opts.publicOrigins,
        audit: opts.auditService,
        ...opts.systemRoutes,
      },
      requireAuth,
      requireAuthorization
    );
    if (opts.activityService) {
      registerActivityRoutes(app, opts.activityService, requireAuth);
    }
    if (opts.auditReadService) {
      registerAuditRoutes(app, opts.auditReadService, requireAuth, requireAuthorization);
    }
    if (opts.authzAdmin) {
      registerAuthzRoutes(
        app,
        opts.authzAdmin,
        requireAuth,
        requireAuthorization,
        opts.rateLimiter
      );
    }
    if (opts.killSwitches) {
      registerKillSwitchRoutes(
        app,
        opts.killSwitches,
        requireAuth,
        requireAuthorization,
        opts.rateLimiter
      );
    }
    if (opts.memoryDocuments) registerMemoryDocumentRoute(app, opts.memoryDocuments, requireAuth);
    if (opts.observabilityService) {
      registerObservabilityRoutes(
        app,
        opts.observabilityService,
        requireAuth,
        requireAuthorization,
        opts.observabilityConfig,
        opts.logRepo,
        opts.resourceRepo
      );
    }
    registerSoulRouteFamily(app, opts, requireAuth, requireAuthorization, authorizationCheck);
    if (opts.fileService) {
      registerFileRoutes(
        app,
        {
          files: opts.fileService,
          ...(opts.auditService === undefined ? {} : { audit: opts.auditService }),
          ...(opts.fileKnowledge === undefined ? {} : { knowledge: opts.fileKnowledge }),
          acceptedInputModalities: () =>
            acceptedInputModalities((opts.soulLoader?.llmConfig as LlmConfig | undefined) ?? {}),
        },
        requireAuth,
        requireAuthorization
      );
    }
    if (opts.taskStore) {
      registerTaskRoutes(
        app,
        {
          tasks: opts.taskStore,
          soulWriter: opts.soulWriter,
          gitSync: opts.gitSync,
          auditService: opts.auditService,
          ...(opts.memoryDocuments === undefined ? {} : { memoryDocuments: opts.memoryDocuments }),
        },
        requireAuth,
        authorizationCheck
      );
    }
    if (opts.githubInstall) {
      registerGitHubInstallRoutes(app, {
        integrations: opts.githubInstall.integrations,
        secretsService: opts.githubInstall.secretsService,
        businessId: opts.githubInstall.businessId,
        http: opts.githubInstall.http,
        soulRepositories: opts.githubInstall.soulRepositories,
        requireAuth,
        requireAuthorization,
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
          ...(opts.memoryDocuments === undefined ? {} : { memoryDocuments: opts.memoryDocuments }),
          kv: opts.kvService,
          ...(opts.fileService === undefined ? {} : { files: opts.fileService }),
          knowledge: opts.knowledgeService,
        });
      const kvForInstructions = opts.kvService;
      registerConversationRoutes(
        app,
        {
          repo: opts.conversationRepo,
          messageRepo: opts.messageRepo,
          ...(opts.conversationStore === undefined ? {} : { turnStore: opts.conversationStore }),
          soulLoader: opts.soulLoader,
          ...(opts.authorityLayers === undefined ? {} : { authorityLayers: opts.authorityLayers }),
          ...(opts.memoryDocuments === undefined ? {} : { memory: opts.memoryDocuments }),
          ...(kvForInstructions === undefined
            ? {}
            : {
                customInstructions: (userId: string) =>
                  readCustomInstructions(kvForInstructions, userId),
              }),
          ...(opts.fileService === undefined ? {} : { files: opts.fileService }),
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
            ...(opts.fileService ? { fileService: opts.fileService } : {}),
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
    registerInternalRouteFamily(app, opts, requireAuth);
    if (opts.runReplay) {
      registerRunReplayRoutes(app, opts.runReplay, requireAuth, opts.rateLimiter);
    }
    if (opts.operationalApi) {
      registerOperationalRoutes(app, opts.operationalApi, requireAuth, opts.rateLimiter);
    }
    if (opts.feedbackRepo) {
      registerFeedbackRoutes(app, opts.feedbackRepo, requireAuth);
    }
    if (opts.knowledgeService && opts.knowledgePageGate) {
      registerKnowledgeRoutes(
        app,
        opts.knowledgeService,
        requireAuth,
        requireAuthorization,
        opts.knowledgePageGate,
        undefined,
        opts.activityService,
        opts.knowledgeAuthorLabeller,
        opts.knowledgeReaderDirectory,
        opts.knowledgeDenialSink
      );
      if (opts.knowledgeSubjectDirectory) {
        registerSubjectRoutes(
          app,
          requireAuth,
          requireAuthorization,
          opts.knowledgeSubjectDirectory
        );
      }
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
