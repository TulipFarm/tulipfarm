import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applyCommonMigrations, inTransaction, qualified } from '../../src/provisioning.ts';
import { workspaceTableMigrations } from '../../../workspaces/src/table-migrations.ts';
import { fixture } from './fixture.mjs';

for (const version of [54, 55, 56]) {
  test(
    `upgrading account coverage from version ${version} preserves sources and separates accounts`,
    { timeout: 60000 },
    async () => {
      const db = await fixture();
      try {
        const stream = await workspaceTableMigrations();
        const upgrade = stream.findIndex(item => item.name === '0057_knowledge_account_coverage.sql');
        assert.ok(upgrade > 0);
        const workspace = await db.create(stream.slice(0, version));
        const table = name => qualified(workspace.names.schema, name);
        const sourceId = randomUUID(),
          accountId = randomUUID(),
          cloudId = randomUUID(),
          intentId = randomUUID();
        const selection = { product: 'jira', cloudId, targets: [{ kind: 'project', id: '7001', descendants: false }] };
        await db.platform.query(
          `INSERT INTO ${table('tf_knowledge_sources')} (id,provider,account_namespace,selection,owner_membership_id) VALUES ($1,'jira',$2,$3::jsonb::text,$4)`,
          [sourceId, cloudId, selection, workspace.membershipId],
        );
        await db.platform.query(
          `INSERT INTO ${table('tf_knowledge_atlassian_sources')} (source_id,product,binding,selection,title,fingerprint,cursor) VALUES ($1,'jira',$2,$3,'Existing projects','fixture','{}')`,
          [sourceId, { accountId, cloudId, atlassianAccountId: 'owner' }, selection],
        );
        await db.platform.query(
          `INSERT INTO ${table('tf_knowledge_default_intents')} (id,product,membership_id,account_key,account_label) VALUES ($1,'jira',$2,$3,'owner@example.test')`,
          [intentId, workspace.membershipId, accountId],
        );
        assert.equal(
          await inTransaction(db.platform, client => applyCommonMigrations(client, workspace.id, stream)),
          stream.length,
        );
        assert.deepEqual(
          (
            await db.platform.query(
              `SELECT id,state,account_namespace,account_identity FROM ${table('tf_knowledge_sources')} WHERE id=$1`,
              [sourceId],
            )
          ).rows,
          [{ id: sourceId, state: 'active', account_namespace: cloudId, account_identity: accountId }],
        );
        assert.equal(
          (
            await db.platform.query(
              `SELECT restore_coverage FROM ${table('tf_knowledge_default_intents')} WHERE id=$1`,
              [intentId],
            )
          ).rows[0].restore_coverage,
          false,
        );
        const insert = account =>
          db.platform.query(
            `INSERT INTO ${table('tf_knowledge_sources')} (id,provider,account_namespace,selection,owner_membership_id,account_identity) VALUES ($1,'jira',$2,$3::jsonb::text,$4,$5)`,
            [randomUUID(), cloudId, selection, workspace.membershipId, account],
          );
        await assert.rejects(insert(accountId), error => error.code === '23505');
        await insert(randomUUID());
      } finally {
        await db.close();
      }
    },
  );
}
