import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createTaskDispatcher } from '../src/task-dispatch.ts';

const workflowsPath = fileURLToPath(new URL('../dist/workflows.js', import.meta.url));

test('pre-signal durable task histories still replay their completed waits', { timeout: 30000 }, async t => {
  const address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
  assert.ok(address, 'Owned Temporal is required');
  const connection = await NativeConnection.connect({ address }),
    clientConnection = await Connection.connect({ address });
  t.after(async () => {
    await clientConnection.close();
    await connection.close();
  });
  const client = new Client({ connection: clientConnection }),
    queue = randomUUID();
  const worker = await Worker.create({
    connection,
    taskQueue: queue,
    workflowsPath: fileURLToPath(new URL('./fixtures/task-durable-workflows.mjs', import.meta.url)),
    activities: { processAgentTaskStep: async () => ({ kind: 'waiting' }) },
  });
  await worker.runUntil(async () => {
    const handle = await client.workflow.start('agentTaskStep', {
      workflowId: randomUUID(),
      taskQueue: queue,
      args: [randomUUID(), randomUUID()],
    });
    await handle.result();
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory());
  });
});

test('task wake survives a stale waiting result and restarts a completed workflow', { timeout: 30000 }, async t => {
  const address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
  assert.ok(address, 'Owned Temporal is required');
  const connection = await NativeConnection.connect({ address }),
    clientConnection = await Connection.connect({ address });
  t.after(async () => {
    await clientConnection.close();
    await connection.close();
  });
  const client = new Client({ connection: clientConnection }),
    queue = randomUUID();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let calls = 0;
  const worker = await Worker.create({
    connection,
    taskQueue: queue,
    workflowsPath,
    activities: {
      processAgentTaskStep: async () => {
        calls++;
        if (calls === 1) {
          entered.resolve();
          await release.promise;
          return { kind: 'waiting' };
        }
        return { kind: 'terminal' };
      },
    },
  });
  await worker.runUntil(async () => {
    const options = {
      workflowId: randomUUID(),
      taskQueue: queue,
      args: [randomUUID(), randomUUID()],
      signal: 'wakeAgentTask',
      signalArgs: [],
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    };
    const first = await client.workflow.signalWithStart('agentTaskStep', options);
    await entered.promise;
    await client.workflow.signalWithStart('agentTaskStep', options);
    release.resolve();
    await first.result();
    assert.equal(calls, 2, 'Wake received during an activity is not lost when that activity returns waiting');
    const history = await first.fetchHistory();
    await Worker.runReplayHistory({ workflowsPath }, history);
    const reopened = await client.workflow.signalWithStart('agentTaskStep', options);
    await reopened.result();
    assert.notEqual(reopened.signaledRunId, first.signaledRunId);
    assert.equal(calls, 3);
  });
});

test(
  'all worker replicas share one slow recovery workflow and isolate unavailable workspaces',
  { timeout: 30000 },
  async t => {
    const address = process.env.TASK_TEST_TEMPORAL_ADDRESS;
    assert.ok(address, 'Owned Temporal is required');
    const before = process.env;
    const queue = randomUUID();
    process.env = { ...before, TEMPORAL_ADDRESS: address, TEMPORAL_TASK_QUEUE: queue };
    const first = createTaskDispatcher(() => assert.fail('Unexpected dispatch failure'));
    const second = createTaskDispatcher(() => assert.fail('Unexpected dispatch failure'));
    process.env = before;
    const connection = await NativeConnection.connect({ address });
    t.after(async () => {
      await first.close();
      await second.close();
      await connection.close();
    });
    const workspaces = [randomUUID(), randomUUID()],
      pages = [],
      entered = Promise.withResolvers();
    let discoveries = 0;
    const worker = await Worker.create({
      connection,
      taskQueue: queue,
      workflowsPath,
      activities: {
        discoverAgentTaskWorkspaces: async after => {
          assert.equal(after, null);
          discoveries++;
          return workspaces;
        },
        recoverAgentTaskPage: async (workspaceId, after) => {
          pages.push([workspaceId, after]);
          if (workspaceId === workspaces[0]) throw ApplicationFailure.nonRetryable('workspace-unavailable');
          if (!after) return randomUUID();
          entered.resolve();
          return null;
        },
      },
    });
    await worker.runUntil(async () => {
      const [one, two] = await Promise.all([first.startRecovery(), second.startRecovery()]);
      try {
        assert.equal(one.firstExecutionRunId, two.firstExecutionRunId);
        await entered.promise;
        await delay(500);
        assert.equal(discoveries, 1);
        assert.equal(pages.length, 3);
        const history = await one.fetchHistory();
        assert.equal(
          history.events.filter(event => Number(event.timerStartedEventAttributes?.startToFireTimeout?.seconds) === 60)
            .length,
          1,
        );
        await Worker.runReplayHistory({ workflowsPath }, history);
      } finally {
        await one.terminate('Test cleanup');
      }
    });
  },
);
