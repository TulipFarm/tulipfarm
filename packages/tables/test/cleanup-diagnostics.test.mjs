import assert from 'node:assert/strict';
import { test } from 'node:test';
import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Client } from 'pg';
import { createTableCleanup } from '@tulipfarm/tables/cleanup';
import { errorAttributes } from '@tulipfarm/observability';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const tableId = '00000000-0000-4000-8000-000000000002';
const generationId = '00000000-0000-4000-8000-000000000003';
const login = `ws_${workspaceId.replaceAll('-', '')}_migration`;
const connectionString = `postgres://${login}:private-password@127.0.0.1/private-database`;
const generation = {
  id: generationId,
  table_id: tableId,
  revision: 'a'.repeat(40),
  physical_table: `g_${generationId.replaceAll('-', '')}`,
  state: 'retired',
  definition: {
    formatVersion: 2,
    id: tableId,
    owningTeamId: workspaceId,
    label: 'Private customer label',
    fields: [{ id: generationId, label: 'Private field', kind: 'text', required: false, maxLength: 100 }],
    uniqueKeys: [],
  },
};

function database(t, fail = () => undefined, candidates = () => true) {
  const statements = [];
  let connections = 0,
    closed = 0;
  t.mock.method(Client.prototype, 'connect', async () => {
    connections++;
    await fail('connect');
  });
  t.mock.method(Client.prototype, 'end', async () => {
    await fail('end');
    closed++;
  });
  t.mock.method(Client.prototype, 'query', async sql => {
    statements.push(sql);
    await fail(sql);
    if (sql === 'SELECT session_user, current_user')
      return { rows: [{ session_user: login, current_user: login }], rowCount: 1 };
    if (sql.startsWith('SELECT 1 FROM pg_proc')) return { rows: [{}], rowCount: 1 };
    if (sql.startsWith('SELECT app.workspace_access')) return { rows: [{ allowed: true }], rowCount: 1 };
    if (sql.endsWith(' AS needed')) return { rows: [{ needed: candidates(sql) }], rowCount: 1 };
    if (sql.includes('"tf_authorization_lock"')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (sql.startsWith('SELECT g.*')) return { rows: [generation], rowCount: 1 };
    if (sql.startsWith('SELECT 1 FROM') && sql.includes('"tf_table_generations"')) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { statements, connections: () => connections, closed: () => closed };
}

function retryDelays(t, check = () => undefined) {
  const delays = [];
  t.mock.method(timers, 'setTimeout', async milliseconds => {
    check();
    delays.push(milliseconds);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return delays;
}

const cases = [
  ['maintenance-connect', 'connect'],
  ['maintenance-transaction', 'BEGIN ISOLATION'],
  ['maintenance-identity', 'SELECT session_user'],
  ['workspace-access', 'SELECT app.workspace_access'],
  ['workspace-migration-lock', '734129'],
  ['maintenance-role', 'SET LOCAL ROLE'],
  ['maintenance-settings', "SET LOCAL lock_timeout='250ms'"],
  ['table-cleanup-discovery', 'SELECT EXISTS'],
  ['table-cleanup-authorization', '"tf_authorization_lock"'],
  ['table-cleanup-proposals', 'SELECT p.*'],
  ['table-cleanup-history', 'WITH expired AS (SELECT h.id'],
  ['table-cleanup-receipts', 'SELECT r.membership_id'],
  ['table-cleanup-generation', 'SELECT g.*'],
  ['table-cleanup-catalog', '7701'],
  ['table-cleanup-generation-data', 'DELETE FROM', '"tf_table_generation_links"'],
  ['table-cleanup-drop', 'DROP TABLE'],
  ['table-cleanup-generation', 'SET physical_removed_at'],
  ['maintenance-transaction', 'COMMIT'],
  ['table-cleanup-authorization', '"tf_authorization_lock"', undefined, 2],
  ['table-cleanup-imports', 'SELECT EXISTS', undefined, 2],
  ['table-cleanup-imports', 'SET cleanup_pending_at'],
];

test('cleanup failures retain the precise bounded phase, original error, rollback, and privacy', async t => {
  for (const [stage, match, extra, occurrence = 1] of cases) {
    await t.test(`${stage}: ${match} (${occurrence})`, async t => {
      const cause = new Error('private cause with customer data');
      const failure = Object.freeze(
        Object.assign(new Error(`private SQL for ${workspaceId}`, { cause }), {
          code: '55P03',
          detail: 'private row',
          schema: login,
          table: generation.physical_table,
        }),
      );
      let matches = 0;
      const db = database(t, sql => {
        if ((match === 'COMMIT' ? sql === match : sql.includes(match)) && (!extra || sql.includes(extra))) {
          matches++;
          if (matches === occurrence || (stage === 'table-cleanup-authorization' && matches > occurrence))
            throw failure;
        }
      });
      const cleanup = createTableCleanup({ resolveMigrationCredential: async () => connectionString });
      await assert.rejects(cleanup(workspaceId), error => {
        assert.equal(error, failure);
        assert.equal(error.cause, cause);
        assert.equal(error.code, '55P03');
        assert.deepEqual(errorAttributes(error), {
          'error.type': 'Error',
          'error.stage': stage,
          'error.code': '55P03',
          'error.reason': 'Database lock could not be acquired',
        });
        assert.equal(Object.hasOwn(error, 'stage'), false);
        return true;
      });
      assert.ok(matches >= occurrence, 'the requested failure was reached');
      assert.equal(db.closed(), db.connections());
      const transactions = stage === 'table-cleanup-imports' || occurrence === 2 ? 2 : 1;
      assert.equal(db.connections(), transactions + (stage === 'table-cleanup-authorization' ? 2 : 0));
      if (match !== 'connect' && match !== 'BEGIN ISOLATION') assert.equal(db.statements.at(-1), 'ROLLBACK');
      assert.equal(
        db.statements.filter(sql => sql === 'COMMIT').length,
        stage === 'table-cleanup-imports' || occurrence === 2 || match === 'COMMIT' ? 1 : 0,
      );
    });
  }
});

test('each cleanup transaction retries authorization contention without repeating a committed batch', async t => {
  for (const failedTransaction of ['first', 'second']) {
    await t.test(failedTransaction, async t => {
      let db,
        authorizations = 0;
      const delays = retryDelays(t, () => {
        assert.equal(db.closed(), db.connections(), 'failed connection closes before the retry wait');
        assert.equal(db.statements.at(-1), 'ROLLBACK');
      });
      const failures = [0, 1].map(() =>
        Object.freeze(Object.assign(new Error('private lock details'), { code: '55P03' })),
      );
      db = database(t, sql => {
        if (!sql.includes('"tf_authorization_lock"')) return;
        const attempt = ++authorizations - (failedTransaction === 'second' ? 1 : 0);
        if (attempt > 0 && attempt <= 2) throw failures[attempt - 1];
      });
      const cleanup = createTableCleanup({ resolveMigrationCredential: async () => connectionString, batchRows: 1 });
      assert.equal(await cleanup(workspaceId), 'more');
      assert.deepEqual(delays, [50, 100]);
      assert.equal(db.connections(), 4);
      assert.equal(db.closed(), 4);
      assert.equal(db.statements.filter(sql => sql.startsWith('BEGIN')).length, 4);
      assert.equal(db.statements.filter(sql => sql === 'ROLLBACK').length, 2);
      assert.equal(db.statements.filter(sql => sql === 'COMMIT').length, 2);
      assert.equal(
        db.statements.filter(sql => sql.includes('734129')).length,
        4,
        'each attempt reacquires the migration fence',
      );
      assert.equal(db.statements.filter(sql => sql.startsWith('SELECT app.workspace_access')).length, 4);
      assert.equal(db.statements.filter(sql => sql.includes("SET LOCAL lock_timeout='250ms'")).length, 4);
      assert.equal(
        db.statements.filter(sql => sql.startsWith('SELECT g.*')).length,
        1,
        'the first successful batch is not repeated',
      );
      assert.equal(db.statements.filter(sql => sql.startsWith('DROP TABLE')).length, 1);
      assert.equal(db.statements.filter(sql => sql.includes('SET physical_removed_at')).length, 1);
      assert.equal(db.statements.filter(sql => sql.includes('SET cleanup_pending_at')).length, 1);
    });
  }
});

test('authorization retry exhaustion preserves the final original error and does not start the next transaction', async t => {
  const delays = retryDelays(t);
  const failures = [0, 1, 2].map(() =>
    Object.freeze(
      Object.assign(new Error('private failure', { cause: new Error('private cause') }), { code: '55P03' }),
    ),
  );
  let attempts = 0;
  const db = database(t, sql => {
    if (sql.includes('"tf_authorization_lock"')) throw failures[attempts++];
  });
  const cleanup = createTableCleanup({ resolveMigrationCredential: async () => connectionString });
  await assert.rejects(cleanup(workspaceId), error => {
    assert.equal(error, failures[2]);
    assert.equal(error.cause, failures[2].cause);
    assert.equal(errorAttributes(error)['error.stage'], 'table-cleanup-authorization');
    return true;
  });
  assert.deepEqual(delays, [50, 100]);
  assert.equal(attempts, 3);
  assert.equal(db.closed(), 3);
  assert.equal(db.statements.filter(sql => sql === 'ROLLBACK').length, 3);
  assert.equal(
    db.statements.some(sql => sql === 'COMMIT'),
    false,
  );
  assert.equal(
    db.statements.some(sql => sql.includes('SET cleanup_pending_at')),
    false,
  );
});

test('authorization failures other than lock contention are not retried', async t => {
  const delays = retryDelays(t);
  const failure = Object.freeze(Object.assign(new Error('private permission details'), { code: '42501' }));
  const db = database(t, sql => {
    if (sql.includes('"tf_authorization_lock"')) throw failure;
  });
  const cleanup = createTableCleanup({ resolveMigrationCredential: async () => connectionString });
  await assert.rejects(cleanup(workspaceId), error => error === failure);
  assert.deepEqual(delays, []);
  assert.equal(db.connections(), 1);
  assert.equal(db.closed(), 1);
  assert.equal(db.statements.at(-1), 'ROLLBACK');
});

test('authorization retries wait for both rollback and integration release', async t => {
  const rollback = Promise.withResolvers(),
    closing = Promise.withResolvers();
  const rollbackEntered = Promise.withResolvers(),
    closeEntered = Promise.withResolvers();
  let authorizations = 0,
    ends = 0;
  const delays = retryDelays(t);
  const db = database(t, async sql => {
    if (sql.includes('"tf_authorization_lock"') && ++authorizations === 1)
      throw Object.assign(new Error('private lock'), { code: '55P03' });
    if (sql === 'ROLLBACK') {
      rollbackEntered.resolve();
      await rollback.promise;
    }
    if (sql === 'end' && ++ends === 1) {
      closeEntered.resolve();
      await closing.promise;
    }
  });
  const pending = createTableCleanup({ resolveMigrationCredential: async () => connectionString })(workspaceId);
  try {
    await rollbackEntered.promise;
    assert.deepEqual(delays, []);
    assert.equal(db.connections(), 1);
    assert.equal(db.closed(), 0);
    rollback.resolve();
    await closeEntered.promise;
    assert.deepEqual(delays, []);
    assert.equal(db.connections(), 1);
    assert.equal(db.closed(), 0);
    closing.resolve();
    assert.equal(await pending, 'more');
    assert.deepEqual(delays, [50]);
    assert.equal(db.connections(), 3);
    assert.equal(db.closed(), 3);
  } finally {
    rollback.resolve();
    closing.resolve();
    await pending.catch(() => undefined);
  }
});

test('cleanup diagnostics leave successful work and transaction limits unchanged', async t => {
  const db = database(t);
  const cleanup = createTableCleanup({ resolveMigrationCredential: async () => connectionString });
  assert.equal(await cleanup(workspaceId), 'more');
  assert.equal(db.connections(), 2);
  assert.equal(db.closed(), 2);
  assert.equal(db.statements.filter(sql => sql === 'COMMIT').length, 2);
  assert.equal(db.statements.includes('ROLLBACK'), false);
  assert.equal(
    db.statements.filter(
      sql =>
        sql ===
        "SET LOCAL lock_timeout='250ms'; SET LOCAL transaction_timeout='2s'; SET LOCAL statement_timeout='1500ms'",
    ).length,
    2,
  );
  assert.equal(
    db.statements.filter(sql => sql.includes('"tf_authorization_lock"') && sql.endsWith('FOR UPDATE')).length,
    2,
  );
  assert.equal(db.statements.filter(sql => sql.startsWith('DROP TABLE IF EXISTS')).length, 1);
});

test('empty preflights retain workspace fences and deadlines without authorization locks or mutations', async t => {
  const db = database(
    t,
    () => undefined,
    () => false,
  );
  assert.equal(
    await createTableCleanup({ resolveMigrationCredential: async () => connectionString })(workspaceId),
    'completed',
  );
  assert.equal(db.statements.filter(sql => sql.startsWith('SELECT app.workspace_access')).length, 2);
  assert.equal(db.statements.filter(sql => sql.includes('734129')).length, 2);
  assert.equal(db.statements.filter(sql => sql.includes("SET LOCAL lock_timeout='250ms'")).length, 2);
  assert.equal(
    db.statements.some(sql => sql.includes('"tf_authorization_lock"')),
    false,
  );
  assert.equal(
    db.statements.some(sql => /^(UPDATE|DELETE|DROP|WITH expired)/.test(sql)),
    false,
  );
  assert.equal(db.statements.filter(sql => sql === 'COMMIT').length, 2);
  assert.equal(db.closed(), 2);
});

test('invalid preflight results fail rather than claiming no work', async t => {
  for (const phase of ['history', 'imports']) {
    await t.test(phase, async t => {
      const db = database(
        t,
        () => undefined,
        sql => (sql.includes('"tf_table_import_objects"') === (phase === 'imports') ? undefined : false),
      );
      await assert.rejects(
        createTableCleanup({ resolveMigrationCredential: async () => connectionString })(workspaceId),
        error => {
          assert.equal(
            errorAttributes(error)['error.stage'],
            phase === 'history' ? 'table-cleanup-discovery' : 'table-cleanup-imports',
          );
          return true;
        },
      );
      assert.equal(db.statements.at(-1), 'ROLLBACK');
      assert.equal(db.closed(), phase === 'history' ? 1 : 2);
    });
  }
});
