import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppOptions } from "../app";
import { makeSoulAuditWriter } from "../audit/soul-write";
import { buildCapabilityCatalog } from "../authz/capabilities";
import type { AuthorizationCheck, RequireAuthorization } from "../authz/route-gate";
import { resolveAuthEndpoints } from "../integrations/auth-broker";
import { registerIntegrationAuthRoutes } from "../integrations/auth-routes";
import { ensureGitHubInstallation } from "../integrations/github-install";
import { registerIntegrationMarketplaceRoutes } from "../integrations/marketplace-routes";
import { registerIntegrationRoutes } from "../integrations/routes";
import {
  ensureDefaultSlackRoute,
  registerSlackBindRoute,
  type SlackBindDeps,
} from "../integrations/slack-binding";
import { registerOnboardingRoutes } from "../onboarding/routes";
import { registerAgentRoutes } from "./agents/routes";
import { registerLlmConfigRoutes } from "./llm-config/routes";
import { registerResourceTypeRoutes } from "./resource-types/routes";
import { registerAccessLevelRoutes } from "./roles/routes";
import { registerSoulRoutes } from "./routes";
import { registerSkillRoutes } from "./skills/routes";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Everything gated on a writable Soul repository: config, resource types, agents, access levels,
 * Integrations, onboarding, skills, and LLM config. Split out of `buildApp` because it is the one
 * family that shares a single `opts.gitSync && opts.soulWriter` guard and an `onConnected` closure
 * across every Integration route.
 */
export function registerSoulRouteFamily(
  app: FastifyInstance,
  opts: AppOptions,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization,
  authorizationCheck: AuthorizationCheck
): void {
  if (opts.gitSync && opts.soulWriter) {
    registerSoulRoutes(
      app,
      opts.gitSync,
      opts.soulWriter,
      requireAuth,
      requireAuthorization,
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
        authorizationCheck,
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
          requireAuthorization,
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
          requireAuthorization,
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
            requireAuth,
            authorizationCheck
          );
        }
      }
      const knowledgeService = opts.knowledgeService;
      registerOnboardingRoutes(app, opts.soulLoader, requireAuth, requireAuthorization, {
        kvService: opts.kvService,
        llmService: opts.llmService,
        hasAnyKnowledgePage: knowledgeService
          ? () => knowledgeService.hasAnyKnowledgePage()
          : undefined,
        gitSync: opts.gitSync,
        soulWriter: opts.soulWriter,
        auditService: opts.auditService,
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
            requireAuthorization,
            opts.auditService
          );
        }
      }
    }
  }
}
