import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { createModelRouteHealth } from '../src/model-health.ts';
import { Client } from 'pg';
const input = JSON.parse(process.env.TASK_ACCOUNTING_INPUT);
const runtime = createWorkspaceRuntime({
  replicaCount: 1,
  reservedConnections: 2,
  databaseConnectionBudget: 20,
  resolveCredential: async workspaceId => ({ workspaceId, generation: 1, connectionString: input.connectionString }),
});
let registry;
try {
  if (input.callId) {
    await createAgentExecutor({ runtime }).execute({
      workspaceId: input.workspaceId,
      runId: input.runId,
      callId: input.callId,
    });
    process.send({ boundary: 'effect-committed' });
  } else {
    registry = new Client({ connectionString: input.registry });
    await registry.connect();
    const bundle = modelBundleSchema.parse({
      format: 1,
      id: 'accounting-test',
      mapping: {
        ...initialModelMapping,
        revision: 'accounting-test',
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
      legacyFamily: () => 'claude-opus',
      budgetPicoUsd: () => '10000000000000',
      health: createModelRouteHealth(registry, () => 'accounting-test'),
      infer: async () => {
        if (!input.settlementKill) throw new Error('No inference before file completion');
        await new Promise(resolve => setTimeout(resolve, 180));
        return {
          kind: 'success',
          decision: { kind: 'answer', text: 'Lost process decision.' },
          actualModel: input.route.modelId,
          requestId: 'process-proof',
          usage: { kind: 'known', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
        };
      },
    };
    const guarded = input.settlementKill
      ? {
          transaction: (workspaceId, range, operation) =>
            runtime.transaction(workspaceId, range, async tx => {
              const result = await operation(tx);
              if (
                (
                  await tx.client.query(
                    `SELECT 1 FROM "${tx.schema}".tf_credit_usage WHERE flow_id=$1 AND charged IS NOT NULL`,
                    [input.taskId],
                  )
                ).rowCount
              ) {
                process.send({ boundary: 'settlement-uncommitted' });
                await new Promise(() => {
                  setInterval(() => {}, 1000);
                });
              }
              return result;
            }),
        }
      : runtime;
    await createTaskRuntime(guarded, model, async () => {
      process.send({ boundary: 'file-active' });
      await new Promise(() => {
        setInterval(() => {}, 1000);
      });
    }).process(input.workspaceId, input.taskId);
  }
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
} finally {
  await runtime.close();
  await registry?.end();
}
