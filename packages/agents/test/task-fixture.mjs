import { createHash, randomUUID } from 'node:crypto';
import { createAgentStore } from '../src/store.ts';
import { canonicalJson } from '@tulipfarm/tables/canonical';

// Fixture administration uses an explicit manager grant. Workspace admin status grants no agent access.
export async function grantAgentManager(db, workspace, agentId, membershipId) {
  const table = name => `"${workspace.names.schema}".${name}`;
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'manage') ON CONFLICT DO NOTHING`,
    [agentId, membershipId],
  );
}

export async function savedTaskAgent(
  db,
  workspace,
  runtime,
  userId,
  membershipId,
  skills = [],
  tools = ['rows.list', 'rows.update'],
  mcp = undefined,
) {
  const table = name => `"${workspace.names.schema}".${name}`;
  const teamId = randomUUID(),
    agentId = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,$2)`, [
    teamId,
    `Task invokers ${agentId}`,
  ]);
  await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    membershipId,
    teamId,
  ]);
  await db.platform.query(
    `INSERT INTO ${table('tf_agents')} (id,owning_team_id,display_name) VALUES ($1,$2,'Private assistant')`,
    [agentId, teamId],
  );
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'invoke'),($1,$2,'read')`,
    [agentId, teamId],
  );
  await grantAgentManager(db, workspace, agentId, workspace.membershipId);
  await db.platform.query(`INSERT INTO ${table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [
    agentId,
    teamId,
  ]);
  const admin = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
  async function activate(selectedSkills = skills) {
    const definition = {
      name: 'Private assistant',
      instructions: `Reviewed definition ${randomUUID()}`,
      tools,
      skills: selectedSkills,
      ...(mcp ? { mcp } : {}),
    };
    const revision = createHash('sha256').update(canonicalJson(definition)).digest('hex');
    const commandId = randomUUID(),
      soul = createHash('sha1').update(randomUUID()).digest('hex');
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_definitions')} (agent_id,revision,definition) VALUES ($1,$2,$3)`,
      [agentId, revision, definition],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_commands')} (id,agent_id,membership_id,user_id,request_id,input,status) VALUES ($1,$2,$3,$4,$5,'{}','accepted')`,
      [commandId, agentId, membershipId, userId, randomUUID()],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_soul_revisions')} (revision,agent_command_id,bundle_key,bundle_sha256) VALUES ($1,$2,'fixture','fixture')`,
      [soul, commandId],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_agent_saved_revisions')} (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
      [agentId, soul, revision],
    );
    await db.platform.query(`UPDATE ${table('tf_agents')} SET saved_revision=$2 WHERE id=$1`, [agentId, soul]);
    return {
      ...(await createAgentStore(runtime).activate(workspace.id, admin, { agentId, revision, scope: [] })),
      revision,
    };
  }
  return { teamId, agentId, activate, ...(await activate()) };
}

export async function seedExecution(db, workspace, agentId, teamIds, limits) {
  const table = name => `"${workspace.names.schema}".${name}`;
  await db.platform.query(`UPDATE ${table('tf_agents')} SET enabled=true,policy_version=policy_version+1 WHERE id=$1`, [
    agentId,
  ]);
  await db.platform.query(`DELETE FROM ${table('tf_agent_teams')} WHERE agent_id=$1`, [agentId]);
  for (const teamId of teamIds)
    await db.platform.query(`INSERT INTO ${table('tf_agent_teams')} (agent_id,team_id) VALUES ($1,$2)`, [
      agentId,
      teamId,
    ]);
  await db.platform.query(
    `INSERT INTO ${table('tf_agent_limits')} (agent_id,scope) VALUES ($1,$2) ON CONFLICT (agent_id) DO UPDATE SET scope=EXCLUDED.scope`,
    [agentId, JSON.stringify(limits)],
  );
}
