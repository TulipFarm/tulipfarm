import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { registerGovernance } from '../src/governance.ts';

test(
  'voluntary departures require a manager handoff while forced removal locks items',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime, app;
    try {
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const stream = await workspaceTableMigrations();
      const w = await db.create(stream);
      const table = name => `"${w.names.schema}".${name}`;
      const query = (sql, values) => db.platform.query(sql, values);
      const admin = { id: w.userId, membershipId: w.membershipId };
      const alice = { id: randomUUID(), membershipId: randomUUID() };
      const bob = { id: randomUUID(), membershipId: randomUUID() };
      const departed = { id: randomUUID(), membershipId: randomUUID() };
      for (const person of [alice, bob, departed])
        await query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role,removed_at) VALUES ($1,$2,'member',$3)`, [
          person.membershipId,
          person.id,
          person === departed ? new Date() : null,
        ]);

      const team = randomUUID();
      await query(`INSERT INTO ${table('tf_teams')} (id,name,creator_membership_id) VALUES ($1,'Operations',$2)`, [
        team,
        alice.membershipId,
      ]);
      await query(
        `INSERT INTO ${table('tf_member_teams')} (team_id,membership_id,role) VALUES ($1,$2,'manager'),($1,$3,'member')`,
        [team, alice.membershipId, bob.membershipId],
      );
      const project = randomUUID();
      await query(`INSERT INTO ${table('tf_projects')} (id,name,creator_membership_id) VALUES ($1,'Launch',$2)`, [
        project,
        alice.membershipId,
      ]);
      await query(
        `INSERT INTO ${table('tf_project_members')} (project_id,membership_id,role) VALUES ($1,$2,'manager'),($1,$3,'member')`,
        [project, alice.membershipId, bob.membershipId],
      );
      const agent = randomUUID(),
        lockedAgent = randomUUID();
      await query(`INSERT INTO ${table('tf_agents')} (id,display_name) VALUES ($1,'Assistant'),($2,'Already locked')`, [
        agent,
        lockedAgent,
      ]);
      await query(
        `INSERT INTO ${table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'manage'),($3,$4,'manage')`,
        [agent, alice.membershipId, lockedAgent, departed.membershipId],
      );
      const skill = randomUUID(),
        skillRevision = 'a'.repeat(64);
      await query('BEGIN');
      await query(`INSERT INTO ${table('tf_workspace_skills')} (id,creator_id,saved_revision) VALUES ($1,$2,$3)`, [
        skill,
        alice.membershipId,
        skillRevision,
      ]);
      await query(
        `INSERT INTO ${table('tf_workspace_skill_revisions')} (skill_id,revision,definition,author_id) VALUES ($1,$2,'{}',$3)`,
        [skill, skillRevision, alice.membershipId],
      );
      await query('COMMIT');
      await query(
        `INSERT INTO ${table('tf_skill_team_grants')} (skill_id,team_id,permission) VALUES ($1,$2,'manage')`,
        [skill, team],
      );
      const workflow = randomUUID(),
        workflowRevision = randomUUID();
      await query('BEGIN');
      await query(`INSERT INTO ${table('tf_workflows')} (id,revision) VALUES ($1,$2)`, [workflow, workflowRevision]);
      await query(
        `INSERT INTO ${table('tf_workflow_revisions')} (workflow_id,id,definition,author_membership_id) VALUES ($1,$2,'{}',$3)`,
        [workflow, workflowRevision, alice.membershipId],
      );
      await query('COMMIT');
      await query(
        `INSERT INTO ${table('tf_workflow_grants')} (workflow_id,membership_id,permission) VALUES ($1,$2,'manage')`,
        [workflow, alice.membershipId],
      );
      const mcp = randomUUID();
      await query(
        `INSERT INTO ${table('tf_mcp_integrations')} (id,ownership,name,endpoint,server_identity,auth_method,lifecycle) VALUES ($1,'shared','Support desk','https://mcp.example.com','fixture','none','disabled')`,
        [mcp],
      );
      await query(`INSERT INTO ${table('tf_mcp_managers')} (integration_id,membership_id) VALUES ($1,$2)`, [
        mcp,
        bob.membershipId,
      ]);

      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 30,
        connectionsPerPool: 3,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const auth = {
        api: {
          getSession: async ({ headers }) => {
            const id = headers.get('x-test-user');
            return id ? { user: { id } } : null;
          },
        },
      };
      app = Fastify();
      registerGovernance(app, {
        runtime,
        identity: db.platform,
        compatibility: { minimum: stream.length, maximum: stream.length },
        auth,
      });
      const base = `/workspaces/${w.id}/governance`;
      const http = async (who, method, path, payload, expected = 200) => {
        const response = await app.inject({
          method,
          url: base + path,
          headers: { 'x-test-user': who.id, origin: 'http://localhost:5173' },
          ...(payload === undefined ? {} : { payload }),
        });
        assert.equal(response.statusCode, expected, `${method} ${path}: ${response.body}`);
        return response.json();
      };
      const handoff = { error: 'manager-handoff-required' };

      // Deleting a team removes every member's team-granted management.
      assert.deepEqual(await http(alice, 'DELETE', `/teams/${team}`, undefined, 409), handoff);
      await query(
        `INSERT INTO ${table('tf_skill_person_grants')} (skill_id,membership_id,permission) VALUES ($1,$2,'manage')`,
        [skill, bob.membershipId],
      );
      await http(alice, 'PUT', `/teams/${team}/members/${bob.membershipId}/role`, { role: 'manager' });

      // Each sole-manager item blocks a voluntary leave until another manager is appointed.
      assert.equal((await http(alice, 'GET', '/me')).capabilities.canLeave, false);
      assert.deepEqual(await http(alice, 'POST', '/leave', undefined, 409), handoff);
      await query(`UPDATE ${table('tf_project_members')} SET role='manager' WHERE project_id=$1 AND membership_id=$2`, [
        project,
        bob.membershipId,
      ]);
      assert.deepEqual(await http(alice, 'POST', '/leave', undefined, 409), handoff);
      await query(`INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'manage')`, [
        agent,
        team,
      ]);
      assert.deepEqual(await http(alice, 'POST', '/leave', undefined, 409), handoff);
      // An archived workflow can no longer be opened, so its sole manager never needs a handoff.
      await query(`UPDATE ${table('tf_workflows')} SET archived_at=clock_timestamp() WHERE id=$1`, [workflow]);
      assert.equal((await http(alice, 'GET', '/me')).capabilities.canLeave, true);
      await query(`UPDATE ${table('tf_workflows')} SET archived_at=NULL WHERE id=$1`, [workflow]);
      assert.equal((await http(alice, 'GET', '/me')).capabilities.canLeave, false);
      await query(
        `INSERT INTO ${table('tf_workflow_grants')} (workflow_id,team_id,permission) VALUES ($1,$2,'manage')`,
        [workflow, team],
      );
      assert.equal((await http(alice, 'GET', '/me')).capabilities.canLeave, true);
      await http(alice, 'POST', '/leave');
      assert.equal(
        (
          await query(`SELECT removed_at IS NOT NULL AS removed FROM ${table('tf_memberships')} WHERE id=$1`, [
            alice.membershipId,
          ])
        ).rows[0].removed,
        true,
      );

      // Bob now manages the agent and workflow only through the team. The already-locked agent never blocks.
      assert.deepEqual(await http(bob, 'POST', '/leave', undefined, 409), { error: 'final-team-manager' });
      assert.deepEqual(await http(bob, 'DELETE', `/teams/${team}`, undefined, 409), handoff);

      // An admin's forced removal is allowed and leaves bob's items managerless.
      await http(admin, 'DELETE', `/members/${bob.membershipId}`);
      const managers = (
        await query(
          `SELECT 1 FROM ${table('tf_mcp_managers')} g JOIN ${table('tf_memberships')} m ON m.id=g.membership_id AND m.removed_at IS NULL WHERE g.integration_id=$1`,
          [mcp],
        )
      ).rowCount;
      assert.equal(managers, 0);
      assert.equal(
        (await http(admin, 'GET', '/me')).capabilities.canLeave,
        false,
        'the final admin still cannot leave',
      );
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);

test(
  'team enrollment changes keep person-granted managers while a voluntary leave still needs a handoff',
  { timeout: 60000 },
  async () => {
    const db = await fixture();
    let runtime, app;
    try {
      const stream = await workspaceTableMigrations();
      const w = await db.create(stream);
      const table = name => `"${w.names.schema}".${name}`;
      const query = (sql, values) => db.platform.query(sql, values);
      const lead = { id: randomUUID(), membershipId: randomUUID() };
      const operator = { id: randomUUID(), membershipId: randomUUID() };
      for (const person of [lead, operator])
        await query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
          person.membershipId,
          person.id,
        ]);
      const team = randomUUID();
      await query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Support')`, [team]);
      await query(
        `INSERT INTO ${table('tf_member_teams')} (team_id,membership_id,role) VALUES ($1,$2,'manager'),($1,$3,'member')`,
        [team, lead.membershipId, operator.membershipId],
      );
      // The operator manages the agent through a person grant, so team changes keep a manager.
      const agent = randomUUID();
      await query(`INSERT INTO ${table('tf_agents')} (id,display_name) VALUES ($1,'Triage')`, [agent]);
      await query(
        `INSERT INTO ${table('tf_agent_person_grants')} (agent_id,membership_id,permission) VALUES ($1,$2,'manage')`,
        [agent, operator.membershipId],
      );
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 30,
        connectionsPerPool: 3,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const auth = {
        api: {
          getSession: async ({ headers }) => {
            const id = headers.get('x-test-user');
            return id ? { user: { id } } : null;
          },
        },
      };
      app = Fastify();
      registerGovernance(app, {
        runtime,
        identity: db.platform,
        compatibility: { minimum: stream.length, maximum: stream.length },
        auth,
      });
      const base = `/workspaces/${w.id}/governance`;
      const status = async (who, method, path, payload) =>
        (
          await app.inject({
            method,
            url: base + path,
            headers: { 'x-test-user': who.id, origin: 'http://localhost:5173' },
            ...(payload === undefined ? {} : { payload }),
          })
        ).statusCode;
      assert.equal(
        await status(lead, 'PUT', `/teams/${team}/members/${operator.membershipId}`, { enrolled: false }),
        200,
      );
      assert.equal(
        await status(lead, 'PUT', `/teams/${team}/members/${operator.membershipId}`, { enrolled: true }),
        200,
      );
      assert.equal(await status(operator, 'POST', `/teams/${team}/leave`), 200);
      assert.equal(await status(operator, 'POST', '/leave'), 409);
    } finally {
      await app?.close();
      await runtime?.close();
      await db.close();
    }
  },
);
