import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applyCommonMigrations, inTransaction, qualified } from '../../src/provisioning.ts';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { fixture } from './fixture.mjs';

test(
  'active sponsorship backfill keeps only proven active consent and clears it when the sponsorship changes',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    try {
      const migrations = await workspaceTableMigrations();
      const index = migrations.findIndex(item => item.name === '0061_workflow_active_sponsorship.sql');
      assert.ok(index > 0);
      const workspace = await db.create(migrations.slice(0, index));
      const table = name => qualified(workspace.names.schema, name);
      const cases = [
        { enabled: true, newer: false, acceptedNewer: false, sponsored: true, covered: true },
        { enabled: true, newer: true, acceptedNewer: false, sponsored: true, covered: true },
        { enabled: false, newer: false, acceptedNewer: false, sponsored: true, covered: false },
        { enabled: true, newer: true, acceptedNewer: true, sponsored: true, covered: false },
        { enabled: true, newer: false, acceptedNewer: false, sponsored: false, covered: false },
      ].map(item => ({
        ...item,
        id: randomUUID(),
        active: randomUUID(),
        saved: randomUUID(),
        sponsorship: randomUUID(),
      }));
      await inTransaction(db.platform, async client => {
        for (const item of cases) {
          const saved = item.newer ? item.saved : item.active;
          await client.query(`INSERT INTO ${table('tf_workflows')}(id,revision) VALUES($1,$2)`, [item.id, saved]);
          for (const revision of new Set([saved, item.active]))
            await client.query(
              `INSERT INTO ${table('tf_workflow_revisions')}(workflow_id,id,definition,author_membership_id) VALUES($1,$2,'{}',$3)`,
              [item.id, revision, workspace.membershipId],
            );
          await client.query(
            `UPDATE ${table('tf_workflows')} SET active_revision=$2,enabled=$3,sponsor_membership_id=$4,sponsorship_id=$5,sponsorship_revision=$6 WHERE id=$1`,
            [
              item.id,
              item.active,
              item.enabled,
              workspace.membershipId,
              item.sponsored ? item.sponsorship : null,
              item.acceptedNewer ? saved : item.active,
            ],
          );
        }
      });
      await inTransaction(db.platform, client => applyCommonMigrations(client, workspace.id, migrations));
      const marker = async id =>
        (await db.platform.query(`SELECT sponsorship_active_revision FROM ${table('tf_workflows')} WHERE id=$1`, [id]))
          .rows[0].sponsorship_active_revision;
      for (const item of cases) assert.equal(await marker(item.id), item.covered ? item.active : null);
      const current = cases[0];
      await db.platform.query(`UPDATE ${table('tf_workflows')} SET sponsorship_id=$2 WHERE id=$1`, [
        current.id,
        current.sponsorship,
      ]);
      assert.equal(await marker(current.id), current.active, 'keeping the sponsorship ID preserves active consent');
      await db.platform.query(`UPDATE ${table('tf_workflows')} SET sponsorship_id=$2 WHERE id=$1`, [
        current.id,
        randomUUID(),
      ]);
      assert.equal(await marker(current.id), null, 'a replacement sponsorship cannot inherit active consent');
    } finally {
      await db.close();
    }
  },
);
