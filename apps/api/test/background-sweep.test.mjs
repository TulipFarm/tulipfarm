import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { backgroundSweeps, readyWorkspaces, sweepFailureBackoffMs } from '../src/background-sweep.ts';
import { errorAttributes } from '@tulipfarm/observability';
import { randomUUID } from 'node:crypto';
import { taskActionWake, taskWake } from '../src/task-dispatch.ts';
import { registerAgentTasks } from '../src/agent-tasks.ts';

test('workspace discovery retains the original error and safe stage without changing the query', async () => {
  const failure = Object.freeze(
    new Error('PRIVATE integration context', {
      cause: Object.assign(new Error('PRIVATE SQL'), { code: '08006' }),
    }),
  );
  await assert.rejects(
    readyWorkspaces(
      {
        query: async (sql, parameters) => {
          assert.match(sql, /FROM app\.workspace_storage WHERE stage = 'ready'/);
          assert.match(sql, /LIMIT 100$/);
          assert.deepEqual(parameters, [null]);
          throw failure;
        },
      },
      null,
      100,
    ),
    error => error === failure,
  );
  assert.deepEqual(errorAttributes(failure), {
    'error.type': 'Error',
    'error.stage': 'workspace-discovery',
    'error.code': '08006',
    'error.reason': 'Database connection failed',
  });
  const rows = [{ workspace_id: randomUUID() }];
  assert.deepEqual(await readyWorkspaces({ query: async () => ({ rows }) }, null, 100), rows);
});

test('independent sweeps never overlap and shutdown stops every loop before waiting for work', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const app = Fastify();
  const release = [Promise.withResolvers(), Promise.withResolvers()];
  const runs = [0, 0];
  const stopped = [];
  backgroundSweeps(
    app,
    release.map((gate, index) => ({
      job: index === 0 ? 'workflow-dispatch' : 'provider-dispatch',
      failure: 'failed',
      run: async isStopped => {
        runs[index]++;
        stopped[index] = isStopped;
        await gate.promise;
      },
    })),
  );
  await app.ready();
  assert.deepEqual(runs, [1, 1]);
  t.mock.timers.tick(6000);
  assert.deepEqual(runs, [1, 1]);
  const closing = app.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    stopped.map(read => read()),
    [true, true],
  );
  t.mock.timers.tick(6000);
  assert.deepEqual(runs, [1, 1]);
  for (const gate of release) gate.resolve();
  await closing;
});

test('a failing sweep backs off up to a minute and returns to every tick once it succeeds', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const app = Fastify();
  const errors = [];
  t.mock.method(app.log, 'error', message => errors.push(message));
  const runs = [];
  let failing = true;
  backgroundSweeps(app, [
    {
      job: 'workflow-dispatch',
      failure: 'sweep failed',
      run: async () => {
        runs.push(Date.now());
        if (failing) throw new Error('timeout exceeded when trying to connect');
      },
    },
  ]);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  async function advance(ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += 2000) {
      t.mock.timers.tick(2000);
      await settle();
    }
  }
  await app.ready();
  await settle();
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(sweepFailureBackoffMs), [0, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
  await advance(150_000);
  // 0 s, then 4, 8, 16, 32 and 60 s after each failure.
  assert.deepEqual(
    runs.map(at => at / 1000),
    [0, 4, 12, 28, 60, 120],
  );
  assert.equal(errors.length, runs.length);
  assert.deepEqual(new Set(errors), new Set(['sweep failed']));
  failing = false;
  await advance(30_000);
  assert.equal(runs.at(-1), 180_000);
  const recovered = runs.length;
  await advance(6000);
  assert.equal(runs.length, recovered + 3);
  assert.equal(errors.length, 6);
  await app.close();
});

test('task wake signals the stable workflow immediately and leaves committed commands successful on Temporal failure', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const calls = [],
    errors = [];
  t.mock.method(app.log, 'error', (...args) => errors.push(args));
  let unavailable = false;
  const wake = taskWake(app, {
    connection: {
      withDeadline: async (deadline, operation) => {
        assert.ok(deadline > Date.now());
        return operation();
      },
    },
    client: {
      workflow: {
        signalWithStart: async (...args) => {
          calls.push(args);
          if (unavailable) throw new Error('PRIVATE_TEMPORAL_CANARY');
        },
      },
    },
  });
  const workspaceId = randomUUID(),
    taskId = randomUUID();
  await wake(workspaceId, taskId);
  assert.equal(calls[0][0], 'agentTaskStep');
  assert.deepEqual(calls[0][1], {
    workflowId: `agent-task-v1-${workspaceId}-${taskId}`,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tulipfarm',
    args: [workspaceId, taskId],
    signal: 'wakeAgentTask',
    signalArgs: [],
    workflowIdConflictPolicy: 'USE_EXISTING',
    workflowIdReusePolicy: 'ALLOW_DUPLICATE',
  });
  unavailable = true;
  await wake(workspaceId, taskId);
  assert.equal(errors.length, 1);
  assert.equal(JSON.stringify(errors).includes('PRIVATE_TEMPORAL_CANARY'), false);
});

test('task mutations that fail authorization or commit never dispatch a workflow', async t => {
  const app = Fastify(),
    wakes = [];
  t.after(() => app.close());
  registerAgentTasks(app, {
    runtime: {
      transaction: async () => {
        throw new Error('transaction-rolled-back');
      },
    },
    auth: { api: { getSession: async () => ({ user: { id: randomUUID() } }) } },
    wake: async (...args) => wakes.push(args),
  });
  const response = await app.inject({
    method: 'POST',
    url: `/workspaces/${randomUUID()}/agent-tasks`,
    headers: { origin: 'http://localhost:5173' },
    payload: { requestId: randomUUID(), agentId: randomUUID(), text: 'Start only after commit' },
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(wakes, []);
});

test('action wake resolves task IDs through workspace storage without exposing action content', async t => {
  const app = Fastify(),
    calls = [],
    workspaceId = randomUUID(),
    taskId = randomUUID(),
    actionId = randomUUID();
  t.after(() => app.close());
  const wake = taskActionWake(
    app,
    {
      transaction: async (workspace, _range, operation) => {
        assert.equal(workspace, workspaceId);
        return operation({
          schema: 'fixture',
          client: {
            query: async (sql, args) => {
              assert.ok(sql.includes('tf_agent_task_steps'));
              assert.deepEqual(args, [actionId]);
              return { rows: [{ task_id: taskId }] };
            },
          },
        });
      },
    },
    async (...args) => calls.push(args),
  );
  await wake(workspaceId, actionId);
  assert.deepEqual(calls, [[workspaceId, taskId]]);
});
