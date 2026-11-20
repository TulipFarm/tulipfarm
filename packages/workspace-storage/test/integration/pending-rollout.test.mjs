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
    const workspace = await db.create(baseline);
    const table = name => qualified(workspace.names.schema, name);
    const sql = 'CREATE TABLE {{schema}}.tf_upgrade_probe (id integer PRIMARY KEY)';
    const stream = [
      ...baseline,
      { name: '9999_upgrade_probe.sql', sql, checksum: createHash('sha256').update(sql).digest('hex') },
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
    assert.equal(
      await inTransaction(db.platform, client => applyCommonMigrations(client, workspace.id, baseline)),
      baseline.length,
    );
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
        baseline.length,
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
      baseline.length + 1,
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
        { name: '9999_upgrade_probe.sql', sql, checksum: createHash('sha256').update(sql).digest('hex') },
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
        db.baseline.length,
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

test('a rollout queues for the authorization lock in arrival order instead of starving behind readers', async () => {
  const db = await fixture();
  const first = await connect(db.connectionString);
  const later = await connect(db.connectionString);
  try {
    const workspace = await db.create();
    const sql = 'CREATE TABLE {{schema}}.tf_queue_probe (id integer)';
    const stream = [
      ...db.baseline,
      { name: '9999_queue_probe.sql', sql, checksum: createHash('sha256').update(sql).digest('hex') },
    ];
    const read = client =>
      client.query(
        `SELECT a.id FROM (SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 518204))) q, ${qualified(workspace.names.schema, 'tf_authorization_lock')} a WHERE a.id = 1 FOR SHARE OF a`,
        [workspace.names.schema],
      );
    await first.query('BEGIN');
    await read(first);
    const rollout = rolloutCommonMigrations({
      connectionString: db.connectionString,
      migrations: stream,
      concurrency: 1,
      listWorkspaceIds: async () => [workspace.id],
    });
    for (let i = 0; i < 100; i++) {
      const waiting = await db.platform.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
      if (waiting.rowCount) break;
      await delay(20);
    }
    await later.query("BEGIN; SET LOCAL lock_timeout = '300ms'");
    await assert.rejects(read(later), { code: '55P03' });
    await later.query('ROLLBACK');
    await first.query('COMMIT');
    assert.deepEqual((await rollout).results, [{ workspaceId: workspace.id, status: 'applied', errorCode: null }]);
  } finally {
    await first.end();
    await later.end();
    await db.close();
  }
});

test('a rollout skips a current workspace without waiting for its authorization lock', async () => {
  const db = await fixture();
  const writer = await connect(db.connectionString);
  try {
    const workspace = await db.create();
    await writer.query('BEGIN');
    await writer.query(
      `SELECT a.id FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 518204))) q, ${qualified(workspace.names.schema, 'tf_authorization_lock')} a WHERE a.id = 1 FOR UPDATE OF a`,
      [workspace.names.schema],
    );
    const started = performance.now();
    const { results } = await rolloutCommonMigrations({
      connectionString: db.connectionString,
      migrations: db.baseline,
      concurrency: 1,
      listWorkspaceIds: async () => [workspace.id],
    });
    assert.deepEqual(results, [{ workspaceId: workspace.id, status: 'applied', errorCode: null }]);
    assert.ok(performance.now() - started < 4000);
  } finally {
    await writer.query('ROLLBACK');
    await writer.end();
    await db.close();
  }
});
