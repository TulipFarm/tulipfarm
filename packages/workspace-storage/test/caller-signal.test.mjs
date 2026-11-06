import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Pool } from 'pg';
import {
  commonCompatibility as compatibility,
  createWorkspaceRuntime,
  StorageUnavailableError,
  withCallerSignal,
  workspaceNames,
} from '../src/runtime.ts';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const names = workspaceNames(workspaceId);

function setup(t) {
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      if (sql === 'SELECT session_user, current_user')
        return { rows: [{ session_user: names.runtime, current_user: names.runtime }] };
      if (sql.includes('FROM pg_proc')) return { rows: [], rowCount: 1 };
      if (sql.includes('app.workspace_access')) return { rows: [{ allowed: true }] };
      if (sql.includes('count(*)')) return { rows: [{ version: compatibility.maximum }] };
      return { rows: [] };
    },
    release() {},
  });
  t.mock.method(Pool.prototype, 'connect', async () => client);
  const runtime = createWorkspaceRuntime({
    maxConcurrentTransactions: 1,
    replicaCount: 1,
    reservedConnections: 0,
    databaseConnectionBudget: 16,
    background: () => false,
    resolveCredential: async () => ({
      workspaceId,
      generation: 1,
      connectionString: `postgres://${names.runtime}:password@localhost/database`,
    }),
  });
  const gates = [];
  t.after(async () => {
    for (const open of gates) open();
    await runtime.close();
  });
  const hold = () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    gates.push(release.resolve);
    const done = runtime.transaction(workspaceId, compatibility, async () => {
      entered.resolve();
      await release.promise;
      return 'held';
    });
    return { entered: entered.promise, release: release.resolve, done };
  };
  return { runtime, hold };
}

test('a queued transaction leaves the queue without running when its caller leaves', async t => {
  const { runtime, hold } = setup(t);
  const busy = hold();
  await busy.entered;
  const caller = new AbortController();
  let ran = false;
  const queued = withCallerSignal(caller.signal, () =>
    runtime.transaction(workspaceId, compatibility, async () => {
      ran = true;
    }),
  );
  assert.equal(runtime.stats().queuedTransactions, 1);
  caller.abort();
  await assert.rejects(queued, error => error instanceof StorageUnavailableError && error.code === 'caller_left');
  assert.equal(runtime.stats().queuedTransactions, 0);
  busy.release();
  assert.equal(await busy.done, 'held');
  assert.equal(ran, false);
});

test('a caller that already left does not join the queue', async t => {
  const { runtime } = setup(t);
  await assert.rejects(
    withCallerSignal(AbortSignal.abort(), () => runtime.transaction(workspaceId, compatibility, async () => 1)),
    error => error instanceof StorageUnavailableError && error.code === 'caller_left',
  );
  assert.equal(runtime.stats().activeTransactions, 0);
});

test('a started transaction finishes after its caller leaves', async t => {
  const { runtime } = setup(t);
  const caller = new AbortController();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const running = withCallerSignal(caller.signal, () =>
    runtime.transaction(workspaceId, compatibility, async () => {
      entered.resolve();
      await release.promise;
      return 'committed';
    }),
  );
  await entered.promise;
  caller.abort();
  release.resolve();
  assert.equal(await running, 'committed');
});
