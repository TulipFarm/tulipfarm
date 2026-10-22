import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture, connect } from '../../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { teardownDisposableWorkspace, workspaceOperationStatus } from '../../src/workspace-operations-lifecycle.ts';

const quiet = { async markUnavailable() {}, async assertUnavailable() {}, async stopJobs() {}, async drainPools() {} };

async function aggregateFixture() {
  const db = await fixture();
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const url = new URL(db.connectionString);
  const adminUrl = new URL(process.env.TEST_ADMIN_DATABASE_URL);
  url.username = adminUrl.username;
  url.password = adminUrl.password;
  return { db, operator: url.href, stream: await workspaceTableMigrations() };
}

async function inventory(db, schema) {
  return (
    await db.platform.query(
      `SELECT
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r') AS tables,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'v') AS views,
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1) AS routines,
    (SELECT count(*)::int FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = $1 AND k.contype = 'f') AS "foreignKeys",
    (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal) AS triggers`,
      [schema],
    )
  ).rows[0];
}

async function cyclicKnowledge(db, schema) {
  return (
    await db.platform.query(
      `SELECT count(*)::int AS references FROM pg_constraint
    WHERE contype = 'f' AND ((conrelid = to_regclass($1) AND confrelid = to_regclass($2)) OR (conrelid = to_regclass($2) AND confrelid = to_regclass($1)))`,
      [`${schema}.tf_knowledge_documents`, `${schema}.tf_knowledge_revisions`],
    )
  ).rows[0].references;
}

async function captureRoutine(db, schema) {
  return (
    await db.platform.query('SELECT to_regprocedure($1) IS NOT NULL AS present', [
      `${schema}.tf_table_execution_capture()`,
    ])
  ).rows[0].present;
}

async function outsideGrants(db, role) {
  return (
    await db.platform.query(
      `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS connect,
    has_schema_privilege($1, 'extensions', 'USAGE') AS extensions, has_type_privilege($1, 'extensions.vector', 'USAGE') AS vector,
    has_function_privilege($1, 'extensions.cosine_distance(extensions.vector,extensions.vector)', 'EXECUTE') AS distance,
    has_function_privilege($1, 'app.invitation_delivery(uuid,uuid,text,jsonb,timestamptz)', 'EXECUTE') AS delivery`,
      [role],
    )
  ).rows[0];
}

test('disposable teardown drains selected logins and preserves another workspace', { timeout: 30000 }, async () => {
  const db = await fixture();
  try {
    const a = await db.create();
    const b = await db.create();
    const aRuntime = await connect(db.login(a));
    aRuntime.on('error', () => {});
    const bRuntime = await connect(db.login(b));
    try {
      const order = [];
      const lifecycle = {
        async markUnavailable(id) {
          assert.equal(id, a.id);
          order.push('unavailable');
        },
        async assertUnavailable() {
          assert.equal(order[0], 'unavailable');
        },
        async stopJobs() {
          order.push('jobs-stopped');
        },
        async drainPools() {
          order.push('pools-drained');
        },
      };
      const url = new URL(db.connectionString);
      const adminUrl = new URL(process.env.TEST_ADMIN_DATABASE_URL);
      url.username = adminUrl.username;
      url.password = adminUrl.password;
      assert.equal((await workspaceOperationStatus(db.databaseAdmin, a.id)).sessions, 1);
      assert.deepEqual(
        await teardownDisposableWorkspace({
          connectionString: url.href,
          workspaceId: a.id,
          operatorId: 'local-test',
          lifecycle,
        }),
        { workspaceId: a.id, status: 'removed' },
      );
      assert.deepEqual(order, ['unavailable', 'jobs-stopped', 'pools-drained']);
      assert.equal((await workspaceOperationStatus(db.databaseAdmin, a.id)).schemaExists, false);
      assert.equal(
        (await bRuntime.query(`SELECT user_id FROM ${b.names.schema}.tf_memberships`)).rows[0].user_id,
        b.userId,
      );
      await assert.rejects(connect(db.login(a)));
      assert.deepEqual(
        await teardownDisposableWorkspace({
          connectionString: url.href,
          workspaceId: a.id,
          operatorId: 'local-test',
          lifecycle,
        }),
        { workspaceId: a.id, status: 'removed' },
      );
    } finally {
      await aRuntime.end();
      await bRuntime.end();
    }
  } finally {
    await db.close();
  }
});

test('scoped removal refuses an external dependency', { timeout: 30000 }, async () => {
  const db = await fixture();
  try {
    const a = await db.create();
    const b = await db.create();
    const schema = a.names.schema;
    await db.platform.query(
      `CREATE VIEW ${b.names.schema}.retained_members AS SELECT id FROM ${schema}.tf_memberships`,
    );
    const url = new URL(db.connectionString);
    const adminUrl = new URL(process.env.TEST_ADMIN_DATABASE_URL);
    url.username = adminUrl.username;
    url.password = adminUrl.password;
    const lifecycle = {
      async markUnavailable() {},
      async assertUnavailable() {},
      async stopJobs() {},
      async drainPools() {},
    };
    await assert.rejects(
      teardownDisposableWorkspace({ connectionString: url.href, workspaceId: a.id, operatorId: 'operator', lifecycle }),
      /external-dependency/,
    );
    assert.equal(
      (await db.platform.query(`SELECT count(*)::int AS count FROM ${schema}.tf_memberships`)).rows[0].count,
      1,
    );
    assert.equal(
      (await db.platform.query(`SELECT count(*)::int AS count FROM ${b.names.schema}.retained_members`)).rows[0].count,
      1,
    );
  } finally {
    await db.close();
  }
});

test(
  'disposable teardown removes the current aggregate schema with internal reference cycles and routines',
  { timeout: 120000 },
  async () => {
    const { db, operator, stream } = await aggregateFixture();
    try {
      const a = await db.create(stream);
      const b = await db.create(stream);
      assert.equal(await cyclicKnowledge(db, a.names.schema), 2);
      assert.equal(await captureRoutine(db, a.names.schema), true);
      const granted = { connect: true, extensions: true, vector: true, distance: true, delivery: true };
      assert.deepEqual(await outsideGrants(db, a.names.runtime), granted);
      const preserved = await inventory(db, b.names.schema);
      const removal = { connectionString: operator, workspaceId: a.id, operatorId: 'local-test', lifecycle: quiet };
      assert.deepEqual(await teardownDisposableWorkspace(removal), { workspaceId: a.id, status: 'removed' });
      assert.equal((await workspaceOperationStatus(db.databaseAdmin, a.id)).schemaExists, false);
      assert.deepEqual(await inventory(db, a.names.schema), {
        tables: 0,
        views: 0,
        routines: 0,
        foreignKeys: 0,
        triggers: 0,
      });
      assert.equal(
        (
          await db.platform.query('SELECT count(*)::int AS roles FROM pg_roles WHERE rolname = ANY($1)', [
            [a.names.runtime, a.names.migration, a.names.confirmation, a.names.customOwner],
          ])
        ).rows[0].roles,
        0,
      );
      assert.deepEqual(await inventory(db, b.names.schema), preserved);
      assert.equal(await cyclicKnowledge(db, b.names.schema), 2);
      assert.deepEqual(await outsideGrants(db, b.names.runtime), granted);
      const runtime = await connect(db.login(b));
      try {
        assert.deepEqual((await runtime.query(`SELECT user_id FROM ${b.names.schema}.tf_memberships`)).rows, [
          { user_id: b.userId },
        ]);
      } finally {
        await runtime.end();
      }
      assert.deepEqual(await teardownDisposableWorkspace(removal), { workspaceId: a.id, status: 'removed' });
    } finally {
      await db.close();
    }
  },
);

test(
  "scoped removal refuses another schema's trigger on a workspace routine and rolls back every drop",
  { timeout: 120000 },
  async () => {
    const { db, operator, stream } = await aggregateFixture();
    try {
      const a = await db.create(stream);
      const b = await db.create(stream);
      await db.platform.query(`CREATE TABLE ${b.names.schema}.external_capture (table_id uuid, row_id uuid);
      CREATE TRIGGER external_capture AFTER INSERT ON ${b.names.schema}.external_capture
      FOR EACH ROW EXECUTE FUNCTION ${a.names.schema}.tf_table_execution_capture()`);
      const retained = await inventory(db, a.names.schema);
      const removal = { connectionString: operator, workspaceId: a.id, operatorId: 'operator', lifecycle: quiet };
      await assert.rejects(teardownDisposableWorkspace(removal), /^Error: workspace-external-dependency$/);
      assert.deepEqual(await inventory(db, a.names.schema), retained);
      assert.equal(await cyclicKnowledge(db, a.names.schema), 2);
      assert.equal(await captureRoutine(db, a.names.schema), true);
      assert.equal(
        (await db.platform.query("SELECT count(*)::int AS triggers FROM pg_trigger WHERE tgname = 'external_capture'"))
          .rows[0].triggers,
        1,
      );
      await db.platform.query(`DROP TABLE ${b.names.schema}.external_capture`);
      assert.deepEqual(await teardownDisposableWorkspace(removal), { workspaceId: a.id, status: 'removed' });
      assert.equal((await workspaceOperationStatus(db.databaseAdmin, a.id)).schemaExists, false);
    } finally {
      await db.close();
    }
  },
);

test(
  'disposable teardown refuses statistics objects, then removes workspace types, domains, routines, materialized views, sequences, and outside column grants',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    try {
      const a = await db.create();
      const b = await db.create();
      const schema = a.names.schema;
      await db.platform.query(`CREATE DOMAIN ${schema}.positive AS integer CHECK (VALUE > 0);
      CREATE TYPE ${schema}.mood AS ENUM ('calm', 'busy');
      CREATE TYPE ${schema}.pair AS (low integer, high integer);
      CREATE TYPE ${schema}.span AS RANGE (subtype = integer);
      CREATE SEQUENCE ${schema}.ticket_number;
      CREATE TABLE ${schema}.tickets (id integer PRIMARY KEY DEFAULT nextval('${schema}.ticket_number'),
        amount ${schema}.positive, mood ${schema}.mood, pair ${schema}.pair, span ${schema}.span);
      CREATE MATERIALIZED VIEW ${schema}.ticket_totals AS SELECT count(*) AS total FROM ${schema}.tickets;
      CREATE FUNCTION ${schema}.double_amount(value ${schema}.positive) RETURNS integer LANGUAGE sql AS 'SELECT value * 2';
      CREATE STATISTICS ${schema}.ticket_shape ON amount, id FROM ${schema}.tickets`);
      await db.databaseAdmin
        .query(`CREATE SCHEMA shared_reference; CREATE TABLE shared_reference.codes (code text, secret text);
      GRANT USAGE ON SCHEMA shared_reference TO ${db.owner} WITH GRANT OPTION;
      GRANT SELECT ON shared_reference.codes TO ${db.owner} WITH GRANT OPTION`);
      await db.platform.query(`GRANT USAGE ON SCHEMA shared_reference TO ${a.names.runtime};
      GRANT SELECT (code) ON shared_reference.codes TO ${a.names.runtime}`);
      assert.equal(
        (
          await db.platform.query(
            "SELECT has_column_privilege($1, 'shared_reference.codes', 'code', 'SELECT') AS granted",
            [a.names.runtime],
          )
        ).rows[0].granted,
        true,
      );
      const url = new URL(db.connectionString);
      const adminUrl = new URL(process.env.TEST_ADMIN_DATABASE_URL);
      url.username = adminUrl.username;
      url.password = adminUrl.password;
      const removal = { connectionString: url.href, workspaceId: a.id, operatorId: 'local-test', lifecycle: quiet };
      await assert.rejects(teardownDisposableWorkspace(removal), /^Error: unsupported-workspace-dependency$/);
      assert.deepEqual(
        (
          await db.platform.query(`SELECT to_regclass('${schema}.tickets') IS NOT NULL AS tickets,
      to_regclass('${schema}.ticket_totals') IS NOT NULL AS totals, to_regtype('${schema}.mood') IS NOT NULL AS mood`)
        ).rows[0],
        { tickets: true, totals: true, mood: true },
      );
      await db.platform.query(`DROP STATISTICS ${schema}.ticket_shape`);
      assert.deepEqual(await teardownDisposableWorkspace(removal), { workspaceId: a.id, status: 'removed' });
      assert.equal((await workspaceOperationStatus(db.databaseAdmin, a.id)).schemaExists, false);
      assert.equal(
        (await db.platform.query('SELECT count(*)::int AS roles FROM pg_roles WHERE rolname = $1', [a.names.runtime]))
          .rows[0].roles,
        0,
      );
      assert.deepEqual(
        (
          await db.databaseAdmin.query(
            `SELECT coalesce(cardinality(attacl), 0) AS "columnGrants",
      has_table_privilege($1, 'shared_reference.codes', 'SELECT WITH GRANT OPTION') AS delegated
      FROM pg_attribute WHERE attrelid = 'shared_reference.codes'::regclass AND attname = 'code'`,
            [db.owner],
          )
        ).rows[0],
        { columnGrants: 0, delegated: true },
      );
      const runtime = await connect(db.login(b));
      try {
        assert.deepEqual((await runtime.query(`SELECT user_id FROM ${b.names.schema}.tf_memberships`)).rows, [
          { user_id: b.userId },
        ]);
      } finally {
        await runtime.end();
      }
    } finally {
      await db.close();
    }
  },
);
