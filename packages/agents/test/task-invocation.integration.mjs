import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied, canAccessAsset, lockAuthorization, requireCurrentActor } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createTableWithRows, tableDefinition, textField, textValues } from '../../tables/test/fixture.mjs';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskApprovals } from '../src/task-approvals.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { createSavedAgentService } from '../src/saved-service.ts';
import { savedTaskAgent } from './task-fixture.mjs';
import { syntheticContinuity } from './continuity-fixture.mjs';

test('tasks require current human invocation teams including admins without changing non-task authority', async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
  const stream = await workspaceTableMigrations();
  const w = await db.create(stream),
    table = name => `"${w.names.schema}".${name}`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const admin = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const member = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
  await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
    member.membershipId,
    member.userId,
  ]);
  const agent = await savedTaskAgent(
    db,
    w,
    runtime,
    member.userId,
    member.membershipId,
    [],
    ['rows.get', 'skills.list'],
  );
  const executor = createAgentExecutor({ runtime }),
    tasks = createAgentTasks(runtime),
    approvals = createTaskApprovals(runtime);
  const recordId = randomUUID(),
    revision = 'a'.repeat(40),
    dataTeam = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_teams')} (id,name) VALUES ($1,'Agent data team')`, [dataTeam]);
  const value = textField('Value'),
    fieldId = value.id;
  const { tableId } = await createTableWithRows({
    db,
    workspace: w,
    runtime,
    revision,
    definition: tableDefinition({ owningTeamId: dataTeam, label: 'Protected records', fields: [value] }),
    records: [{ id: recordId, values: textValues(value, 'actual protected record') }],
  });
  await db.platform.query(
    `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$3,'table.row.read'),($2,$3,'table.row.read')`,
    [dataTeam, agent.teamId, tableId],
  );
  const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
  await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
    agent.activationId,
    JSON.stringify(scope),
  ]);
  await db.platform.query(
    `INSERT INTO ${table('tf_member_teams')} (membership_id,team_id,role) VALUES ($1,$2,'manager')`,
    [admin.membershipId, dataTeam],
  );
  await executor.configure(w.id, admin, {
    agentId: agent.agentId,
    version: 0,
    enabled: true,
    teamIds: [dataTeam],
    limits: scope,
  });
  const call = { tool: 'rows.get', tableId, recordId, expectedAppliedRevision: revision };
  const start = (actor, sources = []) =>
    tasks.start(w.id, actor.userId, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'Read protected record',
      scope,
      sources,
    });
  const select = actor =>
    db.platform.query(
      `INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [actor.membershipId, agent.teamId],
    );
  const unselect = actor =>
    db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`, [
      actor.membershipId,
      agent.teamId,
    ]);
  const grant = () =>
    db.platform.query(
      `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'invoke') ON CONFLICT DO NOTHING`,
      [agent.agentId, agent.teamId],
    );
  const revoke = () =>
    db.platform.query(`DELETE FROM ${table('tf_agent_grants')} WHERE agent_id=$1 AND permission='invoke'`, [
      agent.agentId,
    ]);
  const current = runId =>
    runtime.transaction(w.id, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      await requireCurrentActor(tx, { kind: 'agent', runId });
    });
  const queue = async (actor, runId, sequence = 0, tool = call) => {
    const callId = randomUUID();
    await executor.queueCall(w.id, actor, { runId, callId, sequence, call: tool });
    return { workspaceId: w.id, runId, callId };
  };
  t.beforeEach(async () => {
    await grant();
    await select(member);
    await unselect(admin);
    await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`, [
      admin.membershipId,
      dataTeam,
    ]);
  });

  await t.test(
    'unselected admin with zero memberships and the same identity demoted to member are denied',
    async () => {
      assert.equal(
        (
          await db.platform.query(`SELECT count(*)::int AS n FROM ${table('tf_member_teams')} WHERE membership_id=$1`, [
            admin.membershipId,
          ])
        ).rows[0].n,
        0,
      );
      for (const role of ['admin', 'member']) {
        await db.platform.query(`UPDATE ${table('tf_memberships')} SET role=$2 WHERE id=$1`, [
          admin.membershipId,
          role,
        ]);
        try {
          await assert.rejects(start(admin), AccessDenied);
        } finally {
          await db.platform.query(`UPDATE ${table('tf_memberships')} SET role='admin' WHERE id=$1`, [
            admin.membershipId,
          ]);
        }
      }
      console.log('VERIFIED unselected admin and ordinary member cannot start a task.');
    },
  );

  for (const actor of [member, admin])
    await t.test(
      `selected ${actor === admin ? 'admin' : 'ordinary member'} reads actual protected data then loses every task boundary on revocation`,
      async () => {
        await select(actor);
        const task = await start(actor),
          unbound = await start(actor);
        const { runId } = await approvals.bindRun(w.id, actor.userId, task.id, { generation: 0 });
        const completed = await queue(actor, runId);
        assert.equal(await executor.execute(completed), 'completed');
        assert.equal(
          (await executor.readResult(completed, actor)).result.values[fieldId].value,
          'actual protected record',
        );
        const pending = await queue(actor, runId, 1, { tool: 'skills.list' });
        for (const remove of [() => unselect(actor), revoke]) {
          await remove();
          await assert.rejects(start(actor), AccessDenied);
          await assert.rejects(approvals.bindRun(w.id, actor.userId, unbound.id, { generation: 0 }), AccessDenied);
          await assert.rejects(approvals.bindRun(w.id, actor.userId, task.id, { generation: 0 }), AccessDenied);
          await assert.rejects(current(runId), AccessDenied);
          await assert.rejects(queue(actor, runId, 2), AccessDenied);
          await assert.rejects(executor.readResult(completed, actor), AccessDenied);
          await assert.rejects(tasks.history(w.id, actor.userId, task.id), AccessDenied);
          await assert.rejects(tasks.checkSources(w.id, actor.userId, [], runId), AccessDenied);
          assert.equal(await executor.execute(pending), 'blocked');
          assert.equal((await tasks.read(w.id, actor.userId, task.id)).status, 'pending');
          assert.equal(
            (await tasks.list(w.id, actor.userId)).tasks.some(item => item.id === task.id),
            true,
          );
          await select(actor);
          await grant();
          assert.equal((await tasks.history(w.id, actor.userId, task.id)).messages[0].text, 'Read protected record');
        }
      },
    );

  await t.test('agent enrollment is not a human invocation grant and invocation is not data authority', async () => {
    await unselect(admin);
    await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
      admin.membershipId,
      dataTeam,
    ]);
    await assert.rejects(start(admin), AccessDenied);
    await db.platform.query(`DELETE FROM ${table('tf_member_teams')} WHERE membership_id=$1 AND team_id=$2`, [
      admin.membershipId,
      dataTeam,
    ]);
    await select(member);
    await db.platform.query(`DELETE FROM ${table('tf_grants')} WHERE team_id=$1 AND asset_id=$2`, [
      agent.teamId,
      tableId,
    ]);
    const task = await start(member),
      { runId } = await approvals.bindRun(w.id, member.userId, task.id, { generation: 0 });
    assert.equal(await executor.execute(await queue(member, runId)), 'blocked');
    await db.platform.query(
      `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
      [agent.teamId, tableId],
    );
  });

  await t.test(
    'revocation before inference blocks dispatch and revocation during inference blocks publication',
    async () => {
      await select(admin);
      const before = await start(admin);
      let dispatches = 0;
      const engine = createTaskRuntime(
        runtime,
        syntheticContinuity(() => {
          dispatches++;
          return { kind: 'answer', text: 'Authorized answer' };
        }),
      );
      await revoke();
      await engine.process(w.id, before.id);
      assert.equal(dispatches, 0);
      assert.equal((await tasks.read(w.id, admin.userId, before.id)).status, 'failed');
      await grant();
      const control = await start(admin);
      await engine.process(w.id, control.id);
      assert.equal(dispatches, 1);
      assert.equal((await tasks.history(w.id, admin.userId, control.id)).messages.at(-1).text, 'Authorized answer');
      const during = await start(admin);
      const revoked = createTaskRuntime(
        runtime,
        syntheticContinuity(async () => {
          await revoke();
          return { kind: 'answer', text: 'Must not publish' };
        }),
      );
      await revoked.process(w.id, during.id);
      assert.equal((await tasks.read(w.id, admin.userId, during.id)).status, 'failed');
      await grant();
      assert.deepEqual(
        (await tasks.history(w.id, admin.userId, during.id)).messages.map(message => message.text),
        ['Read protected record'],
      );
      await revoke();
      await assert.rejects(
        tasks.reopen(w.id, admin.userId, control.id, { requestId: randomUUID(), expectedGeneration: 0, text: 'Again' }),
        AccessDenied,
      );
      await assert.rejects(
        tasks.continueTask(w.id, admin.userId, during.id, {
          requestId: randomUUID(),
          expectedGeneration: 0,
          expectedSequence: 0,
          text: 'Try again',
        }),
        AccessDenied,
      );
      await grant();
    },
  );

  await t.test(
    'a task reference checks the referenced agent invocation even if the receiving agent is allowed',
    async () => {
      await select(admin);
      const source = await start(admin);
      await db.platform.query(`UPDATE ${table('tf_teams')} SET name='Original invokers' WHERE id=$1`, [agent.teamId]);
      const target = await savedTaskAgent(db, w, runtime, admin.userId, admin.membershipId, [], []);
      const input = {
        requestId: randomUUID(),
        agentId: target.agentId,
        text: 'Use previous task',
        sources: [{ kind: 'task', taskId: source.id, throughSequence: 0 }],
      };
      const linked = await tasks.start(w.id, admin.userId, input);
      assert.equal((await tasks.history(w.id, admin.userId, linked.id)).messages[0].text, 'Use previous task');
      await revoke();
      await assert.rejects(tasks.start(w.id, admin.userId, { ...input, requestId: randomUUID() }), AccessDenied);
      await assert.rejects(tasks.history(w.id, admin.userId, linked.id), AccessDenied);
      assert.equal((await tasks.read(w.id, admin.userId, linked.id)).status, 'pending');
      await grant();
    },
  );

  await t.test(
    'an unselected admin with only a manager grant configures sharing but cannot invoke or read history',
    async () => {
      await unselect(admin);
      const saved = createSavedAgentService(runtime);
      const policy = await saved.policy(w.id, admin.userId, agent.agentId);
      assert.equal(policy.enabled, true);
      assert.deepEqual(policy.enrollment, [dataTeam]);
      assert.deepEqual(policy.personGrants, [{ membershipId: admin.membershipId, permissions: ['manage'] }]);
      assert.deepEqual(
        await saved.updatePolicy(w.id, admin.userId, agent.agentId, {
          version: policy.version,
          owningTeamId: policy.owningTeamId,
          grants: policy.grants,
          personGrants: policy.personGrants,
        }),
        { saved: true },
      );
      await assert.rejects(
        executor.startDelegated(w.id, admin, { activationId: agent.activationId, scope }),
        AccessDenied,
      );
      await assert.rejects(
        executor.authorizeSchedule(w.id, admin, { activationId: agent.activationId, scope }),
        AccessDenied,
      );
      await select(member);
      const memberTask = await start(member),
        { runId: memberRun } = await approvals.bindRun(w.id, member.userId, memberTask.id, { generation: 0 });
      const memberCall = await queue(member, memberRun);
      assert.equal(await executor.execute(memberCall), 'completed');
      await assert.rejects(executor.readResult(memberCall, admin), AccessDenied);
      await assert.rejects(tasks.history(w.id, admin.userId, memberTask.id), AccessDenied);
      await assert.rejects(queue(admin, memberRun, 1), AccessDenied);
      await unselect(member);
      await assert.rejects(
        executor.startDelegated(w.id, member, { activationId: agent.activationId, scope }),
        AccessDenied,
      );
      await select(member);
      const ordinary = await executor.startDelegated(w.id, member, { activationId: agent.activationId, scope });
      const ids = await queue(member, ordinary.runId);
      assert.equal(await executor.execute(ids), 'completed');
      await unselect(member);
      await assert.rejects(executor.readResult(ids, member), AccessDenied);
      await select(member);
    },
  );

  await t.test('rejoining the workspace never inherits an old task or old membership grant', async () => {
    const task = await start(member),
      { runId } = await approvals.bindRun(w.id, member.userId, task.id, { generation: 0 });
    const ids = await queue(member, runId);
    assert.equal(await executor.execute(ids), 'completed');
    await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=now() WHERE id=$1`, [
      member.membershipId,
    ]);
    const rejoined = { ...member, membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'admin')`, [
      rejoined.membershipId,
      member.userId,
    ]);
    await assert.rejects(start(rejoined), AccessDenied);
    await select(rejoined);
    assert.equal((await start(rejoined)).status, 'pending');
    await assert.rejects(tasks.read(w.id, rejoined.userId, task.id), AccessDenied);
    await assert.rejects(approvals.bindRun(w.id, rejoined.userId, task.id, { generation: 0 }), AccessDenied);
    await assert.rejects(executor.readResult(ids, rejoined), AccessDenied);
    await assert.rejects(current(runId), AccessDenied);
    await assert.rejects(
      runtime.transaction(w.id, commonCompatibility, tx =>
        canAccessAsset(tx, { kind: 'agent', runId }, tableId, 'table.row.read'),
      ),
      AccessDenied,
    );
  });
});
