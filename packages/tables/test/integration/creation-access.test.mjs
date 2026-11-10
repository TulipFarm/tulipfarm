import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  fixture,
  connect,
  loadPlatformBaseline,
  seedPlatformUser,
} from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { applyCommonMigrations, inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { AccessDenied, canAccessTable } from '@tulipfarm/access';
import { createTableProposals, createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { createTableExecution, createTablePublication } from '@tulipfarm/tables/execution';
import { generationProposalData } from '@tulipfarm/tables/store';
import { createTableService } from '@tulipfarm/tables/service';
import { createGovernanceService } from '../../../workspaces/dist/governance.js';
import { createTableWithRows, tableDefinition, textField } from '../fixture.mjs';

test('new tables get revocable editor policies for their creator and owning team only', { timeout: 60000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const workspace = await db.create(db.baseline.slice(0, -1)),
    s = `"${workspace.names.schema}"`,
    team = randomUUID();
  runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({
      workspaceId: workspace.id,
      generation: 1,
      connectionString: db.login(workspace),
    }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Operations')`, [team]);
  const member = async (name, inTeam) => {
    const userId = await seedPlatformUser(db.platform, { name }),
      membershipId = randomUUID();
    await db.platform.query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
      membershipId,
      userId,
    ]);
    if (inTeam)
      await db.platform.query(`INSERT INTO ${s}.tf_member_teams(membership_id,team_id) VALUES($1,$2)`, [
        membershipId,
        team,
      ]);
    return { kind: 'human', userId, membershipId };
  };
  const creator = await member('Table creator', true),
    teammate = await member('Team member', true),
    outsider = await member('Other member', false);
  await db.platform.query(
    `INSERT INTO ${s}.tf_table_person_grants(membership_id,asset_id,permission) VALUES($1,$2,'table.create')`,
    [creator.membershipId, team],
  );
  const existing = await createTableWithRows({
    db,
    workspace,
    runtime,
    definition: tableDefinition({ owningTeamId: team, label: 'Existing records' }),
  });
  const chat = randomUUID(),
    message = randomUUID(),
    turn = randomUUID();
  await db.platform.query(`INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`, [
    chat,
    creator.userId,
    creator.membershipId,
  ]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
    [message, chat, creator.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
    [turn, chat, message],
  );
  await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1`, ['a'.repeat(40)]);
  const requireSources = async () => {},
    options = { runtime, requireSources, data: generationProposalData },
    proposals = createTableProposals(options),
    decisions = createTableProposalDecisions({
      ...options,
      resolveConfirmationCredential: async () => db.login(workspace, 'confirmation'),
    }),
    advance = createTableExecution({
      requireSources,
      resolveMigrationCredential: async () => db.login(workspace, 'migration'),
    });
  let revision = 0;
  const publish = createTablePublication({
    runtime,
    requireSources,
    prepareRevision: async input => ({
      commit: (++revision).toString(16).padStart(40, '0'),
      parentCommit: input.expectedParentCommit,
      bundle: { key: `test/${input.commandId}`, sha256: 'b'.repeat(64) },
      projection: { definition: input.definition },
    }),
  });
  const finish = async proposal => {
    for (let i = 0; i < 30; i++) {
      const state = await advance(workspace.id, proposal.id);
      assert.notEqual(state, 'blocked');
      if (state === 'publish') await publish(workspace.id, proposal.id);
      if (state === 'completed') return;
    }
    assert.fail('Creation did not complete');
  };
  const service = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
  const permissions = [
    'table.row.read',
    'table.row.create',
    'table.row.update',
    'table.row.delete',
    'table.schema.manage',
  ];
  const permitted = (actor, id, permission = 'table.row.read') =>
    runtime.transaction(workspace.id, commonCompatibility, tx => canAccessTable(tx, actor, id, permission));
  const definition = tableDefinition({ owningTeamId: team, label: 'New records' });
  const propose = (target, expectedRevision = null) =>
    proposals.propose(
      workspace.id,
      creator,
      randomUUID(),
      { conversationId: chat, turnId: turn, sources: [] },
      {
        plans: [
          {
            kind: 'schema',
            tableId: target.id,
            expectedRevision,
            dependsOn: [],
            target,
            transforms: { outputs: [] },
          },
        ],
      },
    );
  const approve = proposal =>
    decisions.decide(workspace.id, creator.userId, chat, proposal.id, {
      commandId: randomUUID(),
      decision: 'approve',
      digest: proposal.digest,
    });
  const legacyDefinition = tableDefinition({ owningTeamId: team, label: 'Earlier records' }),
    legacyProposal = await propose(legacyDefinition);
  await approve(legacyProposal);
  await finish(legacyProposal);
  assert.equal((await proposals.status(workspace.id, creator.userId, chat, legacyProposal.id)).status, 'completed');
  assert.equal(await permitted(creator, legacyDefinition.id), false);
  const proposal = await propose(definition);
  await approve(proposal);
  await inTransaction(db.platform, client => applyCommonMigrations(client, workspace.id, db.baseline));
  assert.deepEqual(
    (
      await db.platform.query(
        `SELECT table_id FROM ${s}.tf_table_creation_access_receipts WHERE table_id=ANY($1::uuid[]) ORDER BY table_id`,
        [[existing.tableId, legacyDefinition.id]],
      )
    ).rows.map(row => row.table_id),
    [existing.tableId, legacyDefinition.id].sort(),
  );
  await finish(legacyProposal);
  assert.equal((await proposals.status(workspace.id, creator.userId, chat, legacyProposal.id)).status, 'completed');
  assert.equal(await permitted(creator, legacyDefinition.id), false);
  assert.equal(await permitted(creator, definition.id), false);
  assert.equal(await advance(workspace.id, proposal.id), 'publish');
  const pendingJob = (
    await db.platform.query(`SELECT id FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [proposal.id])
  ).rows[0];
  const premature = await connect(db.login(workspace, 'migration'));
  try {
    await premature.query(`SET ROLE "${workspace.names.customOwner}"`);
    await assert.rejects(
      premature.query(`SELECT ${s}.tf_table_creation_access($1)`, [pendingJob.id]),
      error => error.code === '42501',
    );
  } finally {
    await premature.end();
  }
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
    (await service.read(workspace.id, creator, { tableId: definition.id, revision: activeRevision, recordId })).values[
      fieldId
    ].value,
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
        existing.tableId,
      ]),
      error => error.code === '42501',
    );
    const appliedRevision = adminView.revision;
    const edit = await propose({ ...definition, fields: [...definition.fields, textField('Notes')] }, appliedRevision);
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
    const legacyJob = (
      await db.platform.query(`SELECT id FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [legacyProposal.id])
    ).rows[0];
    for (const [executionId, tableId] of [
      [job.id, definition.id],
      [legacyJob.id, legacyDefinition.id],
    ]) {
      await activation.query('BEGIN');
      try {
        await activation.query(
          `UPDATE ${s}.tf_table_executions SET creation_access_granted_at=NULL,phase='reconciling' WHERE id=$1`,
          [executionId],
        );
        await activation.query(
          `UPDATE ${s}.tf_table_generations SET activated_at=activated_at
            WHERE id=(SELECT target_generation FROM ${s}.tf_table_executions WHERE id=$1)`,
          [executionId],
        );
        await activation.query(`UPDATE ${s}.tf_table_catalog SET physical_table=physical_table WHERE id=$1`, [tableId]);
        await assert.rejects(activation.query(call, [executionId]), error => error.code === '42501');
      } finally {
        await activation.query('ROLLBACK');
      }
      assert.equal(await permitted(creator, tableId), false);
      assert.equal(await permitted(teammate, tableId), false);
    }
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
    const editJob = (await db.platform.query(`SELECT id FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [edit.id]))
      .rows[0];
    await assert.rejects(activation.query(call, [editJob.id]), error => error.code === '42501');
    assert.equal(await permitted(teammate, definition.id), false, 'Edits must not recreate team policies');
    assert.equal(await permitted(creator, existing.tableId), false);
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
});
