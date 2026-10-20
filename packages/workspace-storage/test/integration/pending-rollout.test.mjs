import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { applyCommonMigrations, inTransaction, qualified, rolloutCommonMigrations } from '../../src/provisioning.ts';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { connect, fixture } from './fixture.mjs';

test('common upgrades refuse unfinished resource work without changing receipts or plans', async () => {
  const db = await fixture();
  try {
    const current = await workspaceTableMigrations();
    const baseline = current;
    assert.equal(baseline.length, 1);
    const workspace = await db.create(baseline);
    const table = name => qualified(workspace.names.schema, name);
    const sql = 'CREATE TABLE {{schema}}.tf_upgrade_probe (id integer PRIMARY KEY)';
    const stream = [
      ...baseline,
      { name: '0007_upgrade_probe.sql', sql, checksum: createHash('sha256').update(sql).digest('hex') },
    ];
    const teamId = randomUUID();
    const tableId = randomUUID();
    const commandId = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_teams')} (id, name) VALUES ($1, 'Test')`, [teamId]);
    await db.platform.query(
      `INSERT INTO ${table('tf_authoring_commands')} (id, membership_id, table_id, request_id, change, status) VALUES ($1,$2,$3,'test','{}','preparing')`,
      [commandId, workspace.membershipId, tableId],
    );
    await assert.rejects(
      inTransaction(db.platform, client => applyCommonMigrations(client, workspace.id, stream)),
      /unfinished table work/,
    );
    assert.equal(await inTransaction(db.platform, client => applyCommonMigrations(client, workspace.id, baseline)), 1);
    await db.platform.query(`UPDATE ${table('tf_authoring_commands')} SET status = 'accepted' WHERE id = $1`, [
      commandId,
    ]);
    await db.platform.query(
      `INSERT INTO ${table('tf_table_catalog')} (id, owning_team_id, physical_table, display_name, target_revision) VALUES ($1,$2,'records','Records','revision')`,
      [tableId, teamId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_migration_jobs')} (id, table_id, command_id, membership_id, target_revision, plan_digest, common_version) VALUES ($1,$2,$1,$3,'revision','original-digest',1)`,
      [commandId, tableId, workspace.membershipId],
    );
    for (const status of ['queued', 'planning', 'waiting_for_confirmation', 'blocked', 'applying', 'failed']) {
      await db.platform.query(`UPDATE ${table('tf_migration_jobs')} SET status = $1`, [status]);
      const result = await rolloutCommonMigrations({
        connectionString: db.connectionString,
        migrations: stream,
        listWorkspaceIds: async () => [workspace.id],
      });
      assert.deepEqual(result.results, [
        { workspaceId: workspace.id, status: 'blocked', errorCode: 'pending_table_work' },
      ]);
      assert.deepEqual(
        (await db.platform.query(`SELECT status, plan_digest, common_version FROM ${table('tf_migration_jobs')}`)).rows,
        [{ status, plan_digest: 'original-digest', common_version: 1 }],
      );
      assert.equal(
        (await db.platform.query(`SELECT count(*)::integer AS count FROM ${table('tf_common_migrations')}`)).rows[0]
          .count,
        1,
      );
      assert.equal(
        (await db.platform.query('SELECT to_regclass($1) AS relation', [table('tf_upgrade_probe')])).rows[0].relation,
        null,
      );
    }
    await db.platform.query(`UPDATE ${table('tf_migration_jobs')} SET status = 'rejected'`);
    const result = await rolloutCommonMigrations({
      connectionString: db.connectionString,
      migrations: stream,
      listWorkspaceIds: async () => [workspace.id],
    });
    assert.deepEqual(result.results, [{ workspaceId: workspace.id, status: 'applied', errorCode: null }]);
    assert.equal(
      (await db.platform.query(`SELECT count(*)::integer AS count FROM ${table('tf_common_migrations')}`)).rows[0]
        .count,
      2,
    );
  } finally {
    await db.close();
  }
});

test(
  'upgrade waits for in-flight authoring and refuses the command committed while it waited',
  { timeout: 15000 },
  async () => {
    const db = await fixture();
    let author;
    let upgrader;
    try {
      const workspace = await db.create();
      const table = name => qualified(workspace.names.schema, name);
      author = await connect(db.login(workspace));
      upgrader = await connect(db.connectionString);
      const sql = 'CREATE TABLE {{schema}}.tf_upgrade_probe (id integer)';
      const stream = [
        ...db.baseline,
        { name: '0007_upgrade_probe.sql', sql, checksum: createHash('sha256').update(sql).digest('hex') },
      ];
      await author.query('BEGIN');
      await author.query(`SELECT count(*) FROM ${table('tf_common_migrations')}`);
      const upgradePid = (await upgrader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const result = inTransaction(upgrader, client => applyCommonMigrations(client, workspace.id, stream)).then(
        value => ({ value }),
        error => ({ error }),
      );
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting =
          (
            await db.platform.query(
              "SELECT 1 FROM pg_locks WHERE pid = $1 AND mode = 'AccessExclusiveLock' AND NOT granted",
              [upgradePid],
            )
          ).rowCount === 1;
        if (waiting) break;
        await delay(10);
      }
      assert.equal(waiting, true, 'upgrade must wait on the runtime receipt-read lock');
      await author.query(
        `INSERT INTO ${table('tf_authoring_commands')} (id, membership_id, table_id, request_id, change, status) VALUES ($1,$2,$3,'racing-save','{}','preparing')`,
        [randomUUID(), workspace.membershipId, randomUUID()],
      );
      await author.query('COMMIT');
      assert.match((await result).error?.message ?? '', /unfinished table work/);
      assert.equal(
        (await db.platform.query(`SELECT count(*)::integer AS count FROM ${table('tf_common_migrations')}`)).rows[0]
          .count,
        1,
      );
      assert.deepEqual((await author.query(`SELECT request_id, status FROM ${table('tf_authoring_commands')}`)).rows, [
        { request_id: 'racing-save', status: 'preparing' },
      ]);
    } finally {
      await author?.query('ROLLBACK');
      await author?.end();
      await upgrader?.end();
      await db.close();
    }
  },
);
