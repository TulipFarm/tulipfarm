import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { inTransaction } from '../../workspace-storage/src/provisioning.ts';
import { AccessDenied, canAccessTable, lockAuthorization, queryHumanContext } from '../src/index.ts';

test('persisted agent authorization intersects live grants, limits, activation, caller and schedule', async () => {
  const setup = await fixture();
  const workspace = await setup.create();
  const client = await connect(setup.login(workspace));
  const s = `"${workspace.names.schema}"`;
  const agent = randomUUID(),
    activation = randomUUID(),
    run = randomUUID(),
    scheduled = randomUUID(),
    schedule = randomUUID(),
    team = randomUUID(),
    asset = randomUUID();
  const revision = 'a'.repeat(64);
  const scope = [{ assetId: asset, permissions: ['table.schema.manage'] }];
  const actor = { kind: 'agent', runId: run };
  const allowed = (subject, assetId = asset) =>
    inTransaction(client, async connection => {
      const transaction = { client: connection, schema: workspace.names.schema };
      await lockAuthorization(transaction);
      return canAccessTable(transaction, subject, assetId, 'table.schema.manage');
    });
  try {
    await setup.platform.query(`INSERT INTO ${s}.tf_teams (id,name) VALUES ($1,'Agents')`, [team]);
    await setup.platform.query(`INSERT INTO ${s}.tf_agents (id) VALUES ($1)`, [agent]);
    await setup.platform.query(`INSERT INTO ${s}.tf_agent_definitions VALUES ($1,$2,'{}')`, [agent, revision]);
    const command = randomUUID();
    await setup.platform.query(
      `INSERT INTO ${s}.tf_agent_commands (id,agent_id,membership_id,user_id,request_id,input) VALUES ($1,$2,$3,$4,$5,'{}')`,
      [command, agent, workspace.membershipId, workspace.userId, randomUUID()],
    );
    await setup.platform.query(
      `INSERT INTO ${s}.tf_soul_revisions (revision,agent_command_id,bundle_key,bundle_sha256) VALUES ($1,$2,'k','s')`,
      ['a'.repeat(40), command],
    );
    await setup.platform.query(
      `INSERT INTO ${s}.tf_agent_saved_revisions (agent_id,soul_revision,definition_revision,projection) VALUES ($1,$2,$3,'{}')`,
      [agent, 'a'.repeat(40), revision],
    );
    await setup.platform.query(`UPDATE ${s}.tf_agents SET saved_revision=$2, display_name='Agent' WHERE id=$1`, [
      agent,
      'a'.repeat(40),
    ]);
    await setup.platform.query(
      `INSERT INTO ${s}.tf_agent_activations (id,agent_id,definition_revision,scope) VALUES ($1,$2,$3,$4)`,
      [activation, agent, revision, JSON.stringify(scope)],
    );
    await setup.platform.query(`INSERT INTO ${s}.tf_agent_limits VALUES ($1,$2)`, [agent, JSON.stringify(scope)]);
    await setup.platform.query(`INSERT INTO ${s}.tf_agent_teams VALUES ($1,$2)`, [agent, team]);
    await setup.platform.query(
      `INSERT INTO ${s}.tf_agent_person_grants (agent_id,membership_id,permission) VALUES ($1,$2,'manage'),($1,$2,'invoke')`,
      [agent, workspace.membershipId],
    );
    await setup.platform.query(`INSERT INTO ${s}.tf_grants VALUES ($1,$2,'table.schema.manage')`, [team, asset]);
    await setup.platform.query(
      `INSERT INTO ${s}.tf_agent_runs (id,agent_id,activation_id,definition_revision,kind,user_id,membership_id,scope) VALUES ($1,$2,$3,$4,'delegated',$5,$6,$7)`,
      [run, agent, activation, revision, workspace.userId, workspace.membershipId, JSON.stringify(scope)],
    );
    assert.equal(await allowed(actor), true);
    assert.deepEqual(await queryHumanContext({ client, schema: workspace.names.schema }, actor), {
      kind: 'human',
      userId: workspace.userId,
      membershipId: workspace.membershipId,
    });
    assert.equal(await allowed({ kind: 'agent', runId: run.toUpperCase() }, asset.toUpperCase()), true);
    await setup.platform.query(`UPDATE ${s}.tf_agent_limits SET scope = '[]' WHERE agent_id = $1`, [agent]);
    assert.equal(await allowed(actor), false, 'admin caller cannot bypass agent limits');
    await setup.platform.query(`UPDATE ${s}.tf_agent_limits SET scope = $2 WHERE agent_id = $1`, [
      agent,
      JSON.stringify(scope),
    ]);
    await setup.platform.query(`UPDATE ${s}.tf_agent_activations SET scope = '[]' WHERE id = $1`, [activation]);
    assert.equal(await allowed(actor), false);
    await setup.platform.query(`UPDATE ${s}.tf_agent_activations SET scope = $2 WHERE id = $1`, [
      activation,
      JSON.stringify(scope),
    ]);
    await setup.platform.query(`DELETE FROM ${s}.tf_agent_teams WHERE agent_id = $1`, [agent]);
    assert.equal(await allowed(actor), false);
    await setup.platform.query(`INSERT INTO ${s}.tf_agent_teams VALUES ($1,$2)`, [agent, team]);
    await setup.platform.query(`UPDATE ${s}.tf_memberships SET role = 'member' WHERE id = $1`, [
      workspace.membershipId,
    ]);
    assert.equal(await allowed(actor), false, 'agent grants cannot bypass caller grants');
    await setup.platform.query(`INSERT INTO ${s}.tf_member_teams VALUES ($1,$2)`, [workspace.membershipId, team]);
    assert.equal(await allowed(actor), true);
    await setup.platform.query(`INSERT INTO ${s}.tf_agent_schedules (id,activation_id,scope) VALUES ($1,$2,$3)`, [
      schedule,
      activation,
      JSON.stringify(scope),
    ]);
    await setup.platform.query(
      `INSERT INTO ${s}.tf_agent_runs (id,agent_id,activation_id,definition_revision,kind,schedule_id,scope) VALUES ($1,$2,$3,$4,'scheduled',$5,$6)`,
      [scheduled, agent, activation, revision, schedule, JSON.stringify(scope)],
    );
    const sponsoredSchedule = randomUUID(),
      sponsoredRun = randomUUID();
    await setup.platform.query(
      `INSERT INTO ${s}.tf_agent_schedules(id,activation_id,scope,sponsor_membership_id)
      VALUES($1,$2,$3,$4)`,
      [sponsoredSchedule, activation, JSON.stringify(scope), workspace.membershipId],
    );
    await setup.platform.query(
      `INSERT INTO ${s}.tf_agent_runs(id,agent_id,activation_id,definition_revision,kind,schedule_id,scope,sponsor_membership_id)
      VALUES($1,$2,$3,$4,'scheduled',$5,$6,$7)`,
      [sponsoredRun, agent, activation, revision, sponsoredSchedule, JSON.stringify(scope), workspace.membershipId],
    );
    assert.equal(
      await queryHumanContext({ client, schema: workspace.names.schema }, { kind: 'agent', runId: sponsoredRun }),
      null,
      'A sponsor is not the identity for an autonomous is-me query',
    );
    await setup.platform.query(`UPDATE ${s}.tf_memberships SET removed_at = now() WHERE id = $1`, [
      workspace.membershipId,
    ]);
    await setup.platform.query(`INSERT INTO ${s}.tf_memberships (id,user_id,role) VALUES ($1,$2,'admin')`, [
      randomUUID(),
      workspace.userId,
    ]);
    await assert.rejects(allowed(actor), AccessDenied);
    // Scheduled runs act only for a current named sponsor. Unsponsored legacy schedules stay locked.
    await assert.rejects(allowed({ kind: 'agent', runId: scheduled }), AccessDenied);
    await setup.platform.query(`UPDATE ${s}.tf_agent_schedules SET revoked_at = now() WHERE id = $1`, [schedule]);
    await assert.rejects(allowed({ kind: 'agent', runId: scheduled }), AccessDenied);
    await setup.platform.query(`UPDATE ${s}.tf_agent_schedules SET revoked_at = NULL WHERE id = $1`, [schedule]);
    await setup.platform.query(`UPDATE ${s}.tf_agents SET enabled = false WHERE id = $1`, [agent]);
    await assert.rejects(allowed({ kind: 'agent', runId: scheduled }), AccessDenied);
  } finally {
    await client.end();
    await setup.close();
  }
});
