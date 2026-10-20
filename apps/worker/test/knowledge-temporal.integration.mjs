import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { knowledgeFixture } from '../../api/test/knowledge-fixture.mjs';
import { startKnowledgeWorkflow } from '../../api/dist/knowledge-dispatch.js';
import { createKnowledgeActivities } from '../dist/knowledge-activities.js';

test(
  'real Temporal starts converge across restart and actual knowledge activities keep document content out of history',
  { timeout: 120000 },
  async () => {
    const f = await knowledgeFixture({ filesEnabled: false });
    const address = process.env.TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
    let connection, clientConnection, worker, running;
    const previousQueue = process.env.TEMPORAL_TASK_QUEUE;
    const queue = `knowledge-proof-${randomUUID()}`;
    process.env.TEMPORAL_TASK_QUEUE = queue;
    try {
      connection = await NativeConnection.connect({ address });
      clientConnection = await Connection.connect({ address });
      const client = new Client({ connection: clientConnection });
      const temporal = { client, connection: clientConnection };
      const id = randomUUID(),
        text = '# Confidential orchard\nHarvest apples on Tuesday. private-temporal-note-content';
      const input = { ...f.command({ kind: 'note', text }), title: 'private-temporal-document-title' };
      assert.equal((await f.save(id, input)).status, 200);
      const work = { workspaceId: f.workspace.id, revisionId: input.commandId, generation: 1 };
      await startKnowledgeWorkflow(temporal, work);
      await startKnowledgeWorkflow(temporal, work);
      const startWorker = async () => {
        worker = await Worker.create({
          connection,
          taskQueue: `${queue}-knowledge`,
          workflowsPath: fileURLToPath(new URL('../dist/knowledge-workflows.js', import.meta.url)),
          activities: createKnowledgeActivities(f.runtime),
          maxConcurrentActivityTaskExecutions: 2,
        });
        running = worker.run();
      };
      await startWorker();
      const workflowId = `knowledge-${f.workspace.id}-${input.commandId}-1`;
      const handle = client.workflow.getHandle(workflowId);
      await handle.result();
      const firstRun = (await handle.describe()).runId;
      assert.equal((await f.service.get(f.workspace.id, f.signed.owner.id, id)).parsing, 'ready');
      worker.shutdown();
      await running;
      worker = undefined;
      await startKnowledgeWorkflow(temporal, work);
      assert.equal((await handle.describe()).runId, firstRun);
      const edit = {
        ...f.command({ kind: 'note', text: 'Revised orchard instructions. private-edited-note' }),
        expectedRevisionId: input.commandId,
      };
      assert.equal((await f.save(id, edit)).status, 200);
      const next = { workspaceId: f.workspace.id, revisionId: edit.commandId, generation: 1 };
      await startKnowledgeWorkflow(temporal, next);
      await startWorker();
      const second = client.workflow.getHandle(`knowledge-${f.workspace.id}-${edit.commandId}-1`);
      await second.result();
      assert.equal((await f.service.get(f.workspace.id, f.signed.owner.id, id)).revisionId, edit.commandId);
      assert.equal((await f.service.get(f.workspace.id, f.signed.owner.id, id)).parsing, 'ready');
      for (const [execution, expected] of [
        [handle, work],
        [second, next],
      ]) {
        const history = await execution.fetchHistory();
        let activityCount = 0;
        for (const event of history.events) {
          const scheduled = event.activityTaskScheduledEventAttributes;
          if (scheduled) activityCount++;
          const payloads = event.workflowExecutionStartedEventAttributes?.input ?? scheduled?.input;
          if (payloads)
            assert.deepEqual(
              payloads.payloads.map(payload => JSON.parse(Buffer.from(payload.data).toString())),
              [expected],
            );
          for (const payload of event.activityTaskCompletedEventAttributes?.result?.payloads ?? []) {
            assert.equal(Buffer.from(payload.metadata.encoding).toString(), 'binary/null');
            assert.equal(payload.data?.byteLength ?? 0, 0);
          }
        }
        assert.equal(activityCount, 1);
        const serialized = JSON.stringify(history);
        for (const privateValue of [text, input.title, f.signed.owner.id, 'private-edited-note']) {
          assert.equal(serialized.includes(privateValue), false);
          assert.equal(serialized.includes(Buffer.from(privateValue).toString('base64')), false);
        }
      }
    } finally {
      if (worker) {
        worker.shutdown();
        await running;
      }
      if (previousQueue === undefined) delete process.env.TEMPORAL_TASK_QUEUE;
      else process.env.TEMPORAL_TASK_QUEUE = previousQueue;
      await connection?.close();
      await clientConnection?.close();
      await f.close();
    }
  },
);
