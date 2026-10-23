// One worker lifetime under the model catalog in MODEL_CATALOG_FILE: registers its bundle, then processes a task.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const input = JSON.parse(process.env.MODEL_BUNDLE_RESTART_INPUT);
const { createWorkspaceRuntime } = await import('@tulipfarm/workspace-storage/runtime');
const { createTaskRuntime } = await import('../src/task-runtime.ts');
const { createModelRouteHealth } = await import('../src/model-health.ts');
const { modelEnvironment } = await import('../src/model-environment.ts');
const { modelBundleStore } = await import('../src/model-bundles.ts');
const runtime = createWorkspaceRuntime({
  replicaCount: 1,
  reservedConnections: 2,
  databaseConnectionBudget: 20,
  resolveCredential: async workspaceId => ({ workspaceId, generation: 1, connectionString: input.connectionString }),
});
const registry = new Pool({ connectionString: input.registry, max: 1, options: '-c search_path=pg_catalog' });
const health = new Pool({ connectionString: input.health, max: 1 });
try {
  const environment = modelEnvironment({
    MODEL_CATALOG_FILE: process.env.MODEL_CATALOG_FILE,
    AZURE_FOUNDRY_ENDPOINT: 'https://synthetic.services.ai.azure.com/',
    AZURE_FOUNDRY_API_KEY: 'synthetic-private-credential',
  });
  const bundles = modelBundleStore(registry);
  if (input.register) await bundles.register(environment.bundle);
  const model = {
    ...environment.continuity(key => createModelRouteHealth(health, key), input.store ? bundles : undefined),
    infer: async () =>
      input.outcome === 'unavailable'
        ? {
            kind: 'failure',
            reason: 'unavailable',
            status: 503,
            retryAfterMs: null,
            actualModel: null,
            requestId: null,
            usage: { kind: 'unknown' },
            dispatch: 'not-started',
          }
        : {
            kind: 'success',
            decision: { kind: 'answer', text: 'Answered after restart.' },
            actualModel: 'Acme-Chat-1',
            requestId: randomUUID(),
            usage: {
              kind: 'known',
              input: 1000,
              output: 1000,
              cacheRead: 0,
              cacheWrite: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
            },
          },
  };
  const engine = createTaskRuntime(runtime, model);
  for (let n = 0; n < input.steps; n++) {
    await engine.process(input.workspaceId, input.taskId);
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  process.stdout.write(`\nmodel-bundle-restart ${JSON.stringify({ bundleId: environment.bundle.id })}\n`);
} finally {
  await runtime.close();
  await registry.end();
  await health.end();
}
