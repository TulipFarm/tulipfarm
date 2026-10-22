import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { startKnowledgeEmbeddingWorkflow } from '../../api/dist/knowledge-embedding-dispatch.js';
import { createKnowledgeEmbeddingActivities } from '../dist/knowledge-embedding-activities.js';

test(
  'Temporal embedding execution stores only work IDs, returns no result, and does not retry an activity failure',
  { timeout: 120000 },
  async () => {
    const address = process.env.TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
    const oldQueue = process.env.TEMPORAL_TASK_QUEUE;
    const queue = `embedding-proof-${randomUUID()}`;
    process.env.TEMPORAL_TASK_QUEUE = queue;
    let connection, clientConnection, worker, running;
    try {
      connection = await NativeConnection.connect({ address });
      clientConnection = await Connection.connect({ address });
      const client = new Client({ connection: clientConnection });
      const temporal = { connection: clientConnection, client };
      const work = { workspaceId: randomUUID(), jobId: randomUUID(), generation: 1 };
      let attempts = 0;
      worker = await Worker.create({
        connection,
        taskQueue: `${queue}-knowledge-embeddings`,
        workflowsPath: fileURLToPath(new URL('../dist/knowledge-embedding-workflows.js', import.meta.url)),
        activities: createKnowledgeEmbeddingActivities({
          process: async value => {
            assert.deepEqual(value, work);
            attempts++;
            if (attempts === 1) throw new Error('private provider error, query text, and credential');
            return { vector: [1, 2], query: 'private cached text' };
          },
        }),
        maxConcurrentActivityTaskExecutions: 2,
      });
      running = worker.run();
      await startKnowledgeEmbeddingWorkflow(temporal, work);
      const handle = client.workflow.getHandle(`knowledge-embedding-${work.workspaceId}-${work.jobId}-1`);
      await assert.rejects(handle.result());
      assert.equal(attempts, 1);
      const failedRun = (await handle.describe()).runId;
      const failedHistory = await handle.fetchHistory();
      await startKnowledgeEmbeddingWorkflow(temporal, work);
      await handle.result();
      assert.notEqual((await handle.describe()).runId, failedRun);
      assert.equal(attempts, 2);
      const successfulHistory = await handle.fetchHistory();
      for (const history of [failedHistory, successfulHistory]) {
        let activityCount = 0;
        for (const event of history.events) {
          const scheduled = event.activityTaskScheduledEventAttributes;
          if (scheduled) {
            activityCount++;
            assert.equal(scheduled.retryPolicy.maximumAttempts, 1);
          }
          const payloads = event.workflowExecutionStartedEventAttributes?.input ?? scheduled?.input;
          if (payloads)
            assert.deepEqual(
              payloads.payloads.map(payload => JSON.parse(Buffer.from(payload.data).toString())),
              [work],
            );
          for (const payload of event.activityTaskCompletedEventAttributes?.result?.payloads ?? []) {
            assert.equal(Buffer.from(payload.metadata.encoding).toString(), 'binary/null');
            assert.equal(payload.data?.byteLength ?? 0, 0);
          }
        }
        assert.equal(activityCount, 1);
        for (const value of ['private provider error, query text, and credential', 'private cached text']) {
          assert.equal(JSON.stringify(history).includes(value), false);
          assert.equal(JSON.stringify(history).includes(Buffer.from(value).toString('base64')), false);
        }
      }
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
  },
);
