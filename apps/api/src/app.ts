import Fastify, { LogController } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { registerHealth, registerRoot } from './health.ts';
import { authConfig, registerAuth } from './auth.ts';
import { createTemporalClient } from './temporal.ts';
import { registerWorkspaces } from './workspaces.ts';
import { protectBusinessRequests } from './business.ts';
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
import { registerGitHubInvestigation } from './github-investigation.ts';
import { createGitHubInvestigation } from '@tulipfarm/github/investigation';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import { registerWorkspaceMcpClientMetadata } from './workspace-mcp-composition.ts';
import { registerUserVisits } from './user-visits.ts';
import { registerViewer } from './viewer.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { registerPublicGuide } from './public-guide.ts';
import { getLastWorkspace, getWorkspace } from '@tulipfarm/workspaces/store';
import { registerFeatureFlags } from './feature-flags.ts';

export function buildApp(
  options: {
    agentModel?: ModelContinuity | null;
    modelFamilyEligibility?: ModelFamilyEligibility;
    modelCatalog?: Pick<
      ModelCatalogDependencies,
      'modelFamilyEligibility' | 'modelFamilyResolution' | 'modelCatalogSnapshot'
    >;
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
        workspaceStorage = storage;
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
        registerGitHubAccounts(
          business,
          auth.auth,
          github,
          runtime && github ? createGitHubReads({ runtime, accounts: github }) : undefined,
        );
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
          });
      });
    },
    { prefix: '/v1' },
  );

  return app;
}
