import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { fixture } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createTableService } from '@tulipfarm/tables/service';
import { activeGeneration } from '@tulipfarm/tables/store';
import { runStateOptions, taskFields } from '@tulipfarm/tables/tasks-table';

test('Tasks rows keep Run state, Reporter, Parent and assignment rules', { timeout: 45000 }, async t => {
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
  const query = async (sql, params) => (await db.platform.query(sql, params)).rows;
  const tables = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
  const [{ id: tableId }] = await query(
    `SELECT core_definition->>'id' AS id FROM ${s}.tf_system_tables WHERE kind='tasks'`,
  );
  const generation = await runtime.transaction(workspace.id, commonCompatibility, tx => activeGeneration(tx, tableId));
  const base = { tableId, revision: generation.revision };
  const owner = { kind: 'actor', actor: { type: 'member', id: workspace.membershipId } };
  const teammate = randomUUID();
  await query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [teammate, randomUUID()]);
  const title = text => ({ [taskFields.title]: { kind: 'text', value: text } });
  const create = values =>
    tables.mutate(workspace.id, workspace.userId, { ...base, kind: 'create', recordId: randomUUID(), values });
  const update = (record, values) =>
    tables.mutate(workspace.id, workspace.userId, {
      ...base,
      kind: 'update',
      recordId: record.id,
      expectedToken: record.token,
      values,
    });

  const task = await create(title('Call the logistics partner'));
  assert.deepEqual(task.values[taskFields.reporter], owner, 'Reporter defaults to the person who created the row');
  await assert.rejects(
    update(task, { [taskFields.runState]: { kind: 'single-select', optionId: runStateOptions.done } }),
    /run-state-protected/,
  );
  await assert.rejects(
    update(task, { [taskFields.assignee]: { kind: 'actor', actor: { type: 'agent', id: randomUUID() } } }),
    'An unknown agent cannot be assigned',
  );

  const assigned = await update(task, {
    [taskFields.assignee]: { kind: 'actor', actor: { type: 'member', id: teammate } },
  });
  assert.equal(assigned.values[taskFields.runState] ?? null, null, 'A person assignee has no Run state');
  assert.deepEqual(
    await query(`SELECT kind FROM ${s}.tf_inbox_items WHERE membership_id=$1 AND row_id=$2 AND resolved_at IS NULL`, [
      teammate,
      task.id,
    ]),
    [{ kind: 'assigned' }],
  );
  assert.deepEqual(
    (await query(`SELECT event FROM ${s}.tf_row_thread_items WHERE row_id=$1 AND kind='event'`, [task.id])).map(
      row => row.event.type,
    ),
    ['assigned'],
  );
  const selfAssigned = await update(assigned, { [taskFields.assignee]: owner });
  assert.deepEqual(
    await query(`SELECT membership_id FROM ${s}.tf_inbox_items WHERE row_id=$1 AND resolved_at IS NULL`, [task.id]),
    [],
    'Reassigning resolves the old Inbox item and assigning yourself adds none',
  );

  const parent = { kind: 'relationship', tableId, recordIds: [selfAssigned.id] };
  const child = await create({ ...title('Confirm pickup time'), [taskFields.parent]: parent });
  await assert.rejects(
    update(selfAssigned, { [taskFields.parent]: { kind: 'relationship', tableId, recordIds: [child.id] } }),
    /parent-cycle/,
  );
  await tables.mutate(workspace.id, workspace.userId, {
    ...base,
    kind: 'delete',
    recordId: selfAssigned.id,
    expectedToken: selfAssigned.token,
  });
  const orphan = await tables.read(workspace.id, workspace.userId, { ...base, recordId: child.id });
  assert.equal(orphan.values[taskFields.parent] ?? null, null, 'Deleting a task clears Parent task on its subtasks');
});
