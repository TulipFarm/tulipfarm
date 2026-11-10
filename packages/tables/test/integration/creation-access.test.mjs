import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { before } from 'node:test';
import { connect } from '../../../workspace-storage/test/integration/fixture.mjs';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { createGovernanceService } from '../../../workspaces/dist/governance.js';
import { createTableWithRows, tableDefinition, textField } from '../fixture.mjs';
import { creationAccessFixture, permissions, assertCreationReplayDenied } from './creation-access-fixture.mjs';

let fixture;
before(async () => {
  fixture = await creationAccessFixture();
});

test(
  'new tables get revocable editor policies for their creator and owning team only',
  { timeout: 60000 },
  async () => {
    const { db, workspace, team, runtime, creator, teammate, outsider, propose, approve, finish, permitted, service } =
      fixture;
    const existing = await createTableWithRows({
      db,
      workspace,
      runtime,
      definition: tableDefinition({ owningTeamId: team, label: 'Existing records' }),
    });
    const definition = tableDefinition({ owningTeamId: team, label: 'New records' });
    const proposal = await propose(definition);
    await approve(proposal);
    await finish(proposal);
    for (const actor of [creator, teammate]) {
      for (const permission of permissions) assert.equal(await permitted(actor, definition.id, permission), true);
      assert.ok((await service.definitions(workspace.id, actor)).tables.some(table => table.id === definition.id));
      assert.equal(await permitted(actor, existing.tableId), false);
      assert.equal(await permitted(actor, definition.id, 'table.create'), false);
    }
    assert.equal(await permitted(outsider, definition.id), false);
    assert.ok(!(await service.definitions(workspace.id, outsider)).tables.some(table => table.id === definition.id));
    const recordId = randomUUID(),
      fieldId = definition.fields[0].id;
    const row = await service.mutate(workspace.id, creator, {
      kind: 'create',
      tableId: definition.id,
      revision: (await service.definitions(workspace.id, creator)).tables.find(table => table.id === definition.id)
        .revision,
      recordId,
      values: { [fieldId]: { kind: 'text', value: 'Shared record' } },
    });
    const activeRevision = (await service.definitions(workspace.id, teammate)).tables.find(
      table => table.id === definition.id,
    ).revision;
    await service.mutate(workspace.id, teammate, {
      kind: 'update',
      tableId: definition.id,
      revision: activeRevision,
      recordId,
      expectedToken: row.token,
      values: { [fieldId]: { kind: 'text', value: 'Team update' } },
    });
    assert.equal(
      (await service.read(workspace.id, creator, { tableId: definition.id, revision: activeRevision, recordId }))
        .values[fieldId].value,
      'Team update',
    );
    await assert.rejects(
      service.read(workspace.id, outsider, { tableId: definition.id, revision: activeRevision, recordId }),
      AccessDenied,
    );
    await assert.rejects(
      service.read(workspace.id, creator, { tableId: existing.tableId, revision: existing.revision, recordId }),
      AccessDenied,
    );
    const adminView = (await service.definitions(workspace.id, workspace.userId)).tables.find(
      table => table.id === definition.id,
    );
    assert.equal(adminView.definition.owningTeamId, team);
    const governance = createGovernanceService({ runtime, identity: db.platform, compatibility: commonCompatibility });
    const snapshot = await governance.snapshot(workspace.id, workspace.userId);
    assert.equal(snapshot.teams.find(item => item.id === team).name, 'Operations');
    assert.equal(snapshot.members.find(item => item.id === creator.membershipId).name, 'Table creator');
    assert.equal(snapshot.directory.find(item => item.id === creator.membershipId).name, 'Table creator');
    assert.equal(snapshot.tables.find(item => item.id === definition.id).name, definition.label);
    assert.deepEqual(
      snapshot.grants
        .filter(grant => grant.teamId === team && grant.target.id === definition.id)
        .map(grant => grant.target.permission)
        .sort(),
      [...permissions].sort(),
    );
    assert.deepEqual(
      snapshot.personGrants
        .filter(grant => grant.membershipId === creator.membershipId && grant.target.id === definition.id)
        .map(grant => grant.target.permission)
        .sort(),
      [...permissions].sort(),
    );
  },
);

test(
  'revoked creation policies stay revoked after tampering, edits, archive and restore',
  { timeout: 60000 },
  async () => {
    const {
      db,
      workspace,
      s,
      team,
      runtime,
      creator,
      teammate,
      propose,
      approve,
      finish,
      permitted,
      service,
      proposals,
      decisions,
    } = fixture;
    const definition = tableDefinition({ owningTeamId: team }),
      proposal = await propose(definition);
    await approve(proposal);
    await finish(proposal);
    const governance = createGovernanceService({ runtime, identity: db.platform, compatibility: commonCompatibility });
    const adminView = (await service.definitions(workspace.id, workspace.userId)).tables.find(
      table => table.id === definition.id,
    );
    const job = (await db.platform.query(`SELECT id FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [proposal.id]))
      .rows[0];
    const call = `SELECT ${s}.tf_table_creation_access($1)`;
    const runtimeClient = await connect(db.login(workspace));
    try {
      await assert.rejects(runtimeClient.query(call, [job.id]), error => error.code === '42501');
    } finally {
      await runtimeClient.end();
    }
    const activation = await connect(db.login(workspace, 'migration'));
    try {
      await activation.query(`SET ROLE "${workspace.names.customOwner}"`);
      for (const sql of [
        `INSERT INTO ${s}.tf_table_creation_access_receipts(table_id) VALUES($1)`,
        `UPDATE ${s}.tf_table_creation_access_receipts SET created_at=clock_timestamp() WHERE table_id=$1`,
        `DELETE FROM ${s}.tf_table_creation_access_receipts WHERE table_id=$1`,
      ])
        await assert.rejects(activation.query(sql, [definition.id]), error => error.code === '42501');
      await assert.rejects(
        activation.query(`TRUNCATE ${s}.tf_table_creation_access_receipts`),
        error => error.code === '42501',
      );
      await assert.rejects(activation.query(call, [randomUUID()]), error => error.code === '42501');
      await assert.rejects(
        activation.query(`INSERT INTO ${s}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`, [
          team,
          randomUUID(),
        ]),
        error => error.code === '42501',
      );
      const appliedRevision = adminView.revision;
      const edit = await propose(
        { ...definition, fields: [...definition.fields, textField('Notes')] },
        appliedRevision,
      );
      await approve(edit);
      for (const permission of permissions) {
        const target = { kind: 'table', id: definition.id, permission };
        await governance.setGrant(workspace.id, workspace.userId, { teamId: team, target, granted: false });
        await governance.setPersonGrant(workspace.id, workspace.userId, {
          membershipId: creator.membershipId,
          target,
          granted: false,
        });
      }
      await assertCreationReplayDenied(fixture, proposal.id, definition.id);
      await finish(proposal);
      assert.equal(await permitted(creator, definition.id), false, 'Retries must not restore revoked policies');
      assert.equal(await permitted(teammate, definition.id), false);
      // Let the approved edit complete after revoking the team policy.
      for (const permission of permissions)
        await governance.setPersonGrant(workspace.id, workspace.userId, {
          membershipId: creator.membershipId,
          target: { kind: 'table', id: definition.id, permission },
          granted: true,
        });
      await finish(edit);
      const editJob = (
        await db.platform.query(`SELECT id FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [edit.id])
      ).rows[0];
      await assert.rejects(activation.query(call, [editJob.id]), error => error.code === '42501');
      assert.equal(await permitted(teammate, definition.id), false, 'Edits must not recreate team policies');
      for (const kind of ['archive', 'restore']) {
        const requestId = randomUUID(),
          latest = (
            await db.platform.query(`SELECT applied_revision FROM ${s}.tf_table_catalog WHERE id=$1`, [definition.id])
          ).rows[0].applied_revision;
        const proposal = await proposals.propose(
          workspace.id,
          creator,
          requestId,
          { conversationId: null, turnId: null, sources: [] },
          { plans: [{ kind, tableId: definition.id, dependsOn: [], expectedRevision: latest }] },
        );
        await decisions.decide(workspace.id, creator.userId, null, requestId, {
          commandId: requestId,
          decision: 'approve',
          digest: proposal.digest,
        });
        await finish(proposal);
        assert.equal(await permitted(teammate, definition.id), false, `${kind} must not recreate team policies`);
      }
    } finally {
      await activation.end();
    }
  },
);
