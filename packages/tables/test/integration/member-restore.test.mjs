import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { fixture, connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import { createTableService } from '@tulipfarm/tables/service';
import {
  activeGeneration,
  activateGeneration,
  createGeneration,
  projectWorkspaceMemberProfile,
  refreshWorkspaceMemberAccess,
  workspaceMembersTable,
} from '@tulipfarm/tables/store';
import {
  manualWorkspaceMemberValues,
  workspaceMemberAccess,
  workspaceMemberFields as fields,
} from '@tulipfarm/tables/workspace-members';

test(
  'member history restores editable values without rolling back account profiles or workspace access',
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
    const tables = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
    const custom = randomUUID(),
      userId = randomUUID(),
      membershipId = randomUUID();
    const migration = await connect(db.login(workspace, 'migration'));
    let generation;
    try {
      generation = await inTransaction(migration, async client => {
        await client.query(`SET LOCAL ROLE "${workspace.names.customOwner}"`);
        const tx = { client, schema: workspace.names.schema };
        const prior = await activeGeneration(tx, (await workspaceMembersTable(tx)).coreDefinition.id);
        const definition = {
          ...prior.definition,
          fields: [
            ...prior.definition.fields,
            { id: custom, label: 'Workday ID', kind: 'text', required: false, maxLength: 80 },
          ],
        };
        const next = await createGeneration(tx, { definition, revision: 'e'.repeat(40) });
        const active = await activateGeneration(tx, { generationId: next.id, expectedActiveGenerationId: prior.id });
        await client.query(`REVOKE ALL ON ${s}."${prior.physical_table}" FROM "${workspace.names.runtime}"`);
        await client.query(
          `UPDATE ${s}.tf_table_catalog SET physical_table=$2,target_revision=$3,applied_revision=$3,applied_definition=$4 WHERE id=$1`,
          [active.table_id, active.physical_table, active.revision, active.definition],
        );
        return active;
      });
    } finally {
      await migration.end();
    }
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      membershipId,
      userId,
    ]);
    const memberId = (
      await db.platform.query(`SELECT member_id FROM ${s}.tf_workspace_member_accounts WHERE user_id=$1`, [userId])
    ).rows[0].member_id;
    const base = { tableId: generation.table_id, revision: generation.revision, recordId: memberId };
    const profile = revision =>
      runtime.transaction(workspace.id, commonCompatibility, tx =>
        projectWorkspaceMemberProfile(tx, {
          memberId,
          membershipId,
          profile: {
            id: userId,
            revision: String(revision),
            name: `Profile ${revision}`,
            email: `profile-${revision}@example.test`,
            image: `https://images.example.test/profile-${revision}.png`,
          },
        }),
      );
    const read = () => tables.read(workspace.id, workspace.userId, base);
    const write = (record, values) =>
      tables.mutate(workspace.id, workspace.userId, { ...base, kind: 'update', expectedToken: record.token, values });
    const historyId = async record =>
      (
        await db.platform.query(
          `SELECT id FROM ${s}.tf_table_row_history_data WHERE table_id=$1 AND row_id=$2 AND token=$3`,
          [base.tableId, memberId, record.token],
        )
      ).rows[0].id;
    const restore = (record, id, principal = workspace.userId, version = 'after') =>
      tables.mutate(workspace.id, principal, {
        ...base,
        kind: 'restore',
        expectedToken: record.token,
        historyId: id,
        version,
      });

    await profile(1);
    const old = await write(await read(), { [custom]: { kind: 'text', value: 'OLD-ID' } });
    const oldHistory = await historyId(old);
    await profile(2);
    const current = await write(await read(), { [custom]: { kind: 'text', value: 'NEW-ID' } });
    await assert.rejects(restore(old, oldHistory), /stale-record/);
    await assert.rejects(
      restore(current, oldHistory, userId),
      AccessDenied,
      'A member has no implicit right to restore their own business data',
    );
    const linked = await restore(current, oldHistory);
    assert.deepEqual(linked.values[custom], old.values[custom]);
    for (const field of ['name', 'photo', 'accountEmail', 'access'])
      assert.deepEqual(linked.values[fields[field]], current.values[fields[field]]);
    const audit = (
      await db.platform.query(`SELECT operation,field_ids FROM ${s}.tf_table_row_history_data WHERE token=$1`, [
        linked.token,
      ])
    ).rows[0];
    assert.equal(audit.operation, 'restore');
    assert.deepEqual(audit.field_ids, [custom]);

    await db.platform.query(`UPDATE ${s}.tf_memberships SET removed_at=clock_timestamp() WHERE id=$1`, [membershipId]);
    await runtime.transaction(workspace.id, commonCompatibility, tx => refreshWorkspaceMemberAccess(tx, memberId));
    const detached = await read();
    assert.equal(detached.values[fields.accountEmail], null);
    assert.deepEqual(detached.values[fields.access], { kind: 'single-select', optionId: workspaceMemberAccess.none });
    await assert.rejects(
      write(detached, { [fields.photo]: old.values[fields.photo] }),
      /member-field-protected/,
      'A generic cell write must not inherit the historical-photo exception',
    );
    const manual = await restore(detached, oldHistory);
    assert.deepEqual(manual.values[fields.name], old.values[fields.name]);
    assert.deepEqual(manual.values[fields.photo], old.values[fields.photo]);
    assert.equal(manual.values[fields.accountEmail], null);
    assert.deepEqual(manual.values[fields.access], detached.values[fields.access]);
    assert.equal(
      (
        await db.platform.query(
          `SELECT count(*)::int AS count FROM ${s}.tf_workspace_member_images WHERE member_id=$1`,
          [memberId],
        )
      ).rows[0].count,
      2,
    );
    const removed = await tables.mutate(workspace.id, workspace.userId, {
      ...base,
      kind: 'delete',
      expectedToken: manual.token,
    });
    const recreated = await restore(removed, oldHistory);
    assert.equal(recreated.id, memberId);
    assert.deepEqual(recreated.values[fields.photo], old.values[fields.photo]);
    assert.equal(recreated.values[fields.accountEmail], null);
    assert.deepEqual(recreated.values[fields.access], { kind: 'single-select', optionId: workspaceMemberAccess.none });
    assert.equal(
      (
        await db.platform.query(`SELECT removed_at IS NOT NULL AS removed FROM ${s}.tf_memberships WHERE id=$1`, [
          membershipId,
        ])
      ).rows[0].removed,
      true,
    );
    const beforeRestore = await restore(recreated, await historyId(current), workspace.userId, 'before');
    assert.deepEqual(beforeRestore.values[fields.photo], current.values[fields.photo]);
    assert.deepEqual(beforeRestore.values[custom], old.values[custom]);
    assert.equal(beforeRestore.values[fields.accountEmail], null);

    const other = await tables.mutate(workspace.id, workspace.userId, {
      ...base,
      recordId: randomUUID(),
      kind: 'create',
      values: manualWorkspaceMemberValues({ name: 'Other member' }),
    });
    await assert.rejects(
      tables.mutate(workspace.id, workspace.userId, {
        ...base,
        recordId: other.id,
        kind: 'restore',
        expectedToken: other.token,
        historyId: oldHistory,
      }),
      /recovery-expired/,
      "A valid target token cannot restore another member's history",
    );
    await assert.rejects(restore(beforeRestore, randomUUID()), /recovery-expired/);
    await db.platform.query(
      `UPDATE ${s}.tf_table_row_history_data SET recoverable_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
      [oldHistory],
    );
    await assert.rejects(restore(beforeRestore, oldHistory), /recovery-expired/);
    assert.equal((await read()).token, beforeRestore.token);
  },
);
