import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, connect, denied, loadPlatformBaseline } from '../../workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { applyCommonMigrations, inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createTableProposalDecisions } from '@tulipfarm/tables/proposals';
import { createTableExecution, createTablePublication } from '@tulipfarm/tables/execution';
import { tableExecutionAccess } from '../../../apps/worker/src/table-access.ts';
import { createChatTools } from '../src/tools.ts';
import { createChatTableProposals, tableProposalOptions } from '../src/table-proposals.ts';

test('chat table approvals recheck workspace skill access under storage roles', { timeout: 60000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await loadPlatformBaseline(db.platform);
  const stream = await workspaceTableMigrations();
  const ws = await db.create(stream.slice(0, -1));
  const s = `"${ws.names.schema}"`;
  runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({ workspaceId: ws.id, generation: 1, connectionString: db.login(ws) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
  const team = randomUUID(),
    conversationId = randomUUID(),
    turnId = randomUUID(),
    messageId = randomUUID(),
    skillId = randomUUID(),
    revision = 'b'.repeat(64);
  await db.platform.query(`INSERT INTO ${s}.tf_teams(id,name) VALUES($1,'Operations')`, [team]);
  await db.platform.query(`UPDATE ${s}.tf_soul_head SET revision=$1 WHERE id=1`, ['a'.repeat(40)]);
  await db.platform.query(`INSERT INTO ${s}.tf_conversations(id,owner_user_id,owner_membership_id) VALUES($1,$2,$3)`, [
    conversationId,
    actor.userId,
    actor.membershipId,
  ]);
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_messages(id,conversation_id,sequence,author_kind,membership_id) VALUES($1,$2,1,'human',$3)`,
    [messageId, conversationId, actor.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_conversation_turns(id,conversation_id,source_message_id,accepted_sequence) VALUES($1,$2,$3,1)`,
    [turnId, conversationId, messageId],
  );
  await db.platform.query('BEGIN');
  await db.platform.query(
    `INSERT INTO ${s}.tf_workspace_skills(id,creator_id,saved_revision,active_revision,enabled) VALUES($1,$2,$3,$3,true)`,
    [skillId, actor.membershipId, revision],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_workspace_skill_revisions(skill_id,revision,definition,author_id) VALUES($1,$2,$3,$4)`,
    [
      skillId,
      revision,
      { name: 'Table procedure', instructions: 'Create the requested table.', sources: [] },
      actor.membershipId,
    ],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_workspace_skill_reviews(skill_id,revision,reviewer_id) VALUES($1,$2,$3)`,
    [skillId, revision, actor.membershipId],
  );
  await db.platform.query(
    `INSERT INTO ${s}.tf_skill_person_grants(skill_id,membership_id,permission) VALUES($1,$2,'read')`,
    [skillId, actor.membershipId],
  );
  await db.platform.query('COMMIT');
  const tools = createChatTools(runtime);
  const proposals = createChatTableProposals(runtime);
  const decisions = createTableProposalDecisions({
    ...tableProposalOptions(runtime),
    resolveConfirmationCredential: async () => db.login(ws, 'confirmation'),
  });
  const advance = createTableExecution({
    ...tableExecutionAccess,
    resolveMigrationCredential: async () => db.login(ws, 'migration'),
  });
  let publication = 0;
  const publish = createTablePublication({
    runtime,
    ...tableExecutionAccess,
    prepareRevision: async input => ({
      commit: (++publication).toString(16).padStart(40, '0'),
      parentCommit: input.expectedParentCommit,
      bundle: { key: `test/${input.commandId}`, sha256: 'c'.repeat(64) },
      projection: { definition: input.definition },
    }),
  });
  async function propose(sources = []) {
    const tableId = randomUUID();
    const result = (
      await tools.invokeWithSources(
        { workspaceId: ws.id, actor, callId: randomUUID(), origin: { conversationId, turnId, sources } },
        {
          tool: 'tables.propose',
          input: JSON.stringify({
            plans: [
              {
                kind: 'schema',
                tableId,
                expectedRevision: null,
                dependsOn: [],
                target: {
                  formatVersion: 2,
                  id: tableId,
                  owningTeamId: team,
                  label: `Records ${tableId}`,
                  fields: [],
                  uniqueKeys: [],
                },
                transforms: { outputs: [] },
              },
            ],
          }),
        },
      )
    ).result;
    assert.equal(result.status, 'pending');
    await decisions.decide(ws.id, actor, conversationId, result.id, {
      digest: result.digest,
      commandId: randomUUID(),
      decision: 'approve',
    });
    return { ...result, tableId };
  }
  async function finish(proposal) {
    for (let i = 0; i < 10; i++) {
      const state = await advance(ws.id, proposal.id);
      if (state === 'completed' || state === 'blocked') return state;
      if (state === 'publish') await publish(ws.id, proposal.id);
    }
    assert.fail('table execution did not finish');
  }
  async function expectCreated(proposal) {
    assert.equal(await finish(proposal), 'completed');
    assert.equal((await proposals.status(ws.id, actor.userId, conversationId, proposal.id)).status, 'completed');
    assert.ok(
      (await db.platform.query(`SELECT applied_revision FROM ${s}.tf_table_catalog WHERE id=$1`, [proposal.tableId]))
        .rows[0].applied_revision,
    );
  }
  async function expectDenied(proposal) {
    assert.equal(await finish(proposal), 'blocked');
    const status = await proposals.status(ws.id, actor.userId, conversationId, proposal.id);
    assert.equal(status.status, 'failed');
    assert.equal(status.plans[0].receipt.code, 'access-denied');
    assert.equal(
      (await db.platform.query(`SELECT 1 FROM ${s}.tf_table_catalog WHERE id=$1`, [proposal.tableId])).rowCount,
      0,
    );
  }
  const skill = { kind: 'workspace-skill', skillId, revision };
  await t.test('existing workspaces gain only the skill-check columns on upgrade', async () => {
    const previous = ws;
    const schema = `"${previous.names.schema}"`;
    const client = await connect(db.login(previous, 'migration'));
    try {
      await denied(client, `SELECT id,enabled FROM ${schema}.tf_workspace_skills`);
      await inTransaction(db.platform, tx => applyCommonMigrations(tx, previous.id, stream));
      for (const role of [previous.names.migration, previous.names.customOwner]) {
        await client.query(`SET ROLE "${role}"`);
        await client.query(`SELECT id,enabled FROM ${schema}.tf_workspace_skills`);
        await client.query(`SELECT skill_id,revision FROM ${schema}.tf_workspace_skill_reviews`);
        await client.query(`SELECT skill_id,membership_id,permission FROM ${schema}.tf_skill_person_grants`);
        await client.query(`SELECT skill_id,team_id,permission FROM ${schema}.tf_skill_team_grants`);
        await denied(client, `SELECT creator_id FROM ${schema}.tf_workspace_skills`);
        await denied(client, `SELECT reviewer_id FROM ${schema}.tf_workspace_skill_reviews`);
        await denied(client, `UPDATE ${schema}.tf_workspace_skills SET enabled=false`);
        await denied(client, `DELETE FROM ${schema}.tf_skill_person_grants`);
        await client.query('RESET ROLE');
      }
    } finally {
      await client.end();
    }
  });
  await t.test('plain creation applies after approval', async () => {
    await expectCreated(await propose());
  });
  await t.test('a readable enabled workspace skill can inform an approved table', async () => {
    await expectCreated(await propose([skill]));
  });
  await t.test('revoked skill read access blocks execution', async () => {
    const proposal = await propose([skill]);
    await db.platform.query(`DELETE FROM ${s}.tf_skill_person_grants WHERE skill_id=$1`, [skillId]);
    try {
      await expectDenied(proposal);
    } finally {
      await db.platform.query(
        `INSERT INTO ${s}.tf_skill_person_grants(skill_id,membership_id,permission) VALUES($1,$2,'read')`,
        [skillId, actor.membershipId],
      );
    }
  });
  await t.test('a disabled skill blocks execution', async () => {
    const proposal = await propose([skill]);
    await db.platform.query(`UPDATE ${s}.tf_workspace_skills SET enabled=false WHERE id=$1`, [skillId]);
    try {
      await expectDenied(proposal);
    } finally {
      await db.platform.query(`UPDATE ${s}.tf_workspace_skills SET enabled=true WHERE id=$1`, [skillId]);
    }
  });
  await t.test('a database permission refusal is logged and reported as access-denied', async () => {
    const proposal = await propose([skill]);
    const grant = `SELECT(id,enabled) ON ${s}.tf_workspace_skills`;
    await db.platform.query(`REVOKE ${grant} FROM "${ws.names.migration}","${ws.names.customOwner}"`);
    try {
      await expectDenied(proposal);
    } finally {
      await db.platform.query(`GRANT ${grant} TO "${ws.names.migration}","${ws.names.customOwner}"`);
    }
  });
});
