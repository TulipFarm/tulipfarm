import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentExecutor } from '../src/executor.ts';
import { savedTaskAgent } from './task-fixture.mjs';

test('an admin can enroll an agent in the workspace admins team but not in a team they only belong to', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  const w = await db.create(await workspaceTableMigrations()),
    table = name => `"${w.names.schema}".${name}`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const admin = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const agent = await savedTaskAgent(db, w, runtime, admin.userId, admin.membershipId, [], ['skills.list']);
  const adminTeam = (await db.platform.query(`SELECT id FROM ${table('tf_teams')} WHERE name='_admin'`)).rows[0].id;
  assert.equal(
    (
      await db.platform.query(`SELECT role FROM ${table('tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`, [
        admin.membershipId,
        adminTeam,
      ])
    ).rows[0].role,
    'member',
  );
  const executor = createAgentExecutor({ runtime });
  const configure = (version, teamIds) =>
    executor.configure(w.id, admin, { agentId: agent.agentId, version, enabled: true, teamIds, limits: [] });

  await configure(0, [agent.teamId, adminTeam]);
  assert.deepEqual(
    (
      await db.platform.query(`SELECT team_id FROM ${table('tf_agent_teams')} WHERE agent_id=$1 ORDER BY team_id`, [
        agent.agentId,
      ])
    ).rows.map(row => row.team_id),
    [agent.teamId, adminTeam].sort(),
  );

  const otherTeam = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Plain membership')`, [otherTeam]);
  await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
    admin.membershipId,
    otherTeam,
  ]);
  await assert.rejects(configure(1, [agent.teamId, adminTeam, otherTeam]), AccessDenied);
});
