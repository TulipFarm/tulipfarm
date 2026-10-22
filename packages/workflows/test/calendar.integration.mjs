import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkflows } from '../src/service.ts';
import { activate } from './commands.fixture.mjs';
import { savedTaskAgent, grantAgentManager, seedExecution } from '../../agents/test/task-fixture.mjs';
import { createAgentSchedules } from '../../agents/src/schedules.ts';
import { createAgentTasks } from '../../agents/src/tasks.ts';

test(
  'personal calendar follows persist without sharing histories or bypassing current access',
  { timeout: 55000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    const w = await db.create(await workspaceTableMigrations()),
      table = name => qualified(w.names.schema, name);
    const user = randomUUID(),
      member = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      member,
      user,
    ]);
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const service = createWorkflows(runtime),
      id = randomUUID(),
      revision = randomUUID();
    const definition = {
      version: 1,
      name: 'Weekly review',
      trigger: { kind: 'interval', minutes: 60 },
      steps: [{ id: 'review', kind: 'human', prompt: 'Private decision', timeoutSeconds: 60 }],
    };
    await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
    await service.sponsorship(w.id, w.userId, id, {
      sponsorMembershipId: w.membershipId,
      historyAudience: [w.membershipId],
    });
    await activate(service, w.id, w.userId, id, revision, true);
    await db.platform.query(`UPDATE ${table('tf_workflows')} SET next_run_at='2030-01-07T09:00:00Z' WHERE id=$1`, [id]);
    const range = { from: '2030-01-07T00:00:00Z', to: '2030-01-08T00:00:00Z' };
    assert.equal((await service.calendar(w.id, w.userId, range)).workflows[0].occurrences.length, 15);
    assert.deepEqual((await service.calendar(w.id, user, range)).workflows, []);
    await assert.rejects(service.followCalendar(w.id, user, id, { following: true }), AccessDenied);
    await service.share(w.id, w.userId, id, { principal: { kind: 'person', id: member }, permissions: ['read'] });
    assert.deepEqual((await service.calendar(w.id, user, range)).workflows[0].occurrences, []);
    await service.followCalendar(w.id, user, id, { following: true });
    await service.followCalendar(w.id, user, id, { following: true });
    assert.equal((await createWorkflows(runtime).calendar(w.id, user, range)).workflows[0].following, true);
    assert.equal((await service.calendar(w.id, user, range)).workflows[0].occurrences.length, 15);
    assert.equal((await service.calendar(w.id, w.userId, range)).workflows[0].following, false);
    const runId = randomUUID();
    const run = await service.start(w.id, w.userId, id, { requestId: runId, input: '' });
    await service.advance({ workspaceId: w.id, runId: run.runId });
    assert.equal((await service.calendar(w.id, w.userId, range)).actions.length, 1);
    assert.deepEqual((await service.calendar(w.id, user, range)).actions, []);
    await service.followCalendar(w.id, user, id, { following: false });
    assert.deepEqual((await service.calendar(w.id, user, range)).workflows[0].occurrences, []);
    await service.followCalendar(w.id, user, id, { following: true });
    await service.share(w.id, w.userId, id, { principal: { kind: 'person', id: member }, permissions: [] });
    assert.deepEqual((await service.calendar(w.id, user, range)).workflows, []);

    const agent = await savedTaskAgent(db, w, runtime, user, member);
    await grantAgentManager(db, w, agent.agentId, member);
    await seedExecution(db, w, agent.agentId, [agent.teamId], []);
    const schedules = createAgentSchedules(runtime),
      scheduleId = randomUUID();
    await schedules.save(w.id, user, agent.agentId, {
      id: scheduleId,
      activationId: agent.activationId,
      trigger: { kind: 'interval', minutes: 60 },
      action: {
        kind: 'task',
        text: 'Private prompt',
        limits: { toolCalls: 5, activeMilliseconds: 60000, credits: 100 },
      },
      sponsorMembershipId: member,
      historyAudience: [],
    });
    await db.platform.query(
      `UPDATE ${table('tf_agent_schedules')} SET next_run_at='2030-01-07T09:00:00Z' WHERE id=$1`,
      [scheduleId],
    );
    const feed = await schedules.calendar(w.id, user, range);
    assert.equal(feed.schedules[0].times.length, 15);
    assert.equal(JSON.stringify(feed).includes('Private prompt'), false);
    assert.deepEqual((await schedules.calendar(w.id, w.userId, range)).schedules, []);
    await db.platform.query(`UPDATE ${table('tf_agent_schedules')} SET paused_at=now() WHERE id=$1`, [scheduleId]);
    assert.deepEqual((await schedules.calendar(w.id, user, range)).schedules, []);
    const tasks = createAgentTasks(runtime),
      taskIds = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (let index = 0; index < taskIds.length; index++)
      await db.platform.query(
        `INSERT INTO ${table('tf_agent_tasks')} (id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,skills,scope,limits,flow_id,status) VALUES ($1,$2,$3,$4,$5,$6,'[]','[]','{}',$7,$8)`,
        [
          taskIds[index],
          user,
          member,
          agent.agentId,
          agent.activationId,
          agent.revision,
          randomUUID(),
          index === 0 ? 'completed' : 'paused',
        ],
      );
    const first = await tasks.list(w.id, user, { state: 'active', limit: 1 });
    assert.deepEqual(
      first.tasks.map(task => task.id),
      [taskIds[1]],
    );
    assert.deepEqual(
      (await tasks.list(w.id, user, { state: 'active', limit: 1, after: first.nextCursor })).tasks.map(task => task.id),
      [taskIds[2]],
    );
  },
);
