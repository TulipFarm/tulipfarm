import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Client, Connection } from '@temporalio/client';
import { createWorkflows } from '../../../packages/workflows/src/service.ts';
import { businessWorkflowId } from '@tulipfarm/workflows/contracts';
import { outboundFixture } from '../../../packages/agents/test/slack-actions.integration.mjs';
import { taskActionWake } from '../src/task-dispatch.ts';
import { workflowWake } from '../src/workflow-dispatch.ts';

const { Worker, NativeConnection } = createRequire(new URL('../../worker/package.json', import.meta.url))(
  '@temporalio/worker',
);

test(
  'native Slack workflow decision wakes a real durable business workflow and sends once',
  { timeout: 60000 },
  async () => {
    const f = await outboundFixture(),
      app = Fastify({ logger: false });
    let native, connection, worker, running;
    try {
      const address = process.env.TASK_TEST_TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
      native = await NativeConnection.connect({ address });
      connection = await Connection.connect({ address });
      const client = new Client({ connection }),
        taskQueue = `workflow-slack-${randomUUID()}`;
      const service = createWorkflows(f.runtime, { slackActions: f.service });
      const workflowId = randomUUID(),
        revision = randomUUID(),
        w = f.workspace;
      await service.save(w.id, w.userId, workflowId, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Slack wake',
          trigger: { kind: 'manual' },
          steps: [
            {
              id: 'send',
              kind: 'slack-message',
              destinationId: f.destinationId,
              text: { kind: 'literal', value: 'Synthetic Temporal send' },
            },
          ],
        },
      });
      await service.activate(w.id, w.userId, workflowId, {
        commandId: randomUUID(),
        expectedGeneration: 1,
        revision,
        enabled: true,
      });
      const { runId } = await service.start(w.id, w.userId, workflowId, { requestId: randomUUID(), input: {} });
      const work = { workspaceId: w.id, runId };
      worker = await Worker.create({
        connection: native,
        taskQueue,
        workflowsPath: fileURLToPath(new URL('../../../packages/workflows/src/temporal.ts', import.meta.url)),
        activities: { advanceWorkflow: service.advance },
      });
      running = worker.run();
      const handle = await client.workflow.start('businessWorkflowV1', {
        workflowId: businessWorkflowId(work),
        taskQueue,
        args: [work],
      });
      for (let attempt = 0; ; attempt++) {
        if ((await handle.fetchHistory()).events.some(event => event.timerStartedEventAttributes)) break;
        assert.ok(attempt < 200, 'approval is durably parked');
        await delay(50);
      }
      const [run] = (await service.history(w.id, w.userId, workflowId)).runs;
      const actionId = run.steps[0].output.actionId;
      const action = await f.service.read(w.id, w.userId, actionId);
      assert.equal(action.status, 'pending');
      assert.equal(f.effects.length, 0);
      const wake = taskActionWake(
        app,
        f.runtime,
        async () => assert.fail('not an agent task'),
        workflowWake(app, { connection, client }),
      );
      await f.decide(w.id, w.userId, actionId, { digest: action.digest, decision: 'approve' });
      await wake(w.id, actionId);
      await wake(w.id, actionId);
      assert.notEqual(await Promise.race([handle.result(), delay(10000, 'timeout', { ref: false })]), 'timeout');
      assert.equal(f.effects.length, 1);
      assert.equal((await service.history(w.id, w.userId, workflowId)).runs[0].status, 'completed');
      assert.ok((await handle.fetchHistory()).events.some(event => event.timerCanceledEventAttributes));
    } finally {
      if (worker) {
        worker.shutdown();
        await running;
      }
      await native?.close();
      await connection?.close();
      await app.close();
      await f.close();
    }
  },
);
