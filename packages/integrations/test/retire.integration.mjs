import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { lockRolloutTarget } from '../../workspace-storage/src/migrations.ts';
import { provisionWorkspace } from '../../workspace-storage/src/provisioning.ts';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '../../workspaces/dist/table-migrations.js';

test('retiring GitHub team integrations erases every saved token', { timeout: 300000 }, async () => {
  const db = await fixture();
  try {
    const stream = await workspaceTableMigrations();
    const ws = await db.create(stream.slice(0, 28));
    const t = name => qualified(ws.names.schema, name);
    const q = (sql, params) => db.platform.query(sql, params);
    const team = randomUUID();
    await q(`INSERT INTO ${t('tf_teams')} (id,name) VALUES ($1,'Engineering')`, [team]);
    const live = randomUUID();
    const removed = randomUUID();
    await q(
      `INSERT INTO ${t('tf_integrations')} (id,owning_team_id,name,credential,creation_intent,created_by) VALUES ($1,$2,'Live','{"secret":1}','{}','{}')`,
      [live, team],
    );
    await q(
      `INSERT INTO ${t('tf_integrations')} (id,owning_team_id,name,credential,creation_intent,created_by,deleted_at,enabled) VALUES ($1,$2,'Removed',NULL,'{}','{}','2026-01-01',false)`,
      [removed, team],
    );

    await q('BEGIN');
    await lockRolloutTarget(db.platform, stream, true);
    await q('COMMIT');
    await provisionWorkspace({
      connectionString: db.connectionString,
      workspaceId: ws.id,
      passwords: ws.passwords,
      initialAdmin: { userId: ws.userId, membershipId: ws.membershipId },
      migrations: stream,
    });

    const rows = Object.fromEntries(
      (
        await q(`SELECT id,enabled,credential,generation,deleted_at::text AS deleted_at FROM ${t('tf_integrations')}`)
      ).rows.map(row => [row.id, row]),
    );
    assert.equal(rows[live].credential, null);
    assert.equal(rows[live].enabled, false);
    assert.equal(rows[live].generation, 2);
    assert.notEqual(rows[live].deleted_at, null);
    assert.equal(rows[removed].generation, 1);
    assert.match(rows[removed].deleted_at, /^2026-01-01/);
  } finally {
    await db.close();
  }
});
