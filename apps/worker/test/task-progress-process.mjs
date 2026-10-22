import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Worker, NativeConnection } from '@temporalio/worker';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createTaskComposition } from '../dist/task-composition.js';
import { createTaskDispatcher, createTaskRecovery } from '../dist/task-dispatch.js';

assert.equal(process.env.DATABASE_URL, undefined);
const input = JSON.parse(process.env.TASK_PROGRESS_INPUT);
const fetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
  return fetch(input.provider, options);
};
const runtime = createWorkspaceRuntime({
  replicaCount: 1,
  reservedConnections: 2,
  databaseConnectionBudget: 20,
  resolveCredential: async workspaceId => ({ workspaceId, generation: 1, connectionString: input.runtime }),
});
let rolledBack = false;
const accountingRuntime = {
  transaction: (workspaceId, range, operation) =>
    runtime.transaction(workspaceId, range, async tx => {
      const result = await operation(tx);
      if (
        !rolledBack &&
        (
          await tx.client.query(
            `SELECT 1 FROM "${tx.schema}".tf_agent_task_model_accounting a JOIN "${tx.schema}".tf_credit_usage u ON u.id=a.attempt_id::text WHERE a.task_id=$1 AND a.observation->'usage'->>'kind'='known' AND u.charged IS NOT NULL`,
            [input.lateAccountingRollback],
          )
        ).rowCount
      ) {
        rolledBack = true;
        process.send({ boundary: 'accounting-rollback' });
        throw new Error('test settlement rollback');
      }
      return result;
    }),
};
const composition = createTaskComposition(input.lateAccountingRollback ? accountingRuntime : runtime);
if (input.lateAccountingRollback) {
  const infer = composition.model.infer;
  composition.model.infer = (resolution, request) => infer(resolution, request, 45000);
}
const connection = await NativeConnection.connect({ address: input.address });
process.env.TEMPORAL_ADDRESS = input.address;
process.env.TEMPORAL_TASK_QUEUE = input.queue;
const dispatch = createTaskDispatcher(() => process.send({ boundary: 'dispatch-failed' }));
const recovery = createTaskRecovery({
  runtime,
  discover: async () => [input.workspaceId],
  wake: dispatch.wake,
  failure: () => process.send({ boundary: 'recovery-failed' }),
});
let held = false;
const worker = await Worker.create({
  connection,
  taskQueue: input.queue,
  workflowsPath: fileURLToPath(new URL('../dist/workflows.js', import.meta.url)),
  activities: {
    ...composition.activities,
    ...recovery,
    processAgentTaskStep: async (...args) => {
      const result = await composition.activities.processAgentTaskStep(...args);
      process.send({ processed: args[1], result });
      if (input.holdFirst && !held) {
        held = true;
        process.send({ boundary: 'step-persisted' });
        await once(process, 'message');
      }
      return result;
    },
  },
});
await dispatch.startRecovery();
process.send({ ready: true });
process.on('SIGTERM', () => worker.shutdown());
try {
  await worker.run();
} finally {
  await dispatch.close();
  await connection.close();
  await composition.close();
  await runtime.close();
  process.disconnect();
}
