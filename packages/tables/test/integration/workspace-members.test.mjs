import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  fixture,
  connect,
  denied,
  loadPlatformBaseline,
} from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction, provisionWorkspace } from '@tulipfarm/workspace-storage/provisioning';
import { AccessDenied } from '@tulipfarm/access';
import { createTableService } from '@tulipfarm/tables/service';
import { activateGeneration, activeGeneration, createGeneration, workspaceMembersTable } from '@tulipfarm/tables/store';
import {
  manualWorkspaceMemberValues,
  workspaceMemberFields,
  workspaceMembersDefinition,
} from '@tulipfarm/tables/workspace-members';

test(
  'member table bootstraps once, protects core schema, and preserves access membership identities',
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
    const raw = await connect(db.login(workspace));
    cleanup.push(() => raw.end());
    const tx = { schema: workspace.names.schema, client: raw };
    const s = `"${tx.schema}"`;
    const registration = await workspaceMembersTable(tx);
    const generation = await activeGeneration(tx, registration.coreDefinition.id);
    assert.deepEqual(
      registration.coreDefinition,
      workspaceMembersDefinition(generation.table_id, generation.definition.owningTeamId),
    );
    assert.deepEqual(generation.definition, registration.coreDefinition);
    const before = (
      await raw.query(`SELECT member_id,user_id,membership_id,profile_status FROM ${s}.tf_workspace_member_accounts`)
    ).rows;
    assert.equal(before.length, 1);
    assert.equal(before[0].user_id, workspace.userId);
    assert.equal(before[0].membership_id, workspace.membershipId);
    assert.notEqual(before[0].member_id, workspace.membershipId);
    assert.equal(before[0].profile_status, 'pending');
    await provisionWorkspace({
      connectionString: db.connectionString,
      workspaceId: workspace.id,
      passwords: workspace.passwords,
      initialAdmin: { userId: workspace.userId, membershipId: workspace.membershipId },
    });
    assert.deepEqual(await workspaceMembersTable(tx), registration);
    assert.deepEqual(
      (await raw.query(`SELECT member_id,user_id,membership_id,profile_status FROM ${s}.tf_workspace_member_accounts`))
        .rows,
      before,
    );
    await denied(raw, `UPDATE ${s}.tf_system_tables SET kind='workspace-members'`);
    await assert.rejects(
      raw.query(`UPDATE ${s}.tf_table_catalog SET display_name='Staff' WHERE id=$1`, [generation.table_id]),
      /member-table-protected/,
    );
    await denied(raw, `UPDATE ${s}.tf_table_catalog SET archived_at=clock_timestamp() WHERE id=$1`, [
      generation.table_id,
    ]);
    await assert.rejects(
      db.platform.query(`UPDATE ${s}.tf_table_catalog SET archived_at=clock_timestamp() WHERE id=$1`, [
        generation.table_id,
      ]),
      /member-table-protected/,
    );
    const maintenance = await connect(db.login(workspace, 'migration'));
    cleanup.push(() => maintenance.end());
    await assert.rejects(
      inTransaction(maintenance, async client => {
        await client.query(`SET LOCAL ROLE "${workspace.names.customOwner}"`);
        const next = { ...generation.definition, fields: generation.definition.fields.slice(1) };
        await createGeneration({ ...tx, client }, { definition: next, revision: 'a'.repeat(40) });
      }),
      /member-field-protected/,
    );
    await assert.rejects(
      db.platform.query(
        `UPDATE ${s}.tf_table_generations SET definition=jsonb_set(definition,'{label}','"Staff"') WHERE id=$1`,
        [generation.id],
      ),
      error => error.code === '23514' && error.message === 'table-title-immutable',
    );
  },
);

test(
  'ordinary human readers see non-login members, editors keep inactive links, and additions fail',
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
    cleanup.push(() => runtime.close());
    const raw = await connect(db.login(workspace));
    const maintenance = await connect(db.login(workspace, 'migration'));
    cleanup.push(
      () => raw.end(),
      () => maintenance.end(),
    );
    const tx = { schema: workspace.names.schema, client: raw };
    const s = `"${tx.schema}"`;
    const registration = await workspaceMembersTable(tx);
    const directory = await activeGeneration(tx, registration.coreDefinition.id);
    const service = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
    const employeeId = randomUUID();
    const employee = await service.mutate(workspace.id, workspace.userId, {
      kind: 'create',
      tableId: directory.table_id,
      revision: directory.revision,
      recordId: employeeId,
      values: manualWorkspaceMemberValues({
        name: 'Employee without an account',
        contactEmail: 'employee@example.test',
      }),
    });
    const readerId = randomUUID(),
      readerAccessId = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      readerAccessId,
      readerId,
    ]);
    const read = userId =>
      service.read(workspace.id, userId, {
        tableId: directory.table_id,
        revision: directory.revision,
        recordId: employeeId,
      });
    assert.equal((await read(readerId)).values[workspaceMemberFields.name].value, 'Employee without an account');
    await assert.rejects(read(employeeId), AccessDenied);
    await assert.rejects(
      service.mutate(workspace.id, readerId, {
        kind: 'update',
        tableId: directory.table_id,
        revision: directory.revision,
        recordId: employeeId,
        expectedToken: employee.token,
        values: { [workspaceMemberFields.name]: { kind: 'text', value: 'Not allowed' } },
      }),
      AccessDenied,
    );
    const titleId = randomUUID(),
      assigneeId = randomUUID(),
      reviewerId = randomUUID();
    const relation = id => ({
      id,
      kind: 'relationship',
      label: id === assigneeId ? 'Assignee' : 'Reviewer',
      required: false,
      targetTableId: directory.table_id,
      cardinality: 'many',
      inverseCardinality: 'many',
      reverse: null,
      onDelete: 'restrict',
    });
    const tickets = {
      formatVersion: 2,
      id: randomUUID(),
      owningTeamId: directory.definition.owningTeamId,
      label: 'Tickets',
      fields: [
        { id: titleId, kind: 'text', label: 'Title', required: false, maxLength: 200 },
        relation(assigneeId),
        relation(reviewerId),
      ],
      uniqueKeys: [],
    };
    const revision = 'b'.repeat(40);
    await inTransaction(maintenance, async client => {
      await client.query(`SET LOCAL ROLE "${workspace.names.customOwner}"`);
      const generation = await createGeneration({ ...tx, client }, { definition: tickets, revision });
      await activateGeneration({ ...tx, client }, { generationId: generation.id, expectedActiveGenerationId: null });
    });
    const link = { kind: 'relationship', tableId: directory.table_id, recordIds: [employeeId] };
    const ticket = await service.mutate(workspace.id, workspace.userId, {
      kind: 'create',
      tableId: tickets.id,
      revision,
      recordId: randomUUID(),
      values: { [assigneeId]: link },
    });
    await service.mutate(workspace.id, workspace.userId, {
      kind: 'update',
      tableId: directory.table_id,
      revision: directory.revision,
      recordId: employeeId,
      expectedToken: employee.token,
      values: { [workspaceMemberFields.active]: { kind: 'boolean', value: false } },
    });
    const edited = await service.mutate(workspace.id, workspace.userId, {
      kind: 'update',
      tableId: tickets.id,
      revision,
      recordId: ticket.id,
      expectedToken: ticket.token,
      values: { [titleId]: { kind: 'text', value: 'Keep the old assignment' } },
    });
    assert.deepEqual(edited.values[assigneeId], link);
    await assert.rejects(
      service.mutate(workspace.id, workspace.userId, {
        kind: 'update',
        tableId: tickets.id,
        revision,
        recordId: ticket.id,
        expectedToken: edited.token,
        values: { [reviewerId]: link },
      }),
      /member-inactive/,
    );
    await assert.rejects(
      service.mutate(workspace.id, workspace.userId, {
        kind: 'create',
        tableId: tickets.id,
        revision,
        recordId: randomUUID(),
        values: { [assigneeId]: link },
      }),
      /member-inactive/,
    );
    const history = (await raw.query(`SELECT id FROM ${s}.tf_table_row_history WHERE token=$1`, [ticket.token])).rows[0]
      .id;
    const retained = await service.mutate(workspace.id, workspace.userId, {
      kind: 'restore',
      tableId: tickets.id,
      revision,
      recordId: ticket.id,
      expectedToken: edited.token,
      historyId: history,
    });
    assert.deepEqual(retained.values[assigneeId], link);
    const unassigned = await service.mutate(workspace.id, workspace.userId, {
      kind: 'update',
      tableId: tickets.id,
      revision,
      recordId: ticket.id,
      expectedToken: retained.token,
      values: { [assigneeId]: null },
    });
    await assert.rejects(
      service.mutate(workspace.id, workspace.userId, {
        kind: 'restore',
        tableId: tickets.id,
        revision,
        recordId: ticket.id,
        expectedToken: unassigned.token,
        historyId: history,
      }),
      /member-inactive/,
      'Restoring an old assignment introduces a new link after it has been removed',
    );
    await assert.rejects(
      service.listPage(workspace.id, readerId, { tableId: tickets.id, revision, query: {} }),
      AccessDenied,
    );
  },
);
