import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { Client } from 'pg';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { createTaskRuntime } from '../dist/task-runtime.js';
import { createModelRouteHealth } from '../dist/model-health.js';
const input = JSON.parse(process.env.TASK_PROCESS_INPUT);
const runtime = createWorkspaceRuntime({
  replicaCount: 1,
  reservedConnections: 2,
  databaseConnectionBudget: 20,
  resolveCredential: async workspaceId => ({ workspaceId, generation: 1, connectionString: input.connectionString }),
});
const registry = new Client({ connectionString: input.registry });
await registry.connect();
const bundle = modelBundleSchema.parse({
  format: 1,
  id: 'task-process',
  mapping: {
    ...initialModelMapping,
    revision: 'task-process',
    families: initialModelMapping.families.filter(f => f.id === 'claude-opus'),
  },
  models: initialBundleModels,
  routes: [input.route],
});
const model = {
  activeBundle: () => ({ bundle, activationRevision: 1 }),
  trustedBundle: () => bundle,
  restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
  allowed: () => true,
  actualModelIds: () => [input.route.modelId],
  defaultFamily: () => 'claude-opus',
  budgetPicoUsd: () => '10000000000000',
  health: createModelRouteHealth(registry, () => 'task-process'),
  infer: async () => {
    process.send({ boundary: 'provider-dispatched' });
    await new Promise(() => {});
  },
};
try {
  await createTaskRuntime(runtime, input.mode === 'claim' ? model : null).process(input.workspaceId, input.taskId);
  process.send({ boundary: 'step-committed' });
  await new Promise(() => {});
} finally {
  await runtime.close();
  await registry.end();
}
