import Fastify, { LogController } from 'fastify';
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
import { registerSecurity, securityServerOptions } from './security.ts';
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
import type { TokenPlan, TokenPlanProvider } from '@tulipfarm/integrations/token-plans';
import { planModelFamilyId, planProviders, type PlanProvider } from '@tulipfarm/config';
import { registerSubscriptions } from './subscriptions.ts';
import { createSubscriptions } from '@tulipfarm/integrations/subscriptions';
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
import { isFeatureEnabled, registerFlagSubjectResolver } from '@tulipfarm/observability';
import { apiFlagSubjects } from './flag-subjects.ts';
import { registerFeatureFlags } from './feature-flags.ts';
import { protectExpectedSession } from './authenticated-routes.ts';
import { registerApps } from './apps.ts';
import { appHostingFromEnvironment, temporalAppWorkflows } from './apps-hosting.ts';
import { routeAppSites } from './apps-sites.ts';
import { appBuilder } from '@tulipfarm/extensions';
import type { Pool } from 'pg';

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
  const app = Fastify({
    ...securityServerOptions(),
    logger: {
      serializers: {
        err: () => ({ type: 'Error', message: 'request_failed', stack: '' }),
        req: () => ({}),
        res: () => ({}),
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
  });
  let appPlatform: Pick<Pool, 'query'> | undefined;
  const appHosting = appHostingFromEnvironment(process.env, () => appPlatform);
  if (appHosting?.sites) routeAppSites(app, appHosting.sites);
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
      tags: [{ name: 'Health', description: 'Service diagnostics and API liveness' }],
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
      registerViewer(v1, auth.auth, userId => {
        if (!workspaceStorage) throw new Error('Workspace storage is unavailable');
        return getLastWorkspace({ pool: auth.pool, runtime: workspaceStorage }, userId);
      });
      registerUserVisits(v1, auth, authConfig().webOrigin);
      const models = createModelConfiguration({ pool: auth.pool });
      if (options.agentModel === undefined) v1.addHook('onReady', models.registerModelBundle);
      registerAbuseProtection(v1, auth.auth);
      registerPublicGuide(v1, auth);
      v1.register(async business => {
        protectBusinessRequests(business);
        const storage = registerWorkspaces(business, auth, temporal);
        if (storage) protectWorkspaceRequests(business, auth.auth, storage);
        workspaceStorage = storage;
        if (storage) {
          appPlatform = auth.pool;
          registerApps(business, {
            auth: auth.auth,
            runtime: storage,
            platform: auth.pool,
            start: temporalAppWorkflows(temporal),
            repositories: appHosting?.repositories ?? null,
            publisher: () => appHosting?.publisher,
            builderId: () => appBuilder()?.id,
            sitesDomain: appHosting?.sites?.domain ?? null,
          });
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
        registerSocialAccounts(business, auth.auth, social, undefined, channels, posts?.posts ?? null);
        const github = githubAccounts(runtime, process.env, defaultKnowledge.hook);
        const planFor = (provider: TokenPlanProvider) =>
          options.tokenPlans && provider in options.tokenPlans
            ? (options.tokenPlans[provider] ?? null)
            : tokenPlan(provider, runtime, process.env, undefined, github?.memberAccessToken);
        const tokenPlans = { claude: planFor('claude'), copilot: planFor('copilot') };
        const copilot = tokenPlans.copilot;
        registerGitHubAccounts(
          business,
          auth.auth,
          github,
          runtime && github ? createGitHubReads({ runtime, accounts: github }) : undefined,
          runtime && github ? createGitHubBotGrants(runtime) : undefined,
          // One GitHub sign-in also connects Copilot when the account has a plan and no other Copilot connection works.
          copilot
            ? async (workspaceId, userId, accountId) => {
                if (await isFeatureEnabled(planProviders.copilot.flag, null, { id: workspaceId }))
                  await copilot.useGitHubAccount(workspaceId, userId, accountId, true);
              }
            : undefined,
        );
        const chatGpt = chatGptPlan(runtime, auth.pool);
        registerChatGptPlan(business, auth.auth, chatGpt, auth.pool);
        registerTokenPlan(business, auth.auth, 'claude', tokenPlans.claude);
        registerTokenPlan(business, auth.auth, 'copilot', tokenPlans.copilot);
        const subscriptions = runtime ? createSubscriptions({ runtime }) : null;
        registerSubscriptions(business, auth.auth, subscriptions, (provider, slug) => {
          const id = planModelFamilyId(provider, slug);
          return id !== null && models.catalog.model(id) !== undefined;
        });
        if (runtime && github)
          registerGitHubInvestigation(business, auth.auth, createGitHubInvestigation({ runtime, accounts: github }));
        registerStorageComposition(
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
        );
        if (runtime)
          registerModelCatalog(business, {
            auth: auth.auth,
            runtime,
            compatibility: commonCompatibility,
            ...(options.modelCatalog ?? { modelCatalogSnapshot: models.modelCatalogSnapshot }),
            ...(subscriptions && (chatGpt || tokenPlans.claude || tokenPlans.copilot)
              ? {
                  planModels: async (workspaceId: string, userId: string, provider: PlanProvider) =>
                    (provider === 'chatgpt' ? chatGpt : tokenPlans[provider])
                      ? subscriptions.models(workspaceId, userId, provider)
                      : [],
                }
              : {}),
          });
      });
    },
    { prefix: '/v1' },
  );

  return app;
}
