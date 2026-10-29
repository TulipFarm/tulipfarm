import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createWorkspaceRuntime, StorageUnavailableError } from '../../src/runtime.ts';
import { fixture } from './fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createBackgroundJob } from '@tulipfarm/observability';

async function setup(t, settings = {}) {
  const db = await fixture();
  const workspace = await db.create().catch(async error => {
    await db.close();
    throw error;
  });
  let generation = 1;
  const resolveCredential = async () => ({
    workspaceId: workspace.id,
    generation,
    connectionString: db.login(workspace),
  });
  let backgroundNext = false;
  const runtime = createWorkspaceRuntime({
    maxPools: 1,
    connectionsPerPool: 1,
    maxConcurrentTransactions: 2,
    maxQueue: 2,
    waitTimeoutMs: 3000,
    connectionTimeoutMs: 3000,
    statementTimeoutMs: 10000,
    idleTimeoutMs: 10000,
    replicaCount: 1,
    reservedConnections: 0,
    databaseConnectionBudget: 10,
    resolveCredential,
    background: () => backgroundNext,
    ...settings,
  });
  // Open gates first: close waits for every active transaction, so a failed test would otherwise hang in teardown.
  const releases = [];
  t.after(async () => {
    for (const release of releases) release();
    try {
      await runtime.close();
    } finally {
      await db.close();
    }
  });
  const gate = () => {
    const resolvers = Promise.withResolvers();
    releases.push(resolvers.resolve);
    return resolvers;
  };
  const run = (background, operation) => {
    backgroundNext = background;
    return runtime.transaction(workspace.id, commonCompatibility, operation);
  };
  const hold = background => {
    const entered = gate();
    const release = gate();
    const done = run(background, async () => {
      entered.resolve();
      await release.promise;
    });
    return { entered: entered.promise, release: release.resolve, done };
  };
  return { db, workspace, runtime, run, hold, gate, rotate: () => generation++ };
}

async function eventually(check, message) {
  const until = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < until, message);
    await delay(5);
  }
}

test('jobs leave an admission slot free, so a request is admitted at once', { timeout: 15000 }, async t => {
  const { runtime, run, hold } = await setup(t, { connectionsPerPool: 2, maxConcurrentTransactions: 2 });
  const job = hold(true);
  await job.entered;
  const queuedJob = run(true, async () => 'job');
  await eventually(() => runtime.stats().queuedBackgroundTransactions === 1, 'second job waits for the job cap');
  assert.equal(await run(false, async ({ client }) => (await client.query('SELECT 1 AS one')).rows[0].one), 1);
  job.release();
  assert.equal(await queuedJob, 'job');
  assert.equal(runtime.stats().activeBackgroundTransactions, 0);
});

test('a request queued for admission goes ahead of earlier queued jobs', { timeout: 15000 }, async t => {
  const { runtime, run, hold } = await setup(t, { connectionsPerPool: 2, maxConcurrentTransactions: 1, maxQueue: 3 });
  const first = hold(false);
  await first.entered;
  const order = [];
  const jobs = [run(true, async () => order.push('job')), run(true, async () => order.push('job'))];
  await eventually(() => runtime.stats().queuedBackgroundTransactions === 2, 'jobs queue');
  const request = run(false, async () => order.push('request'));
  await eventually(() => runtime.stats().queuedTransactions === 3, 'request queues');
  first.release();
  await Promise.all([request, ...jobs]);
  assert.deepEqual(order, ['request', 'job', 'job']);
});

test('queued jobs never fill the admission queue for requests', { timeout: 15000 }, async t => {
  const { runtime, run, hold } = await setup(t, { maxConcurrentTransactions: 1, maxQueue: 1 });
  const first = hold(false);
  await first.entered;
  const job = run(true, async () => 'job');
  await eventually(() => runtime.stats().queuedBackgroundTransactions === 1, 'job queues');
  await assert.rejects(
    run(true, async () => 'second job'),
    error => error instanceof StorageUnavailableError && error.code === 'queue_full',
  );
  const request = run(false, async () => 'request');
  await eventually(() => runtime.stats().queuedTransactions === 2, 'request queues beside the job');
  first.release();
  assert.equal(await request, 'request');
  assert.equal(await job, 'job');
});

test('a freed pool connection goes to a waiting request before a waiting job', { timeout: 15000 }, async t => {
  const { runtime, run, hold } = await setup(t, {
    connectionsPerPool: 1,
    maxConcurrentTransactions: 3,
    maxBackgroundTransactions: 2,
  });
  const job = hold(true);
  await job.entered;
  const order = [];
  const queuedJob = run(true, async () => order.push('job'));
  await eventually(() => runtime.stats().activeTransactions === 2, 'job waits for the connection');
  await delay(20);
  const request = run(false, async () => order.push('request'));
  await eventually(() => runtime.stats().activeTransactions === 3, 'request waits for the connection');
  await delay(20);
  job.release();
  await Promise.all([queuedJob, request]);
  assert.deepEqual(order, ['request', 'job']);
  assert.equal(runtime.stats().connections, 1);
});

for (const [reserved, expected] of [
  [0, ['request', 'job']],
  [1, ['job', 'request']],
]) {
  test(`with ${reserved} reserved job slots, a freed slot goes ${expected[0]} first`, { timeout: 15000 }, async t => {
    const { runtime, run, hold, gate } = await setup(t, {
      connectionsPerPool: 2,
      maxConcurrentTransactions: 2,
      maxQueue: 2,
      reservedBackgroundTransactions: reserved,
    });
    const requests = [hold(false), hold(false)];
    await Promise.all(requests.map(request => request.entered));
    const order = [];
    // Queued work stays open, so the first one cannot hand its slot to the second before the order is read.
    const finish = gate();
    const queue = name => async () => {
      order.push(name);
      await finish.promise;
    };
    const queued = [run(false, queue('request')), run(true, queue('job'))];
    await eventually(() => runtime.stats().queuedTransactions === 2, 'request and job queue');
    requests[0].release();
    await eventually(() => order.length === 1, 'one queued transaction runs');
    requests[1].release();
    await eventually(() => order.length === 2, 'the other queued transaction runs');
    finish.resolve();
    await Promise.all(queued);
    assert.deepEqual(order, expected);
  });
}

test(
  'a freed pool connection goes to a waiting job while jobs hold none of the reserve',
  { timeout: 15000 },
  async t => {
    const { runtime, run, hold, gate } = await setup(t, {
      connectionsPerPool: 2,
      maxConcurrentTransactions: 4,
      reservedBackgroundTransactions: 1,
    });
    const requests = [hold(false), hold(false)];
    await Promise.all(requests.map(request => request.entered));
    const order = [];
    const finish = gate();
    const queue = name => async () => {
      order.push(name);
      await finish.promise;
    };
    const request = run(false, queue('request'));
    await eventually(() => runtime.stats().activeTransactions === 3, 'request waits for a connection');
    const job = run(true, queue('job'));
    await eventually(() => runtime.stats().activeTransactions === 4, 'job waits for a connection');
    requests[0].release();
    await eventually(() => order.length === 1, 'one waiter gets the connection');
    requests[1].release();
    await eventually(() => order.length === 2, 'the other waiter gets a connection');
    finish.resolve();
    await Promise.all([request, job]);
    assert.deepEqual(order, ['job', 'request']);
  },
);

test('reserved job slots cannot exceed the job limit', async () => {
  assert.throws(
    () =>
      createWorkspaceRuntime({
        maxPools: 1,
        connectionsPerPool: 1,
        maxConcurrentTransactions: 2,
        maxBackgroundTransactions: 1,
        reservedBackgroundTransactions: 2,
        replicaCount: 1,
        reservedConnections: 0,
        databaseConnectionBudget: 10,
        resolveCredential: async () => assert.fail('no connection expected'),
      }),
    /Reserved background transactions exceed/,
  );
});

test('connection gate waits time out and give their place back', { timeout: 15000 }, async t => {
  const { runtime, run, hold } = await setup(t, { connectionTimeoutMs: 50 });
  const first = hold(false);
  await first.entered;
  await assert.rejects(
    run(false, async () => assert.fail('timed-out wait ran')),
    error => error instanceof StorageUnavailableError && error.code === 'wait_timeout',
  );
  first.release();
  await first.done;
  assert.equal(await run(false, async () => 'after'), 'after');
  assert.equal(runtime.stats().activeTransactions, 0);
});

test('the gate stays correct after a destroyed connection and a credential rotation', { timeout: 15000 }, async t => {
  const { runtime, run, rotate } = await setup(t, { connectionsPerPool: 1, maxConcurrentTransactions: 2 });
  await assert.rejects(
    run(false, async ({ client }) => client.query('SELECT * FROM missing_table')),
    /missing_table/,
  );
  assert.equal(await run(false, async () => 'after reset'), 'after reset');
  rotate();
  const results = await Promise.all([run(false, async () => 'a'), run(true, async () => 'b')]);
  assert.deepEqual(results, ['a', 'b']);
  assert.deepEqual(
    { active: runtime.stats().activeTransactions, queued: runtime.stats().queuedTransactions },
    { active: 0, queued: 0 },
  );
});

test('close rejects queued requests and jobs', { timeout: 15000 }, async t => {
  const { runtime, run, hold } = await setup(t, { maxConcurrentTransactions: 1, maxQueue: 2 });
  const first = hold(false);
  await first.entered;
  const request = run(false, async () => 'request');
  const job = run(true, async () => 'job');
  await eventually(() => runtime.stats().queuedTransactions === 2, 'both queue');
  const closing = runtime.close();
  const closedError = error => error instanceof StorageUnavailableError && error.code === 'closed';
  await assert.rejects(request, closedError);
  await assert.rejects(job, closedError);
  first.release();
  await closing;
});

test('scheduled job runs are classified as background by default', { timeout: 15000 }, async t => {
  const db = await fixture();
  t.after(() => db.close());
  const workspace = await db.create();
  const runtime = createWorkspaceRuntime({
    maxPools: 1,
    connectionsPerPool: 1,
    maxConcurrentTransactions: 2,
    maxQueue: 2,
    waitTimeoutMs: 3000,
    connectionTimeoutMs: 3000,
    statementTimeoutMs: 10000,
    idleTimeoutMs: 10000,
    replicaCount: 1,
    reservedConnections: 0,
    databaseConnectionBudget: 1,
    resolveCredential: async () => ({
      workspaceId: workspace.id,
      generation: 1,
      connectionString: db.login(workspace),
    }),
  });
  t.after(() => runtime.close());
  let seen;
  await createBackgroundJob('table-dispatch', 1).run(() =>
    runtime.transaction(workspace.id, commonCompatibility, async () => {
      seen = runtime.stats().activeBackgroundTransactions;
    }),
  );
  assert.equal(seen, 1);
  await runtime.transaction(workspace.id, commonCompatibility, async () => {
    seen = runtime.stats().activeBackgroundTransactions;
  });
  assert.equal(seen, 0);
});
