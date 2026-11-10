import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import {
  fixture,
  connect,
  loadPlatformBaseline,
  seedPlatformUser,
} from '../../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { canAccessTable } from '@tulipfarm/access';
import { createTableProposals, createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { createTableExecution, createTablePublication } from '@tulipfarm/tables/execution';
import { generationProposalData } from '@tulipfarm/tables/store';
import { createTableService } from '@tulipfarm/tables/service';

export const permissions = [
  'table.row.read',
  'table.row.create',
  'table.row.update',
  'table.row.delete',
  'table.schema.manage',
];

const databases = new Map();
const runtimes = [];
after(async () => {
  for (const runtime of runtimes) await runtime.close();
  for (const database of databases.values()) await (await database).close();
});

export async function creationAccessFixture(version = commonCompatibility.maximum) {
  if (!databases.has(version)) databases.set(version, fixture());
  const db = await databases.get(version);
  await loadPlatformBaseline(db.platform);
  const workspace = await db.create(db.baseline.slice(0, version)),
    s = `"${workspace.names.schema}"`,
    team = randomUUID();
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
  runtimes.push(runtime);
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
  const control = (proposal, operation) =>
    decisions.control(workspace.id, creator.userId, chat, proposal.id, {
      commandId: randomUUID(),
      operation,
      digest: proposal.digest,
    });
  const permitted = (actor, id, permission = 'table.row.read') =>
    runtime.transaction(workspace.id, commonCompatibility, tx => canAccessTable(tx, actor, id, permission));
  const service = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
  return {
    db,
    workspace,
    s,
    team,
    runtime,
    creator,
    teammate,
    outsider,
    chat,
    proposals,
    decisions,
    advance,
    publish,
    finish,
    propose,
    approve,
    control,
    permitted,
    service,
  };
}

export async function assertCreationReplayDenied(context, proposalId, tableId) {
  const { db, workspace, s, creator, teammate, permitted } = context;
  const job = (await db.platform.query(`SELECT id FROM ${s}.tf_table_executions WHERE proposal_id=$1`, [proposalId]))
    .rows[0];
  const activation = await connect(db.login(workspace, 'migration'));
  try {
    await activation.query('BEGIN');
    await activation.query(`SET LOCAL ROLE "${workspace.names.customOwner}"`);
    await activation.query(
      `UPDATE ${s}.tf_table_executions SET creation_access_granted_at=NULL,phase='reconciling' WHERE id=$1`,
      [job.id],
    );
    await activation.query(
      `UPDATE ${s}.tf_table_generations SET activated_at=activated_at
       WHERE id=(SELECT target_generation FROM ${s}.tf_table_executions WHERE id=$1)`,
      [job.id],
    );
    await activation.query(`UPDATE ${s}.tf_table_catalog SET physical_table=physical_table WHERE id=$1`, [tableId]);
    await assert.rejects(
      activation.query(`SELECT ${s}.tf_table_creation_access($1)`, [job.id]),
      error => error.code === '42501',
    );
  } finally {
    await activation.query('ROLLBACK');
    await activation.end();
  }
  assert.equal(await permitted(creator, tableId), false);
  assert.equal(await permitted(teammate, tableId), false);
}

export async function seedDestination({ db, s }, id = randomUUID()) {
  const installation =
    (await db.platform.query(`SELECT id FROM ${s}.tf_slack_installations`)).rows[0]?.id ?? randomUUID();
  await db.platform.query(
    `INSERT INTO ${s}.tf_slack_installations(id,app_id,team_id,bot_user_id,generation,state,scopes,accepts_events_after)
     VALUES($1,'test-app','test-team','test-bot',1,'revoked','{}',0) ON CONFLICT(id) DO NOTHING`,
    [installation],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_slack_destinations(id,installation_id,generation,channel,name)
     VALUES($1,$2,1,$3,'Fixture channel')`,
    [id, installation, `C${id.replaceAll('-', '').toUpperCase()}`],
  );
  return id;
}
