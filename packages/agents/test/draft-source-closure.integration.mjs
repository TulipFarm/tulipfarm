import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  AccessDenied,
  lockAuthorization,
  requireProtectedSource,
  requireWorkflowDefinitionSources,
} from '@tulipfarm/access';
import { conversationFixture } from '../../conversations/test/fixture.mjs';
import { conversationResult, mergeSources } from '../../conversations/src/results.ts';
import { requireDraftSources } from '../src/draft-sources.ts';
import { resultSources } from '../src/tool-sources.ts';
import { createChatTools } from '../src/tools.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

test('finite resource results retain every returned source and distinguish schema from record rights', async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace,
    actor = { kind: 'human', membershipId: randomUUID(), userId: randomUUID() },
    team = randomUUID();
  await f.db.platform.query(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    actor.membershipId,
    actor.userId,
  ]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Source readers')`, [team]);
  await f.db.platform.query(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    actor.membershipId,
    team,
  ]);
  const first = randomUUID(),
    second = randomUUID();
  for (const [id, permission] of [
    [first, 'table.schema.manage'],
    [second, 'table.row.read'],
  ]) {
    await f.db.platform.query(
      `INSERT INTO ${f.table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,$3,'Source','revision')`,
      [id, team, `r_${id.replaceAll('-', '')}`],
    );
    await f.db.platform.query(`INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,$3)`, [
      team,
      id,
      permission,
    ]);
  }
  // Neither table has an applied definition yet, so listing omits both instead of failing.
  const { tables } = (
    await createChatTools(f.runtime).invokeWithSources(
      { workspaceId: w.id, actor, callId: randomUUID() },
      { tool: 'tables.list' },
    )
  ).result;
  assert.deepEqual(
    tables.filter(table => table.id === first || table.id === second),
    [],
  );
  const listed = {
    tables: [
      { id: first, savedRevision: 'revision' },
      { id: second, savedRevision: 'revision' },
    ],
    total: 2,
    nextCursor: null,
  };
  const sources = await f.runtime.transaction(w.id, commonCompatibility, tx =>
    resultSources(tx, { tool: 'tables.list', limit: 25 }, listed),
  );
  assert.deepEqual(sources, [
    { kind: 'table-schema', tableId: first, revision: 'revision' },
    { kind: 'table-schema', tableId: second, revision: 'revision' },
  ]);
  const check = sources =>
    f.runtime.transaction(w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      await requireDraftSources(tx, actor, sources);
    });
  await check(sources);
  await assert.rejects(check([{ kind: 'table', tableId: first }]), AccessDenied);
  await f.db.platform.query(`DELETE FROM ${f.table('tf_grants')} WHERE asset_id=$1`, [second]);
  await assert.rejects(check(sources), AccessDenied);
  assert.deepEqual(conversationResult('Legacy text'), { text: 'Legacy text', sources: [{ kind: 'unknown' }] });
  const overflow = mergeSources(
    Array.from({ length: 1001 }, (_, index) => ({ kind: 'public-web', url: `https://example.com/${index}` })),
  );
  assert.deepEqual(overflow, [{ kind: 'unknown' }]);
  await assert.rejects(check(overflow), AccessDenied);
  await assert.rejects(check([{ kind: 'unavailable' }]), AccessDenied);
});

test('a saved definition outlives edited tables and deleted agents and skills its chat listed, but not lost access', async t => {
  const f = await conversationFixture();
  t.after(() => f.close());
  const w = f.workspace,
    actor = { kind: 'human', membershipId: randomUUID(), userId: randomUUID() },
    team = randomUUID(),
    tableId = randomUUID(),
    agentId = randomUUID(),
    skillId = randomUUID(),
    skillRevision = 'c'.repeat(64),
    soul = 'a'.repeat(40),
    command = randomUUID();
  const sql = (text, values = []) => f.db.platform.query(text, values);
  await sql(`INSERT INTO ${f.table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    actor.membershipId,
    actor.userId,
  ]);
  await sql(`INSERT INTO ${f.table('tf_teams')} (id,name) VALUES ($1,'Readers')`, [team]);
  await sql(`INSERT INTO ${f.table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    actor.membershipId,
    team,
  ]);
  await sql(
    `INSERT INTO ${f.table('tf_table_catalog')} (id,owning_team_id,physical_table,display_name,target_revision) VALUES ($1,$2,$3,'Source','first')`,
    [tableId, team, `r_${tableId.replaceAll('-', '')}`],
  );
  await sql(`INSERT INTO ${f.table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`, [
    team,
    tableId,
  ]);
  const definition = { name: 'Listed', instructions: 'Only listed.', tools: [] };
  const revision = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
  await sql(
    `INSERT INTO ${f.table('tf_agents')} (id,enabled,owning_team_id,display_name) VALUES ($1,true,$2,'Listed')`,
    [agentId, team],
  );
  await sql(`INSERT INTO ${f.table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`, [
    agentId,
    revision,
    definition,
  ]);
  await sql(
    `INSERT INTO ${f.table('tf_agent_commands')} (id,agent_id,membership_id,user_id,request_id,input,status) VALUES ($1,$2,$3,$4,$1,'{}','accepted')`,
    [command, agentId, actor.membershipId, actor.userId],
  );
  await sql(
    `INSERT INTO ${f.table('tf_soul_revisions')} (revision,parent_revision,agent_command_id,bundle_key,bundle_sha256) VALUES ($1,$2,$3,'fixture',$4)`,
    [soul, '0'.repeat(40), command, 'b'.repeat(64)],
  );
  await sql(
    `INSERT INTO ${f.table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
    [agentId, soul, revision],
  );
  await sql(`UPDATE ${f.table('tf_agents')} SET saved_revision=$2 WHERE id=$1`, [agentId, soul]);
  await sql(`INSERT INTO ${f.table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'read')`, [
    agentId,
    team,
  ]);
  await sql('BEGIN');
  await sql(
    `INSERT INTO ${f.table('tf_workspace_skills')} (id,creator_id,saved_revision,active_revision,enabled) VALUES ($1,$2,$3,$3,true)`,
    [skillId, actor.membershipId, skillRevision],
  );
  await sql(
    `INSERT INTO ${f.table('tf_workspace_skill_revisions')} (skill_id,revision,definition,author_id) VALUES ($1,$2,$3,$4)`,
    [skillId, skillRevision, { name: 'Listed', instructions: 'Only listed.' }, actor.membershipId],
  );
  await sql(`INSERT INTO ${f.table('tf_workspace_skill_reviews')} (skill_id,revision,reviewer_id) VALUES ($1,$2,$3)`, [
    skillId,
    skillRevision,
    actor.membershipId,
  ]);
  await sql('COMMIT');
  await sql(
    `INSERT INTO ${f.table('tf_skill_person_grants')} (skill_id,membership_id,permission) VALUES ($1,$2,'read')`,
    [skillId, actor.membershipId],
  );
  const sources = [
    { kind: 'table-schema', tableId, revision: 'first' },
    { kind: 'agent-definition', agentId, revision: soul },
    { kind: 'workspace-skill', skillId, revision: skillRevision },
  ];
  const inTransaction = check =>
    f.runtime.transaction(w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      await check(tx);
    });
  const pinned = () => inTransaction(tx => requireDraftSources(tx, actor, sources));
  // A Slack send from a chat-drafted workflow, and a view of its definition or a run.
  const saved = async () => {
    await inTransaction(tx =>
      requireDraftSources(
        tx,
        actor,
        sources,
        new Set(),
        undefined,
        false,
        false,
        undefined,
        undefined,
        false,
        false,
        true,
      ),
    );
    await inTransaction(tx => requireWorkflowDefinitionSources(tx, actor, sources));
  };
  await saved();
  await sql(`UPDATE ${f.table('tf_table_catalog')} SET target_revision='second' WHERE id=$1`, [tableId]);
  await sql(`UPDATE ${f.table('tf_agents')} SET deleted_at=now() WHERE id=$1`, [agentId]);
  await sql(`UPDATE ${f.table('tf_workspace_skills')} SET enabled=false WHERE id=$1`, [skillId]);
  await assert.rejects(pinned(), AccessDenied);
  await saved();
  // A chat that used a deleted agent stays readable to whoever could read the agent.
  await inTransaction(tx => requireProtectedSource(tx, actor, sources[1]));
  // An agent or skill that still exists, and every table, keeps needing current access.
  await sql(`DELETE FROM ${f.table('tf_skill_person_grants')} WHERE skill_id=$1`, [skillId]);
  await assert.rejects(saved(), AccessDenied);
  await sql(
    `INSERT INTO ${f.table('tf_skill_person_grants')} (skill_id,membership_id,permission) VALUES ($1,$2,'read')`,
    [skillId, actor.membershipId],
  );
  await sql(`UPDATE ${f.table('tf_workspace_skills')} SET deleted_at=now() WHERE id=$1`, [skillId]);
  await saved();
  await sql(`UPDATE ${f.table('tf_agents')} SET deleted_at=NULL WHERE id=$1`, [agentId]);
  await sql(`DELETE FROM ${f.table('tf_agent_grants')} WHERE agent_id=$1`, [agentId]);
  await assert.rejects(saved(), AccessDenied);
  await sql(`UPDATE ${f.table('tf_agents')} SET deleted_at=now() WHERE id=$1`, [agentId]);
  await assert.rejects(
    inTransaction(tx => requireProtectedSource(tx, actor, sources[1])),
    AccessDenied,
  );
  await sql(`UPDATE ${f.table('tf_agents')} SET deleted_at=NULL WHERE id=$1`, [agentId]);
  await sql(`INSERT INTO ${f.table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'read')`, [
    agentId,
    team,
  ]);
  await saved();
  await sql(`DELETE FROM ${f.table('tf_grants')} WHERE asset_id=$1`, [tableId]);
  await assert.rejects(saved(), AccessDenied);
});
