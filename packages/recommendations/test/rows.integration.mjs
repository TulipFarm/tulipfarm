import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { createTableService } from '../../tables/dist/service.js';
import { createGeneration, activateGeneration } from '../../tables/dist/store.js';

test(
  'table first/last rows are serialized milestones; ordinary edits and intermediate rows are excluded',
  { timeout: 60000 },
  async () => {
    const f = await conversationFixture();
    let migration;
    try {
      const { id: workspaceId, userId, membershipId } = f.workspace;
      migration = await connect(f.db.login(f.workspace, 'migration'));
      const teamId = randomUUID(),
        tableId = randomUUID(),
        fieldId = randomUUID(),
        revision = '1'.repeat(40);
      await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')}(id,name) VALUES($1,'Fixture')`, [teamId]);
      const definition = {
        formatVersion: 2,
        id: tableId,
        owningTeamId: teamId,
        label: 'Checklist',
        fields: [{ id: fieldId, label: 'Title', kind: 'text', maxLength: 100, required: false }],
        uniqueKeys: [],
      };
      await inTransaction(migration, async client => {
        await client.query(`SET LOCAL ROLE "${f.workspace.names.customOwner}"`);
        const tx = { client, schema: f.workspace.names.schema };
        const generation = await createGeneration(tx, { definition, revision });
        await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
      });
      const events = async kind =>
        (
          await f.db.platform.query(
            `SELECT membership_ids,invalidate FROM ${f.table('tf_recommendation_events')} WHERE source_id=$1 AND kind=$2`,
            [tableId, kind],
          )
        ).rows;
      assert.deepEqual(await events('definition'), [{ membership_ids: [membershipId], invalidate: false }]);
      const tables = createTableService(f.runtime, { readableFiles: async () => new Set() }, commonCompatibility);
      const mutate = change => tables.mutate(workspaceId, userId, { tableId, revision, ...change });
      const [first, second] = await Promise.all(
        [1, 2].map(i =>
          mutate({
            kind: 'create',
            recordId: randomUUID(),
            values: { [fieldId]: { kind: 'text', value: `Item ${i}` } },
          }),
        ),
      );
      assert.equal((await events('rows')).length, 1);
      const edited = await mutate({
        kind: 'update',
        recordId: first.id,
        expectedToken: first.token,
        values: { [fieldId]: { kind: 'text', value: 'Edited' } },
      });
      assert.equal((await events('rows')).length, 1);
      await mutate({ kind: 'delete', recordId: edited.id, expectedToken: edited.token });
      assert.equal((await events('rows')).length, 1);
      await mutate({ kind: 'delete', recordId: second.id, expectedToken: second.token });
      assert.equal((await events('rows')).length, 2);
      await assert.rejects(mutate({ kind: 'delete', recordId: second.id, expectedToken: second.token }));
      assert.equal((await events('rows')).length, 2);
    } finally {
      await migration?.end();
      await f.close();
    }
  },
);
