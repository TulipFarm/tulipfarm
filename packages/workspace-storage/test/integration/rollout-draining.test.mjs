import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { qualified, rolloutCommonMigrations } from '../../src/provisioning.ts';
import { escapeIdentifier } from 'pg';
import { fixture } from './fixture.mjs';

test('rollout drains callbacks and collects every worker failure before rejection', { timeout: 30000 }, async () => {
  const db = await fixture();
  const release = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let run;
  try {
    for (let i = 0; i < 4; i++) await db.create();
    let count = 0;
    const failures = [new Error('first callback failure'), new Error('second callback failure')];
    let settled = false;
    run = rolloutCommonMigrations({
      connectionString: db.connectionString,
      migrations: db.baseline,
      concurrency: 4,
      listWorkspaceIds: async () => db.workspaces.map(item => item.id),
      afterWorkspace: async () => {
        const index = count++;
        if (count === 4) entered.resolve();
        await entered.promise;
        if (index < 2) throw failures[index];
        await release.promise;
      },
    }).then(
      value => {
        settled = true;
        return value;
      },
      error => {
        settled = true;
        return error;
      },
    );
    await entered.promise;
    await delay(100);
    const rejectedBeforeDrain = settled;
    release.resolve();
    const error = await run;
    assert.equal(rejectedBeforeDrain, false);
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(new Set(error.errors), new Set(failures));
    const progress = await db.platform.query('SELECT status, attempts FROM database_management.common_rollouts');
    assert.equal(progress.rowCount, 4);
    assert.ok(progress.rows.every(row => row.status === 'applied' && row.attempts === 1));
  } finally {
    release.resolve();
    await run;
    await db.close();
  }
});

test(
  'terminated rollout integration rejects after siblings commit and preserves resumable progress',
  { timeout: 30000 },
  async () => {
    const db = await fixture();
    try {
      for (let i = 0; i < 3; i++) await db.create();
      const failed = db.workspaces[0];
      const sql = `DO $$ BEGIN
      IF '{{schema}}' = '"${failed.names.schema}"' THEN
        PERFORM pg_terminate_backend(pg_backend_pid());
      ELSE PERFORM pg_sleep(0.3); END IF;
      END $$; CREATE TABLE {{schema}}.tf_drain_probe (id integer);`;
      const stream = [
        ...db.baseline,
        { name: '0007_drain_probe.sql', sql, checksum: createHash('sha256').update(sql).digest('hex') },
      ];
      await assert.rejects(
        rolloutCommonMigrations({
          connectionString: db.connectionString,
          migrations: stream,
          concurrency: 3,
          listWorkspaceIds: async () => db.workspaces.map(item => item.id),
        }),
        error => error instanceof AggregateError && error.errors.length === 1,
      );
      const progress = (
        await db.platform.query('SELECT workspace_id, status, attempts FROM database_management.common_rollouts')
      ).rows;
      assert.deepEqual(
        progress.find(row => row.workspace_id === failed.id),
        { workspace_id: failed.id, status: 'pending', attempts: 0 },
      );
      assert.equal(progress.filter(row => row.status === 'applied' && row.attempts === 1).length, 2);
      for (const item of db.workspaces.slice(1)) {
        assert.equal(
          (
            await db.platform.query(
              `SELECT count(*)::integer AS count FROM ${qualified(item.names.schema, 'tf_common_migrations')}`,
            )
          ).rows[0].count,
          db.baseline.length + 1,
        );
        await db.platform.query(`SELECT * FROM ${qualified(item.names.schema, 'tf_drain_probe')}`);
      }
    } finally {
      await db.close();
    }
  },
);

test('rollout collects worker integration failures before closing the controller', { timeout: 30000 }, async () => {
  const db = await fixture();
  try {
    for (let i = 0; i < 3; i++) await db.create();
    await assert.rejects(
      rolloutCommonMigrations({
        connectionString: db.connectionString,
        migrations: db.baseline,
        concurrency: 3,
        listWorkspaceIds: async () => {
          await db.admin.query(`ALTER ROLE ${escapeIdentifier(db.owner)} NOLOGIN`);
          return db.workspaces.map(item => item.id);
        },
      }),
      error =>
        error instanceof AggregateError &&
        error.errors.length === 3 &&
        error.errors.every(item => item.code === '28000'),
    );
    assert.equal((await db.platform.query('SELECT * FROM database_management.common_rollouts')).rowCount, 0);
    assert.equal(
      (
        await db.databaseAdmin.query(
          `SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname = current_database() AND usename = $1`,
          [db.owner],
        )
      ).rows[0].count,
      1,
    );
  } finally {
    await db.admin.query(`ALTER ROLE ${escapeIdentifier(db.owner)} LOGIN`);
    await db.close();
  }
});
