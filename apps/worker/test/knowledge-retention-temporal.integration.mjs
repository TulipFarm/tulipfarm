import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { startKnowledgeRetentionWorkflow } from '../../api/dist/knowledge-retention-dispatch.js';
import { createKnowledgeRetentionActivities } from '../dist/knowledge-retention-activities.js';
import { createKnowledgeWorker } from '../dist/knowledge-worker.js';

async function withWorker(activities, run) {
  const address = process.env.TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  const oldQueue = process.env.TEMPORAL_TASK_QUEUE;
  const queue = `retention-proof-${randomUUID()}`;
  process.env.TEMPORAL_TASK_QUEUE = queue;
  let connection, clientConnection, worker, running;
  try {
    connection = await NativeConnection.connect({ address });
    clientConnection = await Connection.connect({ address });
    const client = new Client({ connection: clientConnection });
    worker = await createKnowledgeWorker({
      connection,
      env: { TEMPORAL_TASK_QUEUE: queue },
      parts: { retention: activities },
    });
    running = worker.run();
    await run({ temporal: { client, connection: clientConnection } });
  } finally {
    if (worker) {
      worker.shutdown();
      await running;
    }
    await connection?.close();
    await clientConnection?.close();
    if (oldQueue === undefined) delete process.env.TEMPORAL_TASK_QUEUE;
    else process.env.TEMPORAL_TASK_QUEUE = oldQueue;
  }
}

function fakeRetention(workspaceId, batches) {
  const calls = [];
  return {
    calls,
    retention: {
      purge: async workspace => {
        assert.equal(workspace, workspaceId);
        calls.push(workspace);
        return batches.shift() ?? 0;
      },
    },
  };
}

test('the retention purge deletes batches until one removes nothing', { timeout: 60000 }, async () => {
  const workspaceId = randomUUID();
  const fake = fakeRetention(workspaceId, [250, 250, 17, 0, 5]);
  await withWorker(
    createKnowledgeRetentionActivities(fake.retention, async () => true),
    async ({ temporal }) => {
      await startKnowledgeRetentionWorkflow(temporal, workspaceId);
      await temporal.client.workflow.getHandle(`knowledge-retention-${workspaceId}`).result();
    },
  );
  assert.equal(fake.calls.length, 4);
});

test('switching the purge flag off stops the purge before it deletes anything', { timeout: 60000 }, async () => {
  const workspaceId = randomUUID();
  const fake = fakeRetention(workspaceId, [250]);
  await withWorker(
    createKnowledgeRetentionActivities(fake.retention, async () => false),
    async ({ temporal }) => {
      await startKnowledgeRetentionWorkflow(temporal, workspaceId);
      await temporal.client.workflow.getHandle(`knowledge-retention-${workspaceId}`).result();
    },
  );
  assert.deepEqual(fake.calls, []);
});
