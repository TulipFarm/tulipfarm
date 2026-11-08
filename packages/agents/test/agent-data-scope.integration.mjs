import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentExecutor } from '../src/executor.ts';
import { createSavedAgentService } from '../src/saved-service.ts';
import { grantAgentManager, savedTaskAgent } from './task-fixture.mjs';

test('a manager changes an existing agent data scope within their own table access', async t => {
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
  const user = randomUUID(),
    member = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
    member,
    user,
  ]);
  const editor = { kind: 'human', userId: user, membershipId: member };
  const admin = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const agent = await savedTaskAgent(db, w, runtime, user, member, [], ['tables.list']);
  await grantAgentManager(db, w, agent.agentId, member);
  const granted = randomUUID(),
    hidden = randomUUID();
  await db.platform.query(
    `INSERT INTO ${table('tf_grants')}(team_id,asset_id,permission) VALUES($1,$2,'table.row.read'),($1,$2,'table.row.create')`,
    [agent.teamId, granted],
  );
  const executor = createAgentExecutor({ runtime });
  const change = (version, scope, actor = editor) =>
    executor.changeDataScope(w.id, actor, { agentId: agent.agentId, version, scope });
  const state = async () => ({
    limits: (
      await db.platform.query(`SELECT scope FROM ${table('tf_agent_limits')} WHERE agent_id=$1`, [agent.agentId])
    ).rows[0]?.scope,
    activations: (
      await db.platform.query(
        `SELECT definition_revision AS revision, scope, revoked_at IS NULL AS live FROM ${table('tf_agent_activations')} WHERE agent_id=$1 ORDER BY activated_at, id`,
        [agent.agentId],
      )
    ).rows,
  });
  const usable = [{ assetId: granted, permissions: ['table.row.read', 'table.row.create'] }];
  const other = { assetId: hidden, permissions: ['table.row.read'] };

  assert.deepEqual(await change(0, usable), { saved: true, reactivated: true });
  const added = await state();
  assert.deepEqual(added, {
    limits: usable,
    activations: [
      { revision: agent.revision, scope: [], live: true },
      { revision: agent.revision, scope: usable, live: true },
    ],
  });
  await db.platform.query(
    `UPDATE ${table('tf_agent_saved_revisions')} SET projection=jsonb_build_object('workspaceId',$2::text,'commit',soul_revision,'kind','agent','id',agent_id,'path','agent.json','bucket','fixture','key','fixture','sha256',definition_revision) WHERE agent_id=$1`,
    [agent.agentId, w.id],
  );
  const saved = createSavedAgentService(runtime, async () => ({
    formatVersion: 1,
    id: agent.agentId,
    name: 'Private assistant',
    instructions: 'Reviewed definition',
    tools: ['tables.list'],
  }));
  assert.deepEqual(
    (await saved.detail(w.id, user, agent.agentId)).activations.map(item => item.scope),
    [usable, []],
    'the run form lists the newest activation first',
  );

  await assert.rejects(change(1, [...usable, other]), AccessDenied);
  await assert.rejects(
    change(1, [{ assetId: granted, permissions: ['table.row.read', 'table.row.delete'] }]),
    AccessDenied,
  );
  await assert.rejects(change(0, []), error => error.code === 'policy-version-conflict');
  assert.deepEqual(await state(), added);

  assert.deepEqual(await change(1, [...usable, other], admin), { saved: true, reactivated: true });
  assert.deepEqual(await change(2, usable), { saved: true, reactivated: true }, 'editors can remove data they lack');
  const removed = await state();
  assert.deepEqual(removed.limits, usable);
  assert.deepEqual(removed.activations.at(-1), { revision: agent.revision, scope: usable, live: true });
  assert.equal(removed.activations.length, 4);

  assert.deepEqual(await change(3, usable), { saved: true, reactivated: false });
  assert.equal((await state()).activations.length, 4);
});
