import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fixture, connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { createTableService } from '@tulipfarm/tables/service';
import { createTableCleanup } from '@tulipfarm/tables/cleanup';
import {
  activeGeneration,
  activateGeneration,
  createGeneration,
  readRecords,
  workspaceMembersTable,
  writeGenerationRecord,
} from '@tulipfarm/tables/store';
import { manualWorkspaceMemberValues } from '@tulipfarm/tables/workspace-members';

test(
  'photo cleanup respects live rows, retained generations and history holds without starving expired snapshots',
  { timeout: 45000 },
  async t => {
    const db = await fixture(),
      workspace = await db.create();
    const runtime = createWorkspaceRuntime({
      resolveCredential: async () => ({
        workspaceId: workspace.id,
        generation: 1,
        connectionString: db.login(workspace),
      }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    t.after(async () => {
      await runtime.close();
      await db.close();
    });
    const s = `"${workspace.names.schema}"`;
    assert.deepEqual(
      (
        await db.platform.query(
          `SELECT has_table_privilege($1,$2,'DELETE') AS delete,
    has_any_column_privilege($1,$2,'UPDATE') AS update`,
          [workspace.names.customOwner, `${s}.tf_workspace_member_images`],
        )
      ).rows[0],
      { delete: true, update: false },
      'Photo cleanup must not require broader image write privileges',
    );
    const tables = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
    let generation = await runtime.transaction(workspace.id, commonCompatibility, async tx =>
      activeGeneration(tx, (await workspaceMembersTable(tx)).coreDefinition.id),
    );
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTH0AAAAASUVORK5CYII=';
    const picture = (record, value) =>
      tables.mutateMember(workspace.id, workspace.userId, {
        kind: 'member-photo',
        tableId: generation.table_id,
        recordId: record.id,
        revision: generation.revision,
        expectedToken: record.token,
        image: value,
      });
    const person = async name =>
      picture(
        await tables.mutate(workspace.id, workspace.userId, {
          kind: 'create',
          tableId: generation.table_id,
          revision: generation.revision,
          recordId: randomUUID(),
          values: manualWorkspaceMemberValues({ name }),
        }),
        image,
      );
    const live = await person('Current image'),
      retired = await person('Retired generation image');
    const prior = generation;
    const migration = await connect(db.login(workspace, 'migration'));
    try {
      generation = await inTransaction(migration, async client => {
        await client.query(`SET LOCAL ROLE "${workspace.names.customOwner}"`);
        const tx = { client, schema: workspace.names.schema };
        const next = await createGeneration(tx, { definition: generation.definition, revision: 'f'.repeat(40) });
        for (const record of await readRecords(tx, prior, { limit: 100 })) {
          await writeGenerationRecord(tx, {
            generationId: next.id,
            recordId: record.id,
            token: record.token,
            values: record.values,
          });
        }
        const active = await activateGeneration(tx, { generationId: next.id, expectedActiveGenerationId: prior.id });
        await client.query(`REVOKE ALL ON ${s}."${prior.physical_table}" FROM "${workspace.names.runtime}"`);
        await client.query(
          `UPDATE ${s}.tf_table_catalog
        SET physical_table=$2,target_revision=$3,applied_revision=$3,applied_definition=$4 WHERE id=$1`,
          [active.table_id, active.physical_table, active.revision, active.definition],
        );
        return active;
      });
    } finally {
      await migration.end();
    }
    await picture(retired, null);
    const held = await person('History hold image'),
      expired = await person('Expired image');
    await picture(held, null);
    await picture(expired, null);
    const historyId = (
      await db.platform.query(
        `SELECT id FROM ${s}.tf_table_row_history_data
    WHERE row_id=$1 AND operation='update' ORDER BY id DESC LIMIT 1`,
        [held.id],
      )
    ).rows[0].id;
    const holder = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_table_history_holds(history_id,holder_id) VALUES($1,$2)`, [
      historyId,
      holder,
    ]);
    await db.platform.query(
      `UPDATE ${s}.tf_workspace_member_images SET created_at=clock_timestamp()-interval '32 days'`,
    );
    await db.platform.query(
      `UPDATE ${s}.tf_table_row_history_data SET recoverable_until=clock_timestamp()-interval '1 day'`,
    );
    const cleanup = createTableCleanup({
      resolveMigrationCredential: async () => db.login(workspace, 'migration'),
      batchRows: 1,
    });
    const drain = async () => {
      for (let i = 0; i < 50; i++) if ((await cleanup(workspace.id)) === 'completed') return;
      assert.fail('Member image cleanup did not converge');
    };
    const retainedIds = async () =>
      (await db.platform.query(`SELECT member_id FROM ${s}.tf_workspace_member_images ORDER BY member_id`)).rows.map(
        row => row.member_id,
      );
    await drain();
    assert.deepEqual(await retainedIds(), [live.id, held.id, retired.id].sort());
    await db.platform.query(`DELETE FROM ${s}.tf_table_history_holds WHERE holder_id=$1`, [holder]);
    await db.platform.query(
      `UPDATE ${s}.tf_table_generations SET retired_at=clock_timestamp()-interval '32 days' WHERE id=$1`,
      [prior.id],
    );
    await drain();
    assert.deepEqual(await retainedIds(), [live.id]);
    assert.equal(
      (await db.platform.query(`SELECT to_regclass($1) AS physical`, [`${s}."${prior.physical_table}"`])).rows[0]
        .physical,
      null,
    );
  },
);
