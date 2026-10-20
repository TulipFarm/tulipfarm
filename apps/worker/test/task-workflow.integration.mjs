import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker, NativeConnection } from '@temporalio/worker';
import { Client, Connection } from '@temporalio/client';
import { createTaskComposition } from '../dist/task-composition.js';

const workflowsPath = fileURLToPath(new URL('../dist/workflows.js', import.meta.url));
test(
  'task workflows replay legacy histories, redact errors, back off and continue as new',
  { timeout: 300000 },
  async t => {
    const address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
    assert.ok(address, 'Owned Temporal is required');
    const connection = await NativeConnection.connect({ address }),
      clientConnection = await Connection.connect({ address });
    const client = new Client({ connection: clientConnection });
    t.after(async () => {
      await clientConnection.close();
      await connection.close();
    });
    await t.test('completed and outstanding legacy activity histories replay on new code', async () => {
      const queue = randomUUID();
      const worker = await Worker.create({
        connection,
        taskQueue: queue,
        workflowsPath: fileURLToPath(new URL('./fixtures/task-legacy-workflows.mjs', import.meta.url)),
        activities: { processAgentTask: async () => {} },
      });
      await worker.runUntil(async () => {
        const handle = await client.workflow.start('agentTaskStep', {
          workflowId: randomUUID(),
          taskQueue: queue,
          args: [randomUUID(), randomUUID()],
        });
        await handle.result();
        const history = await handle.fetchHistory();
        assert.equal(history.events.filter(event => event.activityTaskScheduledEventAttributes).length, 1);
        assert.equal(history.events.at(-1).workflowExecutionCompletedEventAttributes !== null, true);
        await Worker.runReplayHistory({ workflowsPath }, history);
        const scheduled = history.events.findIndex(event => event.activityTaskScheduledEventAttributes);
        await Worker.runReplayHistory({ workflowsPath }, { events: history.events.slice(0, scheduled + 1) });
      });
    });
    await t.test('replacement worker completes a genuinely outstanding legacy activity exactly once', async () => {
      const queue = randomUUID();
      const oldWorker = await Worker.create({
        connection,
        taskQueue: queue,
        workflowsPath: fileURLToPath(new URL('./fixtures/task-legacy-workflows.mjs', import.meta.url)),
      });
      const oldRun = oldWorker.run();
      let handle;
      try {
        handle = await client.workflow.start('agentTaskStep', {
          workflowId: randomUUID(),
          taskQueue: queue,
          args: [randomUUID(), randomUUID()],
        });
        for (let n = 0; ; n++) {
          if ((await handle.fetchHistory()).events.some(event => event.activityTaskScheduledEventAttributes)) break;
          assert.ok(n < 100, 'Legacy activity is scheduled before replacement');
          await delay(100);
        }
      } finally {
        oldWorker.shutdown();
        await oldRun;
      }
      let calls = 0;
      const replacement = await Worker.create({
        connection,
        taskQueue: queue,
        workflowsPath,
        activities: {
          processAgentTask: async () => {
            calls++;
          },
          processAgentTaskStep: async () => assert.fail('Legacy history must retain the void activity'),
        },
      });
      await replacement.runUntil(() => handle.result());
      assert.equal(calls, 1);
      const history = await handle.fetchHistory();
      assert.deepEqual(
        history.events
          .filter(event => event.activityTaskScheduledEventAttributes)
          .map(event => event.activityTaskScheduledEventAttributes.activityType.name),
        ['processAgentTask'],
      );
      assert.ok(history.events.at(-1).workflowExecutionCompletedEventAttributes);
      await Worker.runReplayHistory({ workflowsPath }, history);
    });
    await t.test('100 durable waits roll history over, same ID has one chain and no hot polling', async () => {
      const queue = randomUUID(),
        timestamps = [],
        results = [];
      const worker = await Worker.create({
        connection,
        taskQueue: queue,
        workflowsPath,
        activities: {
          processAgentTaskStep: async () => {
            timestamps.push(Date.now());
            const result = { kind: timestamps.length <= 100 ? 'runnable' : 'terminal' };
            results.push(result);
            return result;
          },
        },
      });
      await worker.runUntil(async () => {
        const options = {
          workflowId: randomUUID(),
          taskQueue: queue,
          args: [randomUUID(), randomUUID()],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'ALLOW_DUPLICATE',
        };
        const [handle, duplicate] = await Promise.all([
          client.workflow.start('agentTaskStep', options),
          client.workflow.start('agentTaskStep', options),
        ]);
        assert.equal(handle.firstExecutionRunId, duplicate.firstExecutionRunId);
        await handle.result();
        assert.equal(timestamps.length, 101);
        assert.deepEqual(results.at(-1), { kind: 'terminal' });
        for (let index = 1; index < timestamps.length; index++)
          assert.ok(timestamps[index] - timestamps[index - 1] >= 1900);
        const first = await client.workflow.getHandle(options.workflowId, handle.firstExecutionRunId).fetchHistory();
        assert.equal(first.events.filter(event => event.activityTaskScheduledEventAttributes).length, 100);
        assert.equal(first.events.filter(event => event.timerStartedEventAttributes).length, 100);
        const rollover = first.events.at(-1).workflowExecutionContinuedAsNewEventAttributes;
        assert.ok(rollover.newExecutionRunId);
        const next = await client.workflow.getHandle(options.workflowId, rollover.newExecutionRunId).fetchHistory();
        assert.equal(next.events.filter(event => event.activityTaskScheduledEventAttributes).length, 1);
        await Worker.runReplayHistory({ workflowsPath }, first);
        await Worker.runReplayHistory({ workflowsPath }, next);
      });
    });
    await t.test('composition strips private exception details before Temporal failure storage', async () => {
      const before = process.env;
      process.env = { PATH: before.PATH };
      const composition = createTaskComposition({
        transaction: async () => {
          throw new Error('PRIVATE_DATABASE_ERROR_CANARY');
        },
      });
      process.env = before;
      const queue = randomUUID();
      const worker = await Worker.create({
        connection,
        taskQueue: queue,
        workflowsPath,
        activities: composition.activities,
      });
      try {
        await worker.runUntil(async () => {
          const handle = await client.workflow.start('agentTaskStep', {
            workflowId: randomUUID(),
            taskQueue: queue,
            args: [randomUUID(), randomUUID()],
          });
          await new Promise(resolve => setTimeout(resolve, 1500));
          const pending = await handle.describe();
          assert.equal(pending.status.name, 'RUNNING');
          await handle.terminate('Test cleanup');
          const history = JSON.stringify(await handle.fetchHistory(), (_key, value) =>
            value instanceof Uint8Array
              ? Buffer.from(value).toString('utf8')
              : value?.type === 'Buffer' && Array.isArray(value.data)
                ? Buffer.from(value.data).toString('utf8')
                : value,
          );
          assert.equal(history.includes('PRIVATE_DATABASE_ERROR_CANARY'), false);
          assert.equal(JSON.stringify(pending.raw.pendingActivities).includes('task-step-unavailable'), true);
          assert.equal(JSON.stringify(pending.raw.pendingActivities).includes('PRIVATE_DATABASE_ERROR_CANARY'), false);
        });
      } finally {
        await composition.close();
      }
    });
  },
);
