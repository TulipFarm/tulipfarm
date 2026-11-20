import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { KnowledgeKeepUnavailable } from '@tulipfarm/knowledge';
import { startKnowledgeKeepWorkflow } from '../../api/dist/knowledge-keep-dispatch.js';
import { createKnowledgeKeepActivities } from '../dist/knowledge-keep-activities.js';

test(
  'Keep sync pages through due documents, retries Keep outages and records a failing document without stopping',
  { timeout: 120000 },
  async () => {
    const address = process.env.TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
    const oldQueue = process.env.TEMPORAL_TASK_QUEUE;
    const queue = `keep-proof-${randomUUID()}`;
    process.env.TEMPORAL_TASK_QUEUE = queue;
    let connection, clientConnection, worker, running;
    try {
      connection = await NativeConnection.connect({ address });
      clientConnection = await Connection.connect({ address });
      const client = new Client({ connection: clientConnection });
      const workspaceId = randomUUID();
      const [flaky, broken, ...rest] = Array.from({ length: 103 }, () => randomUUID()).toSorted();
      const due = new Set([flaky, broken, ...rest]);
      const attempts = new Map();
      const failures = [];
      const pages = [];
      worker = await Worker.create({
        connection,
        taskQueue: `${queue}-knowledge-keep`,
        workflowsPath: fileURLToPath(new URL('../dist/knowledge-keep-workflows.js', import.meta.url)),
        activities: createKnowledgeKeepActivities({
          due: async (workspace, after, limit) => {
            assert.equal(workspace, workspaceId);
            pages.push(after);
            return [...due]
              .filter(id => after === null || id > after)
              .slice(0, limit)
              .map(document_id => ({ document_id, action: 'deliver' }));
          },
          sync: async (workspace, document) => {
            attempts.set(document, (attempts.get(document) ?? 0) + 1);
            if (document === flaky && attempts.get(document) === 1) throw new KnowledgeKeepUnavailable('unreachable');
            if (document === broken) throw new Error('unexpected state');
            due.delete(document);
            return { status: 'delivered', publicationId: randomUUID() };
          },
          recordFailure: async (workspace, document, error, permanent) => {
            failures.push({ document, error, permanent });
          },
        }),
        maxConcurrentActivityTaskExecutions: 2,
      });
      running = worker.run();
      await startKnowledgeKeepWorkflow({ connection: clientConnection, client }, workspaceId);
      await client.workflow.getHandle(`knowledge-keep-${workspaceId}`).result();
      assert.equal(attempts.get(flaky), 2, 'a Keep outage is retried');
      assert.equal(attempts.get(broken), 1, 'a document-specific failure is not retried');
      assert.deepEqual(failures, [{ document: broken, error: 'unexpected state', permanent: true }]);
      assert.deepEqual([...due], [broken]);
      assert.deepEqual(pages, [null, rest[97]]);
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
