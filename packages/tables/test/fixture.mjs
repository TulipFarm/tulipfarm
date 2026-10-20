import { randomUUID } from 'node:crypto';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { createTableService } from '../../tables/dist/service.js';
import {
  createGeneration,
  activateGeneration,
  activeGeneration,
  workspaceMembersTable,
} from '../../tables/dist/store.js';
import { manualWorkspaceMemberValues } from '../../tables/dist/workspace-members.js';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

export const textField = (label = 'Name', id = randomUUID()) => ({
  id,
  label,
  kind: 'text',
  required: false,
  maxLength: 10000,
});
export const text = value => ({ kind: 'text', value });
export const textValues = (field, value) => ({ [field.id]: text(value) });

export function tableDefinition({ owningTeamId, label = 'Records', id = randomUUID(), fields = [textField()] }) {
  return { formatVersion: 2, id, owningTeamId, label, fields, uniqueKeys: [] };
}

export async function createWorkspaceMember({ runtime, workspace, profile }) {
  const generation = await runtime.transaction(workspace.id, commonCompatibility, async tx =>
    activeGeneration(tx, (await workspaceMembersTable(tx)).coreDefinition.id),
  );
  return createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility).mutate(
    workspace.id,
    workspace.userId,
    {
      kind: 'create',
      tableId: generation.table_id,
      revision: generation.revision,
      recordId: randomUUID(),
      values: manualWorkspaceMemberValues(profile),
    },
  );
}

export async function createTableWithRows({
  db,
  workspace,
  runtime,
  definition,
  records = [],
  revision = 'a'.repeat(40),
  hooks = {},
}) {
  const migration = await connect(db.login(workspace, 'migration'));
  let generation;
  try {
    generation = await inTransaction(migration, async client => {
      await client.query(`SET LOCAL ROLE "${workspace.names.customOwner}"`);
      const tx = { client, schema: workspace.names.schema };
      const created = await createGeneration(tx, { definition, revision });
      await activateGeneration(tx, { generationId: created.id, expectedActiveGenerationId: null });
      await client.query(
        `UPDATE "${workspace.names.schema}".tf_table_catalog SET applied_revision=$2,target_revision=$2,applied_definition=$3,physical_table=$4 WHERE id=$1`,
        [definition.id, revision, definition, created.physical_table],
      );
      return created;
    });
  } finally {
    await migration.end();
  }
  const service = createTableService(runtime, hooks, commonCompatibility);
  const created = [];
  for (const { id = randomUUID(), values } of records) {
    created.push(
      await service.mutate(workspace.id, workspace.userId, {
        kind: 'create',
        tableId: definition.id,
        revision,
        recordId: id,
        values,
      }),
    );
  }
  return { generation, revision, definition, tableId: definition.id, records: created };
}
