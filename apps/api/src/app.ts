import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { registerHealth, registerRoot } from './health.ts';
import { authConfig, registerAuth } from './auth.ts';
import { createTemporalClient } from './temporal.ts';
import { registerWorkspaces } from './workspaces.ts';
import { protectBusinessRequests, protectWorkspaceRequests } from './business.ts';
import { registerStorageComposition } from './storage-composition.ts';
import { registerObservability } from './observability.ts';
import type { ModelContinuity } from '@tulipfarm/agents/chat';
import type { ModelFamilyEligibility } from '@tulipfarm/agents/model-policy';
import { registerSecurity } from './security.ts';
import { apiServerOptions } from './server-options.ts';
import { registerAbuseProtection } from './abuse.ts';
import { registerModelCatalog, type ModelCatalogDependencies } from './model-catalog.ts';
import { createModelConfiguration } from './model-configuration.ts';
import { registerSlack } from './slack.ts';
import { defaultKnowledgeStarter } from './knowledge-defaults-dispatch.ts';
import { slackDependencies } from './slack-composition.ts';
import { registerAtlassianAccounts } from './atlassian-accounts.ts';
import { atlassianAccounts } from './atlassian-composition.ts';
import { registerSocialAccounts } from './social-accounts.ts';
import { socialAccounts, socialChannels, socialPosts } from './social-composition.ts';
import { githubAccounts } from './github-composition.ts';
import { registerGitHubAccounts } from './github-accounts.ts';
import { chatGptPlan, registerChatGptPlan } from './chatgpt-plan.ts';
import { registerTokenPlan, tokenPlan } from './token-plans.ts';
import { byokPlansFromEnvironment, registerByokPlans } from './byok-plans.ts';
import { createDevPlans } from './dev-plans.ts';
import type { TokenPlan, TokenPlanProvider } from '@tulipfarm/integrations/token-plans';
import { isByokProvider, planModelFamilyId, type PlanProvider } from '@tulipfarm/config';
import { registerSubscriptions } from './subscriptions.ts';
import { createSubscriptions } from '@tulipfarm/integrations/subscriptions';
import { createPlanUsage } from './plan-usage.ts';
import { registerUsage } from './usage.ts';
import { registerGitHubInvestigation } from './github-investigation.ts';
import { createGitHubInvestigation } from '@tulipfarm/github/investigation';
import { createGitHubBotGrants } from '@tulipfarm/github/bot';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import { registerWorkspaceMcpClientMetadata } from './workspace-mcp-composition.ts';
import { registerUserVisits } from './user-visits.ts';
import { registerViewer } from './viewer.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { registerPublicGuide } from './public-guide.ts';
import { getLastWorkspace, getWorkspace } from '@tulipfarm/workspaces/store';
import { registerFlagSubjectResolver } from '@tulipfarm/observability';
import { apiFlagSubjects } from './flag-subjects.ts';
import { registerFeatureFlags } from './feature-flags.ts';
import { protectExpectedSession } from './authenticated-routes.ts';
import { registerApps } from './apps.ts';
import { appHostingFromEnvironment, temporalAppWorkflows } from './apps-hosting.ts';
import { routeAppSites } from './apps-sites.ts';
import { appBuilders, previewHosts } from '@tulipfarm/apps';
import { appKeyRoot, requestHandleKey } from '@tulipfarm/apps/store';
import { appBuilder, appHost } from '@tulipfarm/extensions';
import type { Pool } from 'pg';
import { registerPreviewTickets } from './app-preview-tickets.ts';
import { appDataLookupPool, registerAppData } from './app-data.ts';
import { createIdentityPool } from './identity-pool.ts';
import { createTableService } from '@tulipfarm/tables/service';
import { createAccessTokens, type AccessTokens } from './access-tokens.ts';
import { registerAccessTokenSettings } from './access-token-routes.ts';
import { createExternalApi } from './external-api.ts';
import { createTokenLimiter, registerPublicApi } from './public-api.ts';
import { registerPublicMcp } from './public-mcp.ts';

export function buildApp(
  options: {
    agentModel?: ModelContinuity | null;
    modelFamilyEligibility?: ModelFamilyEligibility;
    modelCatalog?: Pick<
      ModelCatalogDependencies,
      'modelFamilyEligibility' | 'modelFamilyResolution' | 'modelCatalogSnapshot'
    >;
    /** Replaces the Claude and Copilot connections, for tests that must not reach the vendors. */
    tokenPlans?: Partial<Record<TokenPlanProvider, TokenPlan | null>>;
  } = {},
) {
  const app = Fastify(apiServerOptions());
  let appPlatform: Pick<Pool, 'query'> | undefined;
  const appHosting = appHostingFromEnvironment(process.env, () => appPlatform);
  if (appHosting?.sites) routeAppSites(app, appHosting.sites);
  // The gateway serves draft builds; the API only issues the tickets that open them.
  const previewDomain = appHosting && process.env.TULIPFARM_APP_PREVIEW_DOMAIN?.trim();
  const preview = previewDomain ? previewHosts(previewDomain, process.env.TULIPFARM_APP_SITES_DOMAIN) : undefined;
  registerObservability(app);
  registerSecurity(app, authConfig().webOrigin);
  const temporal = createTemporalClient();
  app.addHook('onClose', async () => {
    await temporal.connection.close();
  });

  app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'TulipFarm API',
        version: '1.0.0',
        description: 'Version 1 of the TulipFarm HTTP API. Breaking changes receive a new URL version.',
      },
      servers: [{ url: '/', description: 'Current API host' }],
      tags: [
        { name: 'Health', description: 'Service diagnostics and API liveness' },
        { name: 'Public API', description: 'Stable API for outside tools, authenticated with an access token' },
      ],
      components: {
        securitySchemes: {
          accessToken: {
            type: 'http',
            scheme: 'bearer',
            description: 'A TulipFarm access token (tfp_…) from Settings → API and MCP. Public API and MCP only.',
          },
        },
      },
    },
  });
  app.register(swaggerUi, {
    routePrefix: '/v1/docs',
    staticCSP: true,
    transformStaticCSP: header =>
      header.replace('upgrade-insecure-requests;', '').replace("frame-ancestors 'self'", "frame-ancestors 'none'"),
    uiConfig: { deepLinking: true, displayRequestDuration: true },
  });
  app.register(async routes => {
    registerRoot(routes);
    registerWorkspaceMcpClientMetadata(routes);
  });
  app.register(
    async v1 => {
      registerHealth(v1, temporal);
      const auth = registerAuth(v1);
      protectExpectedSession(v1, auth.auth);
      registerFlagSubjectResolver(apiFlagSubjects(auth.pool));
      let workspaceStorage: ReturnType<typeof registerWorkspaces>;
      let accessTokens: AccessTokens | undefined;
      let externalServices: ReturnType<typeof registerStorageComposition>;
      registerViewer(v1, auth.auth, userId => {
        if (!workspaceStorage) throw new Error('Workspace storage is unavailable');
        return getLastWorkspace({ pool: auth.pool, runtime: workspaceStorage }, userId);
      });
      registerUserVisits(v1, auth, authConfig().webOrigin);
      const models = createModelConfiguration({ pool: auth.pool, workspaces: () => workspaceStorage });
      if (options.agentModel === undefined) v1.addHook('onReady', models.registerModelBundle);
      registerAbuseProtection(v1, auth.auth);
      registerPublicGuide(v1, auth);
      v1.register(async business => {
        protectBusinessRequests(business);
        const storage = registerWorkspaces(business, auth, temporal);
        if (storage) protectWorkspaceRequests(business, auth.auth, storage);
        workspaceStorage = storage;
        if (storage) {
          accessTokens = createAccessTokens({ pool: auth.pool, runtime: storage });
          registerAccessTokenSettings(business, auth.auth, accessTokens);
          appPlatform = auth.pool;
          const start = temporalAppWorkflows(temporal);
          registerApps(business, {
            auth: auth.auth,
            runtime: storage,
            platform: auth.pool,
            start,
            repositories: appHosting?.repositories ?? null,
            publisher: () => appHosting?.publisher,
            builders: () => appBuilders(appBuilder(), appHost()),
            sitesDomain: appHosting?.domain ?? null,
          });
          if (preview)
            registerPreviewTickets(business, auth.auth, { pool: auth.pool, runtime: storage }, preview, start);
        }
        registerFeatureFlags(
          business,
          auth.auth,
          storage ? (userId, slug) => getWorkspace({ pool: auth.pool, runtime: storage }, userId, slug) : undefined,
        );
        const runtime = storage ? withKnowledgeSourceAuthorization(withGitHubSourceAuthorization(storage)) : undefined;
        const defaultKnowledge = defaultKnowledgeStarter(business, temporal);
        const slack = slackDependencies(auth.pool, runtime, defaultKnowledge.hook);
        registerSlack(business, auth.auth, slack);
        registerAtlassianAccounts(business, auth.auth, atlassianAccounts(runtime, process.env, defaultKnowledge.hook));
        const social = socialAccounts(runtime);
        const channels = socialChannels(social, runtime);
        const posts = socialPosts(social, channels, runtime);
        if (posts) business.addHook('onClose', posts.close);
        registerSocialAccounts(business, auth.auth, social, channels, posts?.posts ?? null);
        const github = githubAccounts(runtime, process.env, defaultKnowledge.hook);
        const planFor = (provider: TokenPlanProvider) =>
          options.tokenPlans && provider in options.tokenPlans
            ? (options.tokenPlans[provider] ?? null)
            : tokenPlan(provider, runtime, process.env, undefined, github?.memberAccessToken);
        const tokenPlans = { claude: planFor('claude'), copilot: planFor('copilot') };
        const devPlans = createDevPlans(tokenPlans, business.log);
        const copilot = tokenPlans.copilot;
        registerGitHubAccounts(
          business,
          auth.auth,
          github,
          runtime && github ? createGitHubReads({ runtime, accounts: github }) : undefined,
          runtime && github ? createGitHubBotGrants(runtime) : undefined,
          // One GitHub sign-in also connects Copilot when the account has a plan and no other Copilot connection works.
          copilot
            ? (workspaceId, userId, accountId) => copilot.useGitHubAccount(workspaceId, userId, accountId, true)
            : undefined,
        );
        const chatGpt = chatGptPlan(runtime, auth.pool);
        registerChatGptPlan(business, auth.auth, chatGpt, auth.pool);
        registerTokenPlan(business, auth.auth, 'claude', tokenPlans.claude);
        registerTokenPlan(business, auth.auth, 'copilot', tokenPlans.copilot);
        const byokPlans = byokPlansFromEnvironment(runtime ?? null);
        registerByokPlans(business, auth.auth, byokPlans);
        const subscriptions = runtime ? createSubscriptions({ runtime }) : null;
        const planUsage = createPlanUsage({ copilotToken: copilot?.accessToken });
        if (runtime) registerUsage(business, { runtime, auth: auth.auth, planUsage });
        registerSubscriptions(
          business,
          auth.auth,
          subscriptions,
          (provider, slug) => planModelFamilyId(provider, slug) !== null,
        );
        if (runtime && github)
          registerGitHubInvestigation(business, auth.auth, createGitHubInvestigation({ runtime, accounts: github }));
        externalServices = registerStorageComposition(
          business,
          auth,
          temporal,
          runtime,
          options.agentModel === undefined ? models.modelContinuity : options.agentModel,
          options.modelFamilyEligibility ?? models.modelFamilyEligibility,
          slack?.channels
            ? { attachSlack: slack.channels.attachSetup, inspectSlack: slack.channels.inspectSetup }
            : undefined,
          defaultKnowledge,
          devPlans ? (workspaceId, userId) => devPlans.ensure(workspaceId, userId) : undefined,
        );
        if (runtime)
          registerModelCatalog(business, {
            auth: auth.auth,
            runtime,
            compatibility: commonCompatibility,
            ...(options.modelCatalog ?? { modelCatalogSnapshot: models.modelCatalogSnapshot }),
            ...(subscriptions && (chatGpt || tokenPlans.claude || tokenPlans.copilot || byokPlans)
              ? {
                  planModels: async (workspaceId: string, userId: string, providers: readonly PlanProvider[]) => {
                    await devPlans?.ensure(workspaceId, userId);
                    const on = providers.filter(provider =>
                      isByokProvider(provider)
                        ? Boolean(byokPlans)
                        : provider === 'chatgpt'
                          ? Boolean(chatGpt)
                          : Boolean(tokenPlans[provider]),
                    );
                    const models = on.length ? await subscriptions.modelsFor(workspaceId, userId, on) : new Map();
                    return new Map(
                      await Promise.all(
                        on.map(
                          async provider =>
                            [provider, await planUsage(workspaceId, provider, models.get(provider) ?? [])] as const,
                        ),
                      ),
                    );
                  },
                }
              : {}),
          });
      });
      // Outside tools: token-authenticated REST under /v1/public and the MCP server at /v1/mcp. No session or origin
      // check applies here, and these routes accept no session.
      v1.register(async external => {
        if (!accessTokens || !externalServices) return;
        const api = createExternalApi({
          runtime: externalServices.runtime,
          files: externalServices.files,
          wakeTask: externalServices.wakeTask,
          claimMcpSelection: externalServices.claimMcpSelection,
          appOrigin: authConfig().webOrigin,
          workspaceSlug: async id =>
            (await auth.pool.query<{ slug: string }>('SELECT slug FROM app.workspaces WHERE id = $1', [id])).rows[0]
              ?.slug ?? null,
        });
        const limiter = createTokenLimiter();
        external.register(async routes => registerPublicApi(routes, { tokens: accessTokens!, api, limiter }), {
          prefix: '/public',
        });
        registerPublicMcp(external, { tokens: accessTokens, api, limiter });
      });
      v1.register(async data => {
        if (!workspaceStorage) return;
        const tables = createTableService(
          workspaceStorage,
          { readableFiles: async () => new Set() },
          commonCompatibility,
        );
        registerAppData(data, {
          lookups: createIdentityPool(data, appDataLookupPool),
          handles: requestHandleKey(process.env),
          appKeys: appKeyRoot(process.env),
          tables,
        });
      });
    },
    { prefix: '/v1' },
  );

  return app;
}
