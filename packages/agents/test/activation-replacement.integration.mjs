import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentStore } from '../src/store.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskApprovals } from '../src/task-approvals.ts';
import { savedTaskAgent, seedExecution } from './task-fixture.mjs';

test('activation replacement swaps new admissions without changing running tasks', { timeout: 60000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  const w = await db.create(await workspaceTableMigrations());
  const table = name => `"${w.names.schema}".${name}`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async workspaceId => ({ workspaceId, generation: 1, connectionString: db.login(w) }),
  });
  const member = randomUUID(),
    user = randomUUID();
  await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
    member,
    user,
  ]);
  const manager = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  const reader = { kind: 'human', userId: user, membershipId: member };
  const agent = await savedTaskAgent(db, w, runtime, user, member, [], ['tables.list']);
  await seedExecution(db, w, agent.agentId, [agent.teamId], []);
  const store = createAgentStore(runtime);
  const tasks = createAgentTasks(runtime);
  const start = activationId =>
    tasks.start(w.id, user, {
      requestId: randomUUID(),
      agentId: agent.agentId,
      text: 'Read my tables.',
      ...(activationId ? { activationId } : {}),
    });
  const running = await start(agent.activationId);
  const continuing = await start(agent.activationId);
  const run = await createTaskApprovals(runtime).bindRun(w.id, user, running.id, { generation: 0 });
  const saved = await agent.activate();
  const before = async () =>
    (
      await db.platform.query(
        `SELECT id,definition_revision,scope,revoked_at,superseded_by_activation_id,superseded_at
    FROM ${table('tf_agent_activations')} WHERE agent_id=$1 ORDER BY activated_at,id`,
        [agent.agentId],
      )
    ).rows;
  assert.equal((await before()).length, 2, 'direct activation still keeps older activations');
  const savedRevision = (
    await db.platform.query(`SELECT saved_revision FROM ${table('tf_agents')} WHERE id=$1`, [agent.agentId])
  ).rows[0].saved_revision;
  const input = {
    agentId: agent.agentId,
    requestId: randomUUID(),
    revision: saved.revision,
    scope: [],
    expectedSavedRevision: savedRevision,
    expectedPolicyVersion: 1,
    expectedActivationIds: [agent.activationId, saved.activationId],
  };
  await t.test('non-managers cannot replace, and stale expectations change nothing', async () => {
    const snapshot = await before();
    await assert.rejects(store.replaceActivation(w.id, reader, input), AccessDenied);
    for (const change of [
      { expectedSavedRevision: '0'.repeat(40) },
      { expectedPolicyVersion: 0 },
      { expectedActivationIds: [agent.activationId] },
      { revision: agent.revision },
      { scope: [{ assetId: randomUUID(), permissions: ['table.row.read'] }] },
    ]) {
      await assert.rejects(
        store.replaceActivation(w.id, manager, { ...input, ...change }),
        error => error.status === 409,
      );
      assert.deepEqual(await before(), snapshot);
    }
  });
  let replacement;
  await t.test('concurrent replacements have one winner and one conflict', async () => {
    const outcomes = await Promise.allSettled([
      store.replaceActivation(w.id, manager, input),
      store.replaceActivation(w.id, manager, { ...input, requestId: randomUUID() }),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);
    replacement = outcomes.find(result => result.status === 'fulfilled').value.activationId;
    const rows = await before();
    assert.equal(rows.length, 3);
    for (const row of rows.filter(row => row.id !== replacement)) {
      assert.equal(row.superseded_by_activation_id, replacement);
      assert.ok(row.superseded_at);
      assert.equal(row.revoked_at, null);
    }
    assert.deepEqual(rows.find(row => row.id === replacement).scope, []);
  });
  await t.test('new tasks follow old pins and default to the new definition', async () => {
    for (const pin of [agent.activationId, saved.activationId, undefined]) {
      const task = await tasks.read(w.id, user, (await start(pin)).id);
      assert.equal(task.activationId, replacement);
      assert.equal(task.definitionRevision, saved.revision);
    }
  });
  await t.test('running tasks retain their old definition and tool authority', async () => {
    const task = await tasks.read(w.id, user, running.id);
    assert.equal(task.activationId, agent.activationId);
    assert.equal(task.definitionRevision, agent.revision);
    await store.queueCall(w.id, reader, {
      runId: run.runId,
      callId: randomUUID(),
      sequence: 0,
      call: { tool: 'tables.list' },
    });
  });
  await t.test(
    'replacement retries are idempotent and old workflow pins follow more than one replacement',
    async () => {
      const next = { ...input, requestId: randomUUID(), expectedActivationIds: [replacement] };
      const result = await store.replaceActivation(w.id, manager, next);
      assert.deepEqual(await store.replaceActivation(w.id, manager, next), result);
      await assert.rejects(
        store.replaceActivation(w.id, manager, { ...next, expectedPolicyVersion: 0 }),
        error => error.status === 409,
      );
      await assert.rejects(
        store.replaceActivation(w.id, manager, { ...next, expectedActivationIds: [] }),
        error => error.status === 409,
      );
      replacement = result.activationId;
      const task = await tasks.read(w.id, user, (await start(agent.activationId)).id);
      assert.equal(task.activationId, replacement);
      const { runId } = await store.startDelegated(w.id, reader, { activationId: agent.activationId, scope: [] });
      assert.equal(
        (await db.platform.query(`SELECT activation_id FROM ${table('tf_agent_runs')} WHERE id=$1`, [runId])).rows[0]
          .activation_id,
        replacement,
      );
    },
  );
  await t.test(
    'revocation still stops original running authority and does not fall back to superseded versions',
    async () => {
      await store.revokeActivation(w.id, manager, { agentId: agent.agentId, activationId: replacement });
      await assert.rejects(start(), AccessDenied);
      await assert.rejects(start(saved.activationId), AccessDenied);
      await tasks.pause(w.id, user, continuing.id, { expectedGeneration: 0 });
      await tasks.continueTask(w.id, user, continuing.id, {
        requestId: randomUUID(),
        expectedGeneration: 0,
        expectedSequence: 0,
        text: 'Keep using the original instructions.',
      });
      assert.equal((await tasks.read(w.id, user, continuing.id)).activationId, agent.activationId);
      await store.revokeActivation(w.id, manager, { agentId: agent.agentId, activationId: agent.activationId });
      await assert.rejects(
        store.queueCall(w.id, reader, {
          runId: run.runId,
          callId: randomUUID(),
          sequence: 1,
          call: { tool: 'tables.list' },
        }),
        AccessDenied,
      );
    },
  );
});
