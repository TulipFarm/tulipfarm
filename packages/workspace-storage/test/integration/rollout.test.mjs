import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  inTransaction,
  applyCommonMigrations,
  qualified,
  rolloutCommonMigrations,
  provisionWorkspace,
} from '../../src/provisioning.ts';
import { connect, denied, fixture } from './fixture.mjs';

function migration(name, sql) {
  return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}

test(
  '100 workspace rollout resumes failure, catches creation races and drift, and recovers forward',
  { timeout: 180000 },
  async t => {
    const db = await fixture();
    const started = performance.now();
    try {
      for (let i = 0; i < 99; i++) await db.create();
      const failure = db.workspaces[17];
      const stream = [
        ...db.baseline,
        migration(
          '0007_rollout_probe.sql',
          "CREATE TABLE {{schema}}.tf_atomic_probe (id integer); INSERT INTO {{schema}}.tf_atomic_probe VALUES (42); CREATE TABLE {{schema}}.tf_rollout_probe (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO {{schema}}.tf_rollout_probe VALUES (1, 'once');",
        ),
      ];
      await db.platform.query(`CREATE TABLE ${qualified(failure.names.schema, 'tf_rollout_probe')} (id integer)`);
      let createdDuringRollout = false;
      const first = await rolloutCommonMigrations({
        connectionString: db.connectionString,
        migrations: stream,
        concurrency: 4,
        listWorkspaceIds: async () => db.workspaces.map(({ id }) => id),
        afterWorkspace: async () => {
          if (!createdDuringRollout) {
            createdDuringRollout = true;
            await db.create(stream);
          }
        },
      });
      assert.equal(db.workspaces.length, 100);
      assert.equal(first.results.filter(({ status }) => status === 'applied').length, 99);
      assert.deepEqual(
        first.results.filter(({ status }) => status !== 'applied'),
        [{ workspaceId: failure.id, status: 'failed', errorCode: '42P07' }],
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::integer AS count FROM ${qualified(failure.names.schema, 'tf_common_migrations')}`,
          )
        ).rows[0].count,
        db.baseline.length,
      );
      assert.equal(
        (
          await db.platform.query('SELECT to_regclass($1) AS relation', [
            qualified(failure.names.schema, 'tf_atomic_probe'),
          ])
        ).rows[0].relation,
        null,
      );
      await assert.rejects(
        provisionWorkspace({
          connectionString: db.connectionString,
          workspaceId: failure.id,
          passwords: failure.passwords,
          initialAdmin: { userId: failure.userId, membershipId: failure.membershipId },
          migrations: db.baseline,
        }),
        /current rollout target/,
      );
      await db.platform.query(`DROP TABLE ${qualified(failure.names.schema, 'tf_rollout_probe')}`);
      const second = await rolloutCommonMigrations({
        connectionString: db.connectionString,
        migrations: stream,
        concurrency: 4,
        listWorkspaceIds: async () => db.workspaces.map(({ id }) => id),
      });
      assert.equal(second.results.filter(({ status }) => status === 'applied').length, 100);
      for (const workspace of db.workspaces) {
        assert.deepEqual(
          (await db.platform.query(`SELECT * FROM ${qualified(workspace.names.schema, 'tf_rollout_probe')}`)).rows,
          [{ id: 1, value: 'once' }],
        );
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::integer AS count FROM ${qualified(workspace.names.schema, 'tf_common_migrations')}`,
            )
          ).rows[0].count,
          db.baseline.length + 1,
        );
      }
      const altered = [migration(db.baseline[0].name, `${db.baseline[0].sql}\nSELECT 1;`), ...stream.slice(1)];
      await assert.rejects(
        rolloutCommonMigrations({
          connectionString: db.connectionString,
          migrations: altered,
          listWorkspaceIds: async () => [],
        }),
        /history differs/,
      );
      await assert.rejects(
        inTransaction(db.platform, client => applyCommonMigrations(client, failure.id, altered)),
        /history differs/,
      );
      await db.platform.query(
        `UPDATE ${qualified(failure.names.schema, 'tf_common_migrations')} SET checksum = 'drift' WHERE name = $1`,
        [stream.at(-1).name],
      );
      const blocked = await rolloutCommonMigrations({
        connectionString: db.connectionString,
        migrations: stream,
        listWorkspaceIds: async () => [failure.id],
      });
      assert.equal(blocked.results[0].status, 'blocked');
      await db.platform.query(
        `UPDATE ${qualified(failure.names.schema, 'tf_common_migrations')} SET checksum = $1 WHERE name = $2`,
        [stream.at(-1).checksum, stream.at(-1).name],
      );
      const recovery = [
        ...stream,
        migration(
          '0008_forward_recovery.sql',
          'ALTER TABLE {{schema}}.tf_rollout_probe ADD COLUMN release integer NOT NULL DEFAULT 3;',
        ),
      ];
      const recovered = await rolloutCommonMigrations({
        connectionString: db.connectionString,
        migrations: recovery,
        concurrency: 4,
        listWorkspaceIds: async () => db.workspaces.map(({ id }) => id),
      });
      assert.equal(recovered.results.filter(({ status }) => status === 'applied').length, 100);
      assert.deepEqual(
        (await db.platform.query(`SELECT * FROM ${qualified(failure.names.schema, 'tf_rollout_probe')}`)).rows,
        [{ id: 1, value: 'once', release: 3 }],
      );
      const owners = await db.platform.query(
        "SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'ws_%' AND c.relname = 'tf_rollout_probe'",
      );
      assert.deepEqual(owners.rows, [{ owner: db.owner }]);
      const runtime = await connect(db.login(failure));
      try {
        await denied(runtime, `SELECT * FROM ${qualified(failure.names.schema, 'tf_rollout_probe')}`);
      } finally {
        await runtime.end();
      }
      t.diagnostic(
        `100 workspaces, 4 rollout integrations plus controller, ${Math.round(performance.now() - started)} ms including provisioning and recovery`,
      );
    } finally {
      await db.close();
    }
  },
);
