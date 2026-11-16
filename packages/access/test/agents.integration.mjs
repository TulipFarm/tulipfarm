import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, connect } from '../../workspace-storage/test/integration/fixture.mjs';
import { inTransaction } from '../../workspace-storage/src/provisioning.ts';
import {
  AccessDenied,
  canAccessAsset,
  canAccessTable,
  lockAuthorization,
  queryHumanContext,
  requireCurrentActor,
  requirePersistedIssueCall,
  resolveActor,
} from '../src/index.ts';

test('persisted agent authorization intersects live grants, limits, activation and caller', async () => {
  const setup = await fixture();
  const workspace = await setup.create();
  const client = await connect(setup.login(workspace));
  const s = `"${workspace.names.schema}"`;
  const agent = randomUUID(),
    activation = randomUUID(),
    run = randomUUID(),
    scheduled = randomUUID(),
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
    // A scheduled run kept as history from before agent schedules were removed never acts again.
    await setup.platform.query(
      `INSERT INTO ${s}.tf_agent_runs(id,agent_id,activation_id,definition_revision,kind,status,scope,sponsor_membership_id)
      VALUES($1,$2,$3,$4,'scheduled','completed',$5,$6)`,
      [scheduled, agent, activation, revision, JSON.stringify(scope), workspace.membershipId],
    );
    await assert.rejects(allowed({ kind: 'agent', runId: scheduled }), AccessDenied);
    await assert.rejects(
      queryHumanContext({ client, schema: workspace.names.schema }, { kind: 'agent', runId: scheduled }),
      AccessDenied,
    );
    await setup.platform.query(`UPDATE ${s}.tf_memberships SET removed_at = now() WHERE id = $1`, [
      workspace.membershipId,
    ]);
    await setup.platform.query(`INSERT INTO ${s}.tf_memberships (id,user_id,role) VALUES ($1,$2,'admin')`, [
      randomUUID(),
      workspace.userId,
    ]);
    await assert.rejects(allowed(actor), AccessDenied);
  } finally {
    await client.end();
    await setup.close();
  }
});

test('an app actor holds no member authority, even with an admin as its viewer', async () => {
  const setup = await fixture();
  const workspace = await setup.create();
  const client = await connect(setup.login(workspace));
  const viewer = { kind: 'human', userId: workspace.userId, membershipId: workspace.membershipId };
  const app = { kind: 'app', appId: randomUUID(), releaseId: randomUUID(), viewer };
  const asset = randomUUID();
  const issueCall = { requestId: randomUUID(), integrationId: randomUUID(), sourceId: randomUUID(), issueNumber: 1 };
  const check = operation =>
    inTransaction(client, async connection => {
      const transaction = { client: connection, schema: workspace.names.schema };
      await lockAuthorization(transaction);
      return operation(transaction);
    });
  try {
    assert.equal(await check(tx => canAccessTable(tx, viewer, asset, 'table.schema.manage')), true);
    assert.equal(await check(tx => canAccessTable(tx, app, asset, 'table.schema.manage')), false);
    assert.equal(await check(tx => canAccessAsset(tx, app, asset, 'table.row.read')), false);
    assert.equal(await check(tx => canAccessAsset(tx, app, asset, 'integration.read')), false);

    assert.equal(await check(tx => requireCurrentActor(tx, viewer)), undefined);
    await assert.rejects(
      check(tx => requireCurrentActor(tx, app)),
      AccessDenied,
    );
    await assert.rejects(
      check(tx => resolveActor(tx, app)),
      AccessDenied,
    );

    assert.deepEqual(await check(tx => queryHumanContext(tx, viewer)), viewer);
    assert.equal(await check(tx => queryHumanContext(tx, app)), null);

    assert.equal(await check(tx => requirePersistedIssueCall(tx, viewer, issueCall)), undefined);
    await assert.rejects(
      check(tx => requirePersistedIssueCall(tx, app, issueCall)),
      AccessDenied,
    );

    const unknown = { kind: 'visitor', visitorId: randomUUID() };
    await assert.rejects(
      check(tx => requireCurrentActor(tx, unknown)),
      AccessDenied,
    );
    await assert.rejects(
      check(tx => queryHumanContext(tx, unknown)),
      AccessDenied,
    );
  } finally {
    await client.end();
    await setup.close();
  }
});
