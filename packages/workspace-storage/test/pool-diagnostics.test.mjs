import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { trace } from '@tulipfarm/observability';
import {
  commonCompatibility as compatibility,
  createWorkspaceRuntime,
  workspaceNames,
  StorageUnavailableError,
} from '../src/runtime.ts';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const names = workspaceNames(workspaceId);

function setup(t, { failQuery, failConnect, rollbackFailure, denied = false } = {}) {
  let clock = 0;
  const spans = [];
  const queries = [];
  const releases = [];
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(trace, 'getTracer', () => ({
    startSpan(name, options) {
      const span = { name, attributes: { ...options.attributes }, ended: 0 };
      spans.push(span);
      return {
        setAttribute(key, value) {
          span.attributes[key] = value;
        },
        setStatus(status) {
          span.status = status;
        },
        end() {
          span.ended++;
        },
      };
    },
  }));
  const client = Object.assign(new EventEmitter(), {
    async query(sql) {
      queries.push(sql);
      clock += 100;
      if (sql === failQuery?.sql) throw failQuery.error;
      if (sql === 'ROLLBACK' && rollbackFailure) throw rollbackFailure;
      if (sql === 'SELECT session_user, current_user')
        return { rows: [{ session_user: names.runtime, current_user: names.runtime }] };
      if (sql.includes('FROM pg_proc')) return { rows: [], rowCount: 1 };
      if (sql.includes('app.workspace_access')) return { rows: [{ allowed: !denied }] };
      if (sql.includes('count(*)')) return { rows: [{ version: compatibility.maximum }] };
      return { rows: [] };
    },
    release(destroy) {
      releases.push(destroy);
      clock += 50;
    },
  });
  t.mock.method(Pool.prototype, 'connect', async () => {
    clock += 250;
    if (failConnect) throw failConnect;
    return client;
  });
  const runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 0,
    databaseConnectionBudget: 16,
    resolveCredential: async () => ({
      workspaceId,
      generation: 1,
      connectionString: `postgres://${names.runtime}:PRIVATE_PASSWORD@localhost/private_database`,
    }),
  });
  t.after(() => runtime.close());
  return {
    runtime,
    client,
    spans,
    queries,
    releases,
    advance: ms => {
      clock += ms;
    },
    timings: () => spans.map(span => [span.name, span.attributes.outcome, span.attributes.duration_ms, span.ended]),
  };
}

test('non-chat transactions measure checkout and the whole hold through reset and release', async t => {
  const fixture = setup(t);
  const result = await fixture.runtime.transaction(workspaceId, compatibility, async () => {
    fixture.advance(500);
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(fixture.timings(), [
    ['workspace.connection.wait', 'success', 250, 1],
    ['workspace.connection.hold', 'success', 1350, 1],
  ]);
  assert.deepEqual(fixture.queries.slice(-2), ['COMMIT', 'DISCARD ALL']);
  assert.deepEqual(fixture.releases, [false]);
  assert.equal(fixture.client.listenerCount('error'), 0);
  assert.equal(fixture.runtime.stats().activeTransactions, 0);
  assert.doesNotMatch(JSON.stringify(fixture.spans), /PRIVATE|00000000|private_database|SELECT|COMMIT/);
});

for (const [label, failure, outcome] of [
  ['pg-pool timeout', new Error('timeout exceeded when trying to connect'), 'timeout'],
  ['deadline', new StorageUnavailableError('wait_timeout'), 'timeout'],
  ['connection failure', new Error('PRIVATE CONNECTION ERROR'), 'error'],
]) {
  test(`${label} records wait without a hold and preserves the failure`, async t => {
    const fixture = setup(t, { failConnect: failure });
    await assert.rejects(
      fixture.runtime.transaction(workspaceId, compatibility, async () => assert.fail('callback ran')),
      error => error === failure,
    );
    assert.deepEqual(fixture.timings(), [['workspace.connection.wait', outcome, 250, 1]]);
    assert.deepEqual(fixture.releases, []);
    assert.equal(fixture.runtime.stats().activeTransactions, 0);
    assert.doesNotMatch(JSON.stringify(fixture.spans), /PRIVATE|timeout exceeded|00000000/);
  });
}

for (const stage of ['callback', 'COMMIT', 'ROLLBACK', 'DISCARD ALL']) {
  test(`${stage} failure records hold, preserves the original error and releases once`, async t => {
    const failure = new Error('PRIVATE ORIGINAL ERROR');
    const fixture = setup(t, {
      ...(stage === 'COMMIT' || stage === 'DISCARD ALL' ? { failQuery: { sql: stage, error: failure } } : {}),
      ...(stage === 'ROLLBACK' ? { rollbackFailure: new Error('PRIVATE ROLLBACK ERROR') } : {}),
    });
    await assert.rejects(
      fixture.runtime.transaction(workspaceId, compatibility, async () => {
        fixture.advance(500);
        if (stage === 'callback' || stage === 'ROLLBACK') throw failure;
        return 42;
      }),
      error => error === failure,
    );
    assert.deepEqual(fixture.timings(), [
      ['workspace.connection.wait', 'success', 250, 1],
      ['workspace.connection.hold', 'error', stage === 'callback' || stage === 'ROLLBACK' ? 1250 : 1350, 1],
    ]);
    assert.deepEqual(fixture.releases, [true]);
    assert.equal(fixture.client.listenerCount('error'), 0);
    assert.equal(fixture.runtime.stats().activeTransactions, 0);
    assert.equal(fixture.queries.includes('ROLLBACK'), stage !== 'DISCARD ALL');
    assert.doesNotMatch(JSON.stringify(fixture.spans), /PRIVATE|00000000|SELECT/);
  });
}

test('denied access still prevents the callback and records the failed hold', async t => {
  const fixture = setup(t, { denied: true });
  await assert.rejects(
    fixture.runtime.transaction(workspaceId, compatibility, async () => assert.fail('unauthorized callback ran')),
    error => error instanceof StorageUnavailableError && error.code === 'disabled',
  );
  assert.deepEqual(fixture.timings(), [
    ['workspace.connection.wait', 'success', 250, 1],
    ['workspace.connection.hold', 'error', 650, 1],
  ]);
  assert.deepEqual(fixture.releases, [true]);
  assert.equal(fixture.queries.at(-1), 'ROLLBACK');
});

test('broken telemetry cannot leak a client or replace the callback result or error', async t => {
  const fixture = setup(t);
  t.mock.method(trace, 'getTracer', () => {
    throw new Error('telemetry unavailable');
  });
  assert.equal(await fixture.runtime.transaction(workspaceId, compatibility, async () => 42), 42);
  const failure = new Error('PRIVATE CALLBACK ERROR');
  await assert.rejects(
    fixture.runtime.transaction(workspaceId, compatibility, async () => {
      throw failure;
    }),
    error => error === failure,
  );
  assert.deepEqual(fixture.releases, [false, true]);
  assert.equal(fixture.client.listenerCount('error'), 0);
  assert.equal(fixture.runtime.stats().activeTransactions, 0);
});

test('an expired checkout records timeout and destroys a late client exactly once', async t => {
  const fixture = setup(t);
  const connected = Promise.withResolvers();
  t.mock.method(Pool.prototype, 'connect', () => connected.promise);
  await assert.rejects(
    fixture.runtime.transaction(workspaceId, { ...compatibility, deadlineAt: Date.now() + 25 }, async () =>
      assert.fail('late callback ran'),
    ),
    error => error instanceof StorageUnavailableError && error.code === 'wait_timeout',
  );
  connected.resolve(fixture.client);
  await setImmediate();
  assert.deepEqual(fixture.timings(), [['workspace.connection.wait', 'timeout', 0, 1]]);
  assert.deepEqual(fixture.releases, [true]);
  assert.equal(fixture.runtime.stats().activeTransactions, 0);
});
