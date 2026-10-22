import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';

const workflowsPath = fileURLToPath(new URL('../dist/workflows.js', import.meta.url));

test(
  'plan steps run specialists beside the loop, wake when they finish and run each attempt once',
  { timeout: 30000 },
  async t => {
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
    const ran = [];
    let advances = 0,
      finished = 0;
    const worker = await Worker.create({
      connection,
      taskQueue: queue,
      workflowsPath,
      activities: {
        advanceAgentPlan: async () => {
          advances++;
          if (advances === 1) return { kind: 'waiting', specialists: ['first', 'second'] };
          if (finished === 1 && !ran.includes('third')) return { kind: 'waiting', specialists: ['third'] };
          return finished === 3 ? { kind: 'terminal', specialists: [] } : { kind: 'waiting', specialists: [] };
        },
        runPlanSpecialist: async (_workspaceId, attemptId) => {
          ran.push(attemptId);
          await delay(attemptId === 'first' ? 100 : 600);
          finished++;
        },
      },
    });
    await worker.runUntil(async () => {
      const started = Date.now();
      const handle = await client.workflow.start('agentPlanStep', {
        workflowId: randomUUID(),
        taskQueue: queue,
        args: [randomUUID(), randomUUID()],
      });
      await handle.result();
      assert.ok(
        Date.now() - started < 10000,
        'finishing specialists wake the plan without waiting for the 30-second poll',
      );
      assert.deepEqual(ran.sort(), ['first', 'second', 'third']);
      await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory());
    });
  },
);

test(
  'a terminal plan waits for running specialists, and a wake reopens a finished plan',
  { timeout: 30000 },
  async t => {
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
    let advances = 0,
      settled = false;
    const worker = await Worker.create({
      connection,
      taskQueue: queue,
      workflowsPath,
      activities: {
        advanceAgentPlan: async () =>
          ++advances === 1 ? { kind: 'terminal', specialists: ['late'] } : { kind: 'terminal', specialists: [] },
        runPlanSpecialist: async () => {
          await delay(300);
          settled = true;
        },
      },
    });
    await worker.runUntil(async () => {
      const options = {
        workflowId: randomUUID(),
        taskQueue: queue,
        args: [randomUUID(), randomUUID()],
        signal: 'wakeAgentPlan',
        signalArgs: [],
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE',
      };
      const first = await client.workflow.signalWithStart('agentPlanStep', options);
      await first.result();
      assert.equal(settled, true, 'the workflow does not end while a specialist still runs');
      assert.equal(advances, 2, 'a finished specialist triggers one more step');
      const reopened = await client.workflow.signalWithStart('agentPlanStep', options);
      await reopened.result();
      assert.notEqual(reopened.signaledRunId, first.signaledRunId);
      assert.equal(advances, 3);
    });
  },
);
