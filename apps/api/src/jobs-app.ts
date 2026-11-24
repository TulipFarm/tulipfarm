import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import Fastify from 'fastify';
import type { ModelContinuity } from '@tulipfarm/agents/chat';
import { registerFlagSubjectResolver } from '@tulipfarm/observability';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { withKnowledgeSourceAuthorization } from '@tulipfarm/knowledge';
import { isolatedStorageEnabled, workspaceRuntime } from '@tulipfarm/workspaces/storage';
import { registerHealth, registerRoot } from './health.ts';
import { createTemporalClient } from './temporal.ts';
import { registerObservability } from './observability.ts';
import { apiServerOptions } from './server-options.ts';
import { createIdentityPool } from './identity-pool.ts';
import { apiFlagSubjects } from './flag-subjects.ts';
import { createModelConfiguration } from './model-configuration.ts';
import { defaultKnowledgeStarter } from './knowledge-defaults-dispatch.ts';
import { slackDependencies } from './slack-composition.ts';
import { createStorageServices, registerStorageSweeps } from './storage-services.ts';

/**
 * The `jobs` role: the scheduled background sweeps and the health routes, without the request routes. It builds the
 * sweeps' services exactly as `buildApp` does, so it does not load, register or compile the routes it never serves.
 * `agentModel` replaces the configured chat model, as in `buildApp`, for tests without a database.
 */
export function buildJobsApp(options: { agentModel?: ModelContinuity | null } = {}) {
  const app = Fastify(apiServerOptions());
  registerObservability(app);
  const temporal = createTemporalClient();
  app.addHook('onClose', async () => {
    await temporal.connection.close();
  });
  app.register(async routes => {
    registerRoot(routes);
  });
  app.register(
    async v1 => {
      registerHealth(v1, temporal);
      const pool = createIdentityPool(v1);
      registerFlagSubjectResolver(apiFlagSubjects(pool));
      let workspaces: ConversationRuntime | undefined;
      const models = createModelConfiguration({ pool, workspaces: () => workspaces });
      if (options.agentModel === undefined) v1.addHook('onReady', models.registerModelBundle);
      v1.register(async jobs => {
        const storage = isolatedStorageEnabled() ? workspaceRuntime(pool) : undefined;
        jobs.addHook('onClose', async () => {
          await storage?.close();
        });
        const runtime = storage ? withKnowledgeSourceAuthorization(withGitHubSourceAuthorization(storage)) : undefined;
        const defaultKnowledge = defaultKnowledgeStarter(jobs, temporal);
        if (!runtime) return;
        workspaces = runtime;
        const slack = slackDependencies(pool, runtime, defaultKnowledge.hook);
        const dependencies = {
          pool,
          temporal,
          runtime,
          agentModel: options.agentModel === undefined ? models.modelContinuity : options.agentModel,
          modelFamilyEligibility: models.modelFamilyEligibility,
          agentSetup: slack?.channels
            ? { attachSlack: slack.channels.attachSetup, inspectSlack: slack.channels.inspectSetup }
            : undefined,
          defaultKnowledge,
        };
        registerStorageSweeps(jobs, dependencies, createStorageServices(jobs, dependencies));
      });
    },
    { prefix: '/v1' },
  );
  return app;
}
