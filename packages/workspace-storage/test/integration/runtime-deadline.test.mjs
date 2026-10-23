import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { escapeIdentifier } from 'pg';
import { createWorkspaceRuntime, StorageUnavailableError, qualified } from '../../src/runtime.ts';
import { fixture } from './fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { trace, withChatMeasurements } from '@tulipfarm/observability';

const compatibility = commonCompatibility;
const timeoutError = error => error instanceof StorageUnavailableError && error.code === 'wait_timeout';
const deadline = (ms = 150) => ({ ...compatibility, deadlineAt: Date.now() + ms });
const gate = () => Promise.withResolvers();

test(
  'chat storage measurements cover admission through reset without changing results',
  { timeout: 15000 },
  async t => {
    const { read } = await setup(t);
    const phases = [];
    t.mock.method(process.stdout, 'write', line => {
      const record = JSON.parse(line);
      if (record.operation?.startsWith('chat.detail.')) phases.push(record.operation);
      return true;
    });
    assert.equal(await withChatMeasurements(read), 42);
    for (const phase of [
      'admission',
      'credentials',
      'pool',
      'connect',
      'settings',
      'begin',
      'identity',
      'fence',
      'version',
      'operation',
      'commit',
      'reset',
    ]) {
      assert.ok(phases.includes(`chat.detail.storage-${phase}`), `missing ${phase}`);
    }
    const count = phases.length;
    assert.equal(await read(), 42);
    assert.equal(phases.length, count);
  },
);

async function eventually(check, message) {
  const until = Date.now() + 1500;
  while (!(await check())) {
    assert.ok(Date.now() < until, message);
    await delay(10);
  }
}

async function setup(t, settings = {}) {
  const db = await fixture();
  t.after(() => db.close());
  const workspace = await db.create();
  const resolveCredential = async () => ({
    workspaceId: workspace.id,
    generation: 1,
    connectionString: db.login(workspace),
  });
  const runtime = createWorkspaceRuntime({
    maxPools: 1,
    connectionsPerPool: 1,
    maxConcurrentTransactions: 1,
    maxQueue: 1,
    waitTimeoutMs: 3000,
    connectionTimeoutMs: 3000,
    statementTimeoutMs: 10000,
    idleTimeoutMs: 10000,
    replicaCount: 1,
    reservedConnections: 0,
    databaseConnectionBudget: 1,
    resolveCredential,
    ...settings,
  });
  t.after(() => runtime.close());
  const run = (limits, operation) => runtime.transaction(workspace.id, limits, operation);
  const read = () =>
    run(deadline(1000), async ({ client }) => (await client.query('SELECT 42 AS answer')).rows[0].answer);
  return { db, workspace, runtime, run, read, resolveCredential };
}

test('deadline removes queued admission waiters and preserves the active transaction', { timeout: 15000 }, async t => {
  const { runtime, run, read } = await setup(t);
  const entered = gate();
  const release = gate();
  const held = run(compatibility, async () => {
    entered.resolve();
    await release.promise;
    return 'held';
  });
  t.after(() => release.resolve());
  await entered.promise;
  let called = false;
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    await assert.rejects(
      run(deadline(), async () => {
        called = true;
      }),
      timeoutError,
    );
    assert.ok(Date.now() - started < 1000, 'admission observes the absolute deadline');
    assert.equal(runtime.stats().queuedTransactions, 0);
    assert.equal(runtime.stats().activeTransactions, 1);
  }
  assert.equal(called, false);
  release.resolve();
  assert.equal(await held, 'held');
  assert.equal(await read(), 42);
});

test('expired deadlines do not resolve credentials or acquire connections', { timeout: 15000 }, async t => {
  let resolved = false;
  const { runtime, run } = await setup(t, {
    resolveCredential: async () => {
      resolved = true;
      throw new Error('unexpected credential call');
    },
  });
  await assert.rejects(
    run(deadline(-1), async () => assert.fail('operation ran')),
    timeoutError,
  );
  assert.equal(resolved, false);
  assert.deepEqual(runtime.stats(), {
    pools: 0,
    activeTransactions: 0,
    activeBackgroundTransactions: 0,
    queuedTransactions: 0,
    queuedBackgroundTransactions: 0,
    connections: 0,
  });
});

test('deadline aborts slow credential resolution and ignores late credentials', { timeout: 15000 }, async t => {
  const { db, workspace } = await setup(t);
  const pending = gate();
  let signal;
  let slow = true;
  const runtime = createWorkspaceRuntime({
    maxPools: 1,
    connectionsPerPool: 1,
    maxConcurrentTransactions: 1,
    replicaCount: 1,
    reservedConnections: 0,
    databaseConnectionBudget: 1,
    connectionTimeoutMs: 3000,
    resolveCredential: async (_, cancellation) => {
      signal = cancellation;
      if (slow) await pending.promise;
      return { workspaceId: workspace.id, generation: slow ? 99 : 1, connectionString: db.login(workspace) };
    },
  });
  t.after(() => runtime.close());
  await assert.rejects(
    runtime.transaction(workspace.id, deadline(), async () => assert.fail('operation ran')),
    timeoutError,
  );
  assert.equal(signal.aborted, true);
  assert.equal(runtime.stats().activeTransactions, 0);
  assert.equal(runtime.stats().pools, 0);
  pending.resolve();
  await delay(20);
  slow = false;
  assert.equal(
    await runtime.transaction(
      workspace.id,
      deadline(1000),
      async ({ client }) => (await client.query('SELECT 42 AS answer')).rows[0].answer,
    ),
    42,
  );
});

test(
  'pool acquisition deadline releases late clients and recovers the single-connection pool',
  { timeout: 15000 },
  async t => {
    const { runtime, run, read } = await setup(t, { maxConcurrentTransactions: 2 });
    const entered = gate();
    const release = gate();
    const held = run(compatibility, async () => {
      entered.resolve();
      await release.promise;
    });
    t.after(() => release.resolve());
    await entered.promise;
    await assert.rejects(
      run(deadline(), async () => assert.fail('late operation ran')),
      timeoutError,
    );
    assert.equal(runtime.stats().activeTransactions, 1);
    release.resolve();
    await held;
    assert.equal(await read(), 42);
    assert.equal(runtime.stats().activeTransactions, 0);
    assert.equal(runtime.stats().connections, 1);
  },
);

test('pg-pool saturation records checkout timeout while the holder remains usable', { timeout: 15000 }, async t => {
  const { runtime, run, read } = await setup(t, { maxConcurrentTransactions: 2, connectionTimeoutMs: 50 });
  const completed = [];
  t.mock.method(trace, 'getTracer', () => ({
    startSpan(name) {
      const attributes = {};
      return {
        setAttribute(key, value) {
          attributes[key] = value;
        },
        setStatus() {},
        end() {
          completed.push({ name, ...attributes });
        },
      };
    },
  }));
  const entered = gate();
  const release = gate();
  t.after(() => release.resolve());
  const held = run(compatibility, async () => {
    entered.resolve();
    await release.promise;
    return 42;
  });
  await entered.promise;
  await assert.rejects(
    run(compatibility, async () => assert.fail('queued callback ran')),
    timeoutError,
  );
  assert.deepEqual(
    completed.map(span => [span.name, span.outcome]),
    [
      ['workspace.connection.wait', 'success'],
      ['workspace.connection.wait', 'timeout'],
    ],
  );
  assert.equal(runtime.stats().activeTransactions, 1);
  release.resolve();
  assert.equal(await held, 42);
  assert.deepEqual(completed.at(-1).name, 'workspace.connection.hold');
  assert.equal(completed.at(-1).outcome, 'success');
  assert.equal(await read(), 42);
  assert.equal(runtime.stats().activeTransactions, 0);
  assert.equal(runtime.stats().connections, 1);
});

test('successful deadline transactions reset server timeouts before integration reuse', { timeout: 15000 }, async t => {
  const { run } = await setup(t);
  const pid = await run(
    deadline(1000),
    async ({ client }) => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
  );
  await run(compatibility, async ({ client }) => {
    assert.equal((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid);
    assert.equal((await client.query('SHOW transaction_timeout')).rows[0].transaction_timeout, '0');
    assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout, '10s');
  });
});

test('admission and credential resolution consume the same absolute deadline', { timeout: 15000 }, async t => {
  const { db, workspace } = await setup(t);
  let credentialCalls = 0;
  const runtime = createWorkspaceRuntime({
    maxPools: 1,
    connectionsPerPool: 1,
    maxConcurrentTransactions: 1,
    replicaCount: 1,
    reservedConnections: 0,
    databaseConnectionBudget: 1,
    resolveCredential: async () => {
      if (++credentialCalls > 1) await delay(100);
      return { workspaceId: workspace.id, generation: 1, connectionString: db.login(workspace) };
    },
  });
  t.after(() => runtime.close());
  const entered = gate();
  const release = gate();
  const held = runtime.transaction(workspace.id, compatibility, async () => {
    entered.resolve();
    await release.promise;
  });
  t.after(() => release.resolve());
  await entered.promise;
  const started = Date.now();
  let pid;
  const timed = assert.rejects(
    runtime.transaction(workspace.id, deadline(400), async ({ client }) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await client.query('SELECT pg_sleep(10)');
    }),
    timeoutError,
  );
  await delay(100);
  release.resolve();
  await held;
  await timed;
  assert.ok(Date.now() - started < 550, 'admission and credentials must not restart the budget');
  assert.ok(pid, 'the transaction reached SQL after admission and credentials');
  await eventually(
    async () => !(await db.databaseAdmin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount,
    'SQL uses the remaining deadline budget',
  );
});

test('deadline stops pg_sleep in PostgreSQL, rolls back writes, and recovers the pool', { timeout: 15000 }, async t => {
  const { db, workspace, runtime, run, read } = await setup(t);
  let pid;
  const started = Date.now();
  await assert.rejects(
    run(deadline(250), async ({ client, schema }) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await client.query(`UPDATE ${qualified(schema, 'tf_memberships')} SET role = 'member'`);
      await client.query('SELECT pg_sleep(10)');
    }),
    timeoutError,
  );
  assert.ok(Date.now() - started < 1000, 'pg_sleep returns within the deadline budget');
  assert.ok(pid);
  await eventually(
    async () => !(await db.databaseAdmin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount,
    'expired SQL backend is gone',
  );
  assert.equal(runtime.stats().activeTransactions, 0);
  assert.equal(await read(), 42);
  assert.deepEqual(
    await run(
      compatibility,
      async ({ client, schema }) =>
        (await client.query(`SELECT user_id, role FROM ${qualified(schema, 'tf_memberships')}`)).rows[0],
    ),
    { user_id: workspace.userId, role: 'admin' },
  );
});

test('deadline stops a blocked table lock before the configured lock timeout', { timeout: 15000 }, async t => {
  const { db, workspace, run, read } = await setup(t);
  await db.databaseAdmin.query('BEGIN');
  await db.databaseAdmin.query(
    `LOCK TABLE ${qualified(workspace.names.schema, 'tf_memberships')} IN ACCESS EXCLUSIVE MODE`,
  );
  let pid;
  try {
    await assert.rejects(
      run(deadline(250), async ({ client, schema }) => {
        pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await client.query(`SELECT * FROM ${qualified(schema, 'tf_memberships')}`);
      }),
      timeoutError,
    );
    assert.ok(pid);
    await eventually(async () => {
      await db.databaseAdmin.query('SELECT pg_stat_clear_snapshot()');
      return !(await db.databaseAdmin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount;
    }, 'lock waiter backend is gone');
  } finally {
    await db.databaseAdmin.query('ROLLBACK');
  }
  assert.equal(await read(), 42);
});

test('one absolute deadline covers multiple statements and an idle callback', { timeout: 15000 }, async t => {
  const { db, runtime, run, read } = await setup(t);
  let completed = 0;
  const started = Date.now();
  await assert.rejects(
    run(deadline(250), async ({ client }) => {
      for (let i = 0; i < 10; i++) {
        await client.query('SELECT pg_sleep(0.08)');
        completed++;
      }
    }),
    timeoutError,
  );
  assert.ok(completed > 0 && completed < 10);
  assert.ok(Date.now() - started < 1000);
  const resume = gate();
  let pid;
  let lateQuery;
  const settled = gate();
  await assert.rejects(
    run(deadline(150), async ({ client }) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await resume.promise;
      lateQuery = client.query('SELECT 1');
      settled.resolve();
      await lateQuery;
    }),
    timeoutError,
  );
  assert.equal(runtime.stats().activeTransactions, 0);
  await eventually(
    async () => !(await db.databaseAdmin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount,
    'idle transaction backend is gone',
  );
  resume.resolve();
  await settled.promise;
  await assert.rejects(lateQuery, /closed|ending|connection/i);
  assert.equal(await read(), 42);
});

test('deadline bounds COMMIT and rolls back a deferred trigger', { timeout: 15000 }, async t => {
  const { db, workspace, run, read } = await setup(t);
  const schema = escapeIdentifier(workspace.names.schema);
  await db.databaseAdmin.query(`
    CREATE TABLE ${schema}.deadline_writes (id integer);
    GRANT SELECT, INSERT ON ${schema}.deadline_writes TO ${escapeIdentifier(workspace.names.runtime)};
    CREATE FUNCTION ${schema}.slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(10); RETURN NEW; END $$;
    CREATE CONSTRAINT TRIGGER slow_commit AFTER INSERT ON ${schema}.deadline_writes
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${schema}.slow_commit();
  `);
  let pid;
  let operationCompleted = false;
  await assert.rejects(
    run(deadline(250), async ({ client }) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await client.query(`INSERT INTO ${schema}.deadline_writes VALUES (1)`);
      operationCompleted = true;
    }),
    timeoutError,
  );
  assert.equal(operationCompleted, true);
  await eventually(
    async () => !(await db.databaseAdmin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount,
    'commit backend is gone',
  );
  assert.equal((await db.databaseAdmin.query(`SELECT * FROM ${schema}.deadline_writes`)).rowCount, 0);
  assert.equal(await read(), 42);
});

test('deadline includes workspace access fence locks', { timeout: 15000 }, async t => {
  const { db, workspace, run, read } = await setup(t);
  await db.databaseAdmin.query(`
    CREATE FUNCTION app.workspace_access(uuid, boolean) RETURNS boolean LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(1234567); RETURN true; END $$;
    GRANT USAGE ON SCHEMA app TO ${escapeIdentifier(workspace.names.runtime)};
    GRANT EXECUTE ON FUNCTION app.workspace_access(uuid, boolean) TO ${escapeIdentifier(workspace.names.runtime)};
  `);
  await db.databaseAdmin.query('SELECT pg_advisory_lock(1234567)');
  try {
    await assert.rejects(
      run({ ...deadline(250), access: 'exclusive' }, async () => assert.fail('fenced operation ran')),
      timeoutError,
    );
    await eventually(
      async () =>
        !(await db.databaseAdmin.query('SELECT 1 FROM pg_stat_activity WHERE usename = $1', [workspace.names.runtime]))
          .rowCount,
      'fence waiter backend is gone',
    );
  } finally {
    await db.databaseAdmin.query('SELECT pg_advisory_unlock(1234567)');
  }
  assert.equal(await read(), 42);
});
