import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fixture } from '../../../../packages/workspace-storage/test/integration/fixture.mjs';
import { grantApplicationAccess } from '../../src/postgres.ts';

test('application grant replay preserves Slack registry identity and denies receipt deletion', async () => {
  const db = await fixture();
  let created = false;
  try {
    if (!(await db.admin.query("SELECT 1 FROM pg_roles WHERE rolname='tulipfarm'")).rowCount) {
      await db.admin.query('CREATE ROLE tulipfarm NOLOGIN');
      created = true;
    }
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    for (let i = 0; i < 2; i++) {
      await grantApplicationAccess(db.databaseAdmin, 'isolated-v1');
      const grants = (
        await db.databaseAdmin
          .query(`SELECT has_table_privilege('tulipfarm','app.slack_workspace_links','SELECT') AS read,
        has_table_privilege('tulipfarm','app.slack_workspace_links','INSERT') AS insert,
        has_table_privilege('tulipfarm','app.slack_workspace_links','DELETE') AS delete,
        has_column_privilege('tulipfarm','app.slack_workspace_links','state','UPDATE') AS transition,
        has_column_privilege('tulipfarm','app.slack_workspace_links','workspace_id','UPDATE') AS move,
        has_column_privilege('tulipfarm','app.slack_workspace_links','installation_id','UPDATE') AS replace`)
      ).rows[0];
      assert.deepEqual(grants, {
        read: true,
        insert: true,
        delete: false,
        transition: true,
        move: false,
        replace: false,
      });
    }
    await db.databaseAdmin.query('SET ROLE tulipfarm');
    await db.databaseAdmin
      .query(`INSERT INTO app.slack_workspace_links(workspace_id,installation_id,app_id,state,state_hash,session_id,user_id,membership_id,expires_at)
      VALUES ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','ATEST','reserved','hash','session','user','33333333-3333-4333-8333-333333333333',now())`);
    assert.deepEqual(
      (await db.databaseAdmin.query("UPDATE app.slack_workspace_links SET state='failed' RETURNING state")).rows,
      [{ state: 'failed' }],
    );
    await assert.rejects(db.databaseAdmin.query('DELETE FROM app.slack_workspace_links'), { code: '42501' });
    await assert.rejects(
      db.databaseAdmin.query('UPDATE app.slack_workspace_links SET installation_id=gen_random_uuid()'),
      { code: '42501' },
    );
    await db.databaseAdmin.query('RESET ROLE');
  } finally {
    await db.close();
    if (created) {
      const { Client } = await import('pg');
      const admin = new Client({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
      await admin.connect();
      try {
        await admin.query('DROP ROLE tulipfarm');
      } finally {
        await admin.end();
      }
    }
  }
});
