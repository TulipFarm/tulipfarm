import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { fixture, connect, loadPlatformBaseline } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createTableService } from '@tulipfarm/tables/service';
import { activeGeneration, projectWorkspaceMemberProfile, workspaceMembersTable } from '@tulipfarm/tables/store';
import { workspaceMemberFields, WorkspaceMemberError } from '@tulipfarm/tables/workspace-members';
import { TableQueryError } from '@tulipfarm/tables/query';
import { createTableWithRows, tableDefinition, textField } from '../fixture.mjs';
import { createAgentRecordTools } from '../../../agents/dist/record-tools.js';

test(
  'is me binds each human and access incarnation without changing shared queries or source permissions',
  { timeout: 45000 },
  async t => {
    const db = await fixture();
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
      await db.close();
    });
    await loadPlatformBaseline(db.platform);
    const workspace = await db.create();
    const otherWorkspace = await db.create(db.baseline, { userId: workspace.userId });
    const raw = await connect(db.login(workspace));
    cleanup.push(() => raw.end());
    const s = `"${workspace.names.schema}"`;
    const runtime = createWorkspaceRuntime({
      resolveCredential: async id => ({
        workspaceId: id,
        generation: 1,
        connectionString: db.login(id === workspace.id ? workspace : otherWorkspace),
      }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    cleanup.push(() => runtime.close());
    const tables = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
    const readerId = randomUUID(),
      readerAccessId = randomUUID();
    await raw.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      readerAccessId,
      readerId,
    ]);
    const members = new Map();
    for (const [userId, membershipId] of [
      [workspace.userId, workspace.membershipId],
      [readerId, readerAccessId],
    ]) {
      const memberId = (
        await raw.query(`SELECT member_id FROM ${s}.tf_workspace_member_accounts WHERE user_id=$1`, [userId])
      ).rows[0].member_id;
      members.set(userId, memberId);
      await runtime.transaction(workspace.id, commonCompatibility, tx =>
        projectWorkspaceMemberProfile(tx, {
          memberId,
          membershipId,
          profile: { id: userId, revision: '1', name: 'Same name', email: `${userId}@example.test`, image: null },
        }),
      );
    }
    const directory = await activeGeneration(
      { client: raw, schema: workspace.names.schema },
      (await workspaceMembersTable({ client: raw, schema: workspace.names.schema })).coreDefinition.id,
    );
    const title = textField('Title'),
      assigneeId = randomUUID(),
      reviewersId = randomUUID(),
      unrelatedId = randomUUID();
    const ticketsId = randomUUID();
    const relation = (id, label, cardinality, targetTableId = directory.table_id) => ({
      id,
      label,
      kind: 'relationship',
      required: false,
      targetTableId,
      cardinality,
      inverseCardinality: 'many',
      reverse: null,
      onDelete: 'restrict',
    });
    const tickets = tableDefinition({
      id: ticketsId,
      owningTeamId: directory.definition.owningTeamId,
      label: 'Tickets',
      fields: [
        title,
        relation(assigneeId, 'Assignee', 'one'),
        relation(reviewersId, 'Reviewers', 'many'),
        relation(unrelatedId, 'Related ticket', 'one', ticketsId),
      ],
    });
    const link = userIds => ({
      kind: 'relationship',
      tableId: directory.table_id,
      recordIds: userIds.map(id => members.get(id)),
    });
    const a = randomUUID(),
      b = randomUUID(),
      c = randomUUID();
    const created = await createTableWithRows({
      db,
      workspace,
      runtime,
      definition: tickets,
      records: [
        {
          id: a,
          values: {
            [title.id]: { kind: 'text', value: 'A' },
            [assigneeId]: link([workspace.userId]),
            [reviewersId]: link([readerId]),
          },
        },
        {
          id: b,
          values: {
            [title.id]: { kind: 'text', value: 'B' },
            [assigneeId]: link([workspace.userId]),
            [reviewersId]: link([workspace.userId, readerId]),
          },
        },
        {
          id: c,
          values: {
            [title.id]: { kind: 'text', value: 'C' },
            [assigneeId]: link([readerId]),
            [reviewersId]: link([workspace.userId]),
          },
        },
      ],
    });
    const recordTools = createAgentRecordTools(runtime);
    const listed = (await tables.definitions(workspace.id, workspace.userId)).tables;
    assert.equal(listed.find(table => table.id === directory.table_id).systemKind, 'workspace-members');
    assert.equal(listed.find(table => table.id === ticketsId).systemKind, undefined);
    const actor = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
    assert.equal((await recordTools.status(workspace.id, actor, directory.table_id)).systemKind, 'workspace-members');
    const inspected = await recordTools.inspect(workspace.id, actor, ticketsId);
    assert.ok(inspected.query.fields.find(field => field.fieldId === assigneeId).ops.includes('is-me'));
    assert.ok(!inspected.query.fields.find(field => field.fieldId === unrelatedId).ops.includes('is-me'));
    await assert.rejects(
      recordTools.preview(
        workspace.id,
        actor,
        directory.table_id,
        directory.revision,
        members.get(workspace.userId),
        'update',
        {
          [workspaceMemberFields.name]: { kind: 'text', value: 'Overwritten account name' },
        },
      ),
      /member-field-protected/,
    );
    await raw.query(
      `INSERT INTO ${s}.tf_table_person_grants(membership_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
      [readerAccessId, ticketsId],
    );
    const where = { kind: 'rule', fieldId: assigneeId, op: 'is-me', values: [] };
    const request = { query: { version: 2, mode: 'rows', where } };
    const run = (userId, input = request, workspaceId = workspace.id) =>
      tables.query(workspaceId, userId, { tableId: ticketsId, revision: created.revision, request: input });
    const adminRows = await run(workspace.userId),
      readerRows = await run(readerId);
    assert.deepEqual(adminRows.records.map(row => row.id).sort(), [a, b].sort());
    assert.equal(adminRows.total, '2');
    assert.deepEqual(
      readerRows.records.map(row => row.id),
      [c],
    );
    assert.equal(readerRows.total, '1');
    assert.deepEqual(adminRows.query.where, where);
    assert.deepEqual(readerRows.query.where, where);
    assert.equal(adminRows.rsql, 'assignee=isme=true');
    assert.deepEqual(
      (await tables.validateQuery(workspace.id, readerId, { tableId: ticketsId, revision: created.revision, request }))
        .query.where,
      where,
    );
    const multiple = await run(readerId, { rsql: 'reviewers=isme=true', options: { version: 2, mode: 'rows' } });
    assert.deepEqual(multiple.records.map(row => row.id).sort(), [a, b].sort());
    assert.deepEqual(
      (await run(readerId, { query: { version: 2, mode: 'summary', where, metrics: [{ fn: 'count' }] } })).groups,
      [{ keys: [], values: ['1'] }],
    );
    await assert.rejects(
      run(readerId, { query: { ...request.query, where: { ...where, values: [members.get(workspace.userId)] } } }),
      TableQueryError,
    );
    await assert.rejects(
      run(readerId, { query: { ...request.query, where: { ...where, fieldId: unrelatedId } } }),
      TableQueryError,
    );
    await assert.rejects(run(members.get(readerId)), AccessDenied);
    await assert.rejects(run(workspace.userId, request, otherWorkspace.id), /not-active/);
    const first = await run(workspace.userId, { query: { ...request.query, limit: 1 } });
    assert.ok(first.nextCursor);
    await assert.rejects(
      run(readerId, { query: { ...request.query, limit: 1, after: first.nextCursor } }),
      /Cursor does not match/,
    );
    const reader = await tables.read(workspace.id, workspace.userId, {
      tableId: directory.table_id,
      revision: directory.revision,
      recordId: members.get(readerId),
    });
    await tables.mutate(workspace.id, workspace.userId, {
      kind: 'update',
      tableId: directory.table_id,
      revision: directory.revision,
      recordId: reader.id,
      expectedToken: reader.token,
      values: { [workspaceMemberFields.active]: { kind: 'boolean', value: false } },
    });
    assert.deepEqual(
      (await run(readerId)).records.map(row => row.id),
      [c],
    );
    await assert.rejects(
      recordTools.preview(workspace.id, actor, ticketsId, created.revision, a, 'update', {
        [assigneeId]: link([readerId]),
      }),
      /member-inactive/,
    );
    await recordTools.preview(workspace.id, actor, ticketsId, created.revision, c, 'update', {
      [title.id]: { kind: 'text', value: 'Retained inactive member' },
    });
    const choices = await tables.references(workspace.id, workspace.userId, {
      tableId: ticketsId,
      fieldId: assigneeId,
      ids: [members.get(readerId)],
    });
    assert.equal(choices.choices[0].label, 'Same name (inactive)');
    const missingUser = randomUUID(),
      missingAccess = randomUUID();
    await raw.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      missingAccess,
      missingUser,
    ]);
    await assert.rejects(run(missingUser), AccessDenied);
    await raw.query(
      `INSERT INTO ${s}.tf_table_person_grants(membership_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
      [missingAccess, ticketsId],
    );
    await assert.rejects(
      run(missingUser),
      error => error instanceof WorkspaceMemberError && error.code === 'member-profile-pending',
    );
    await raw.query(`UPDATE ${s}.tf_memberships SET removed_at=clock_timestamp() WHERE id=$1`, [
      workspace.membershipId,
    ]);
    const nextAccess = randomUUID();
    await raw.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'admin')`, [
      nextAccess,
      workspace.userId,
    ]);
    assert.equal(
      (await raw.query(`SELECT member_id FROM ${s}.tf_workspace_member_accounts WHERE user_id=$1`, [workspace.userId]))
        .rows[0].member_id,
      members.get(workspace.userId),
    );
    await assert.rejects(
      run(workspace.userId, { query: { ...request.query, limit: 1, after: first.nextCursor } }),
      /Cursor does not match/,
    );
    assert.deepEqual((await run(workspace.userId)).records.map(row => row.id).sort(), [a, b].sort());
    await raw.query(`DELETE FROM ${s}.tf_table_person_grants WHERE membership_id=$1`, [readerAccessId]);
    await assert.rejects(run(readerId), AccessDenied);
  },
);
