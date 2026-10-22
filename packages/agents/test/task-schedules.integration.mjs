import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { initialBundleModels, initialModelMapping, modelBundleSchema } from '@tulipfarm/config';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createTableWithRows, tableDefinition, textField } from '../../tables/test/fixture.mjs';
import { createAgentSchedules } from '../src/schedules.ts';
import { createAgentTasks } from '../src/tasks.ts';
import { createTaskRuntime } from '../src/task-runtime.ts';
import { createModelRouteHealth } from '../src/model-health.ts';
import { createAgentExecutor } from '../src/executor.ts';
import { createWorkspaceSkills } from '../src/workspace-skills.ts';
import { grantAgentManager, savedTaskAgent } from './task-fixture.mjs';

const route = {
  id: 'schedule-test',
  modelId: 'claude-opus-5-5',
  provider: 'anthropic',
  deployment: 'claude-opus-5-5',
  location: 'test',
  adapterVersion: 1,
  qualification: 'local scripted protocol only',
  lifecycle: 'current',
  maxInputTokens: 100000,
  maxOutputTokens: 4096,
  boundedDecision: true,
};
const bundle = modelBundleSchema.parse({
  format: 1,
  id: 'schedule-test',
  mapping: {
    ...initialModelMapping,
    revision: 'schedule-test',
    families: initialModelMapping.families.filter(family => family.id === 'claude-opus'),
  },
  models: initialBundleModels,
  routes: [route],
});

test(
  'task schedules start one private sponsor-owned task at a time within the activation scope',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    let runtime;
    t.after(async () => {
      await runtime?.close();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../../apps/database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    const w = await db.create(await workspaceTableMigrations());
    runtime = createWorkspaceRuntime({
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 20,
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
    });
    const table = name => `"${w.names.schema}".${name}`;
    const user = randomUUID(),
      sponsor = randomUUID();
    await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
      sponsor,
      user,
    ]);
    const agent = await savedTaskAgent(db, w, runtime, user, sponsor);
    await grantAgentManager(db, w, agent.agentId, sponsor);
    const { tableId } = await createTableWithRows({
      db,
      workspace: w,
      runtime,
      definition: tableDefinition({ owningTeamId: agent.teamId, label: 'Leads', fields: [textField()] }),
    });
    await db.platform.query(
      `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
      [agent.teamId, tableId],
    );
    const scope = [{ assetId: tableId, permissions: ['table.row.read'] }];
    await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET scope=$2 WHERE id=$1`, [
      agent.activationId,
      JSON.stringify(scope),
    ]);
    await createAgentExecutor({ runtime }).configure(
      w.id,
      { kind: 'human', userId: w.userId, membershipId: w.membershipId },
      { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: scope },
    );
    const schedules = createAgentSchedules(runtime),
      tasks = createAgentTasks(runtime);
    const limits = { toolCalls: 5, activeMilliseconds: 60000, credits: 100 };
    const action = { kind: 'task', text: 'Summarize new leads', limits };
    const input = {
      id: randomUUID(),
      activationId: agent.activationId,
      action,
      trigger: { kind: 'interval', minutes: 60 },
      sponsorMembershipId: sponsor,
      historyAudience: [],
    };
    const scheduledTasks = async id =>
      (
        await db.platform.query(
          `SELECT id,owner_user_id,owner_membership_id,status,limits,scope FROM ${table('tf_agent_tasks')} WHERE schedule_id=$1 ORDER BY created_at,id`,
          [id],
        )
      ).rows;
    const forceDue = id =>
      db.platform.query(
        `UPDATE ${table('tf_agent_schedules')} SET next_run_at=now() - interval '1 minute' WHERE id=$1`,
        [id],
      );

    let first;
    await t.test('due starts the saved prompt as a pending task owned by the sponsor', async () => {
      assert.deepEqual(await schedules.save(w.id, user, agent.agentId, input), { saved: true });
      await forceDue(input.id);
      assert.deepEqual(await schedules.due(w.id), []);
      const created = await scheduledTasks(input.id);
      assert.equal(created.length, 1);
      first = created[0];
      assert.deepEqual(
        { ...first, id: undefined },
        { id: undefined, owner_user_id: user, owner_membership_id: sponsor, status: 'pending', limits, scope },
      );
      assert.deepEqual(
        (await tasks.history(w.id, user, first.id)).messages.map(message => [
          message.sequence,
          message.role,
          message.text,
          message.sources,
        ]),
        [[0, 'owner', 'Summarize new leads', []]],
      );
      assert.deepEqual(
        (await tasks.list(w.id, user)).tasks.map(task => task.id),
        [first.id],
      );
      assert.equal(
        (
          await db.platform.query(
            `SELECT count(*)::integer AS count FROM ${table('tf_agent_runs')} WHERE schedule_id=$1`,
            [input.id],
          )
        ).rows[0].count,
        0,
      );
    });

    await t.test(
      'a schedule waits for its open task, runs it to completion as the sponsor, then starts the next one',
      async () => {
        await forceDue(input.id);
        assert.deepEqual(await schedules.due(w.id), []);
        assert.equal((await scheduledTasks(input.id)).length, 1);
        const prompts = [];
        const infer = async (_resolution, request) => {
          prompts.push(JSON.parse(request.prompt).history.map(message => [message.role, message.text]));
          return {
            kind: 'success',
            decision: { kind: 'answer', text: 'Two new leads this week.' },
            actualModel: route.modelId,
            requestId: randomUUID(),
            usage: {
              kind: 'known',
              input: 10,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              cacheWrite5m: 0,
              cacheWrite1h: 0,
            },
          };
        };
        const model = {
          activeBundle: () => ({ bundle, activationRevision: 1 }),
          restrictions: () => ({ allowedProviders: ['anthropic'], allowedLocations: ['test'] }),
          trustedBundle: () => bundle,
          allowed: () => true,
          actualModelIds: () => [route.modelId],
          health: createModelRouteHealth(db.platform, () => 'schedule-test'),
          infer,
          budgetPicoUsd: () => '10000000000000',
          legacyFamily: () => 'claude-opus',
        };
        const engine = createTaskRuntime(runtime, model);
        for (let step = 0; step < 5 && (await tasks.read(w.id, user, first.id)).status === 'pending'; step++)
          await engine.process(w.id, first.id);
        assert.equal((await tasks.read(w.id, user, first.id)).status, 'completed');
        assert.deepEqual(prompts, [[['owner', 'Summarize new leads']]]);
        assert.deepEqual(
          (await tasks.history(w.id, user, first.id)).messages.map(message => [message.role, message.text]),
          [
            ['owner', 'Summarize new leads'],
            ['agent', 'Two new leads this week.'],
          ],
        );
        assert.deepEqual(
          (
            await db.platform.query(
              `SELECT kind,user_id,membership_id,schedule_id FROM ${table('tf_agent_runs')} WHERE task_id=$1`,
              [first.id],
            )
          ).rows,
          [{ kind: 'delegated', user_id: user, membership_id: sponsor, schedule_id: null }],
        );
        assert.deepEqual(await schedules.due(w.id), []);
        const created = await scheduledTasks(input.id);
        assert.deepEqual(
          created.map(task => task.status),
          ['completed', 'pending'],
        );
        assert.notEqual(created[1].id, first.id);
      },
    );

    await t.test('only the sponsor sees the latest scheduled task', async () => {
      const latest = (await scheduledTasks(input.id))[1];
      const [listed] = await schedules.list(w.id, user, agent.agentId);
      assert.deepEqual(listed.action, action);
      assert.deepEqual(listed.lastRun, { kind: 'task', taskId: latest.id, status: 'pending' });
      const [managed] = await schedules.list(w.id, w.userId, agent.agentId);
      assert.deepEqual(managed.action, action);
      assert.equal(managed.lastRun, null);
    });

    await t.test('task schedules run at most hourly and keep history private', async () => {
      await assert.rejects(
        schedules.save(w.id, user, agent.agentId, {
          ...input,
          id: randomUUID(),
          trigger: { kind: 'interval', minutes: 59 },
        }),
        error => error.code === 'task-schedule-interval' && error.status === 400,
      );
      await assert.rejects(
        schedules.save(w.id, user, agent.agentId, {
          ...input,
          id: randomUUID(),
          trigger: { kind: 'cron', expression: '*/30 * * * *', timezone: 'UTC' },
        }),
        error => error.code === 'task-schedule-interval' && error.status === 400,
      );
      await assert.rejects(
        schedules.save(w.id, user, agent.agentId, { ...input, id: randomUUID(), historyAudience: [w.membershipId] }),
        error => error.code === 'task-schedule-history-private' && error.status === 400,
      );
      await assert.rejects(
        schedules.save(w.id, user, agent.agentId, { ...input, action: { ...action, text: 'Different prompt' } }),
        error => error.code === 'schedule-identity-conflict',
      );
    });

    await t.test('calendar schedules store their cron time zone and advance to the next occurrence', async () => {
      const calendar = {
        ...input,
        id: randomUUID(),
        trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'Europe/London' },
      };
      await schedules.save(w.id, user, agent.agentId, calendar);
      assert.deepEqual(
        (await schedules.list(w.id, user, agent.agentId)).find(item => item.id === calendar.id)?.trigger,
        calendar.trigger,
      );
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT interval_minutes,cron_expression,timezone,next_run_at > now() AS upcoming FROM ${table('tf_agent_schedules')} WHERE id=$1`,
            [calendar.id],
          )
        ).rows[0],
        { interval_minutes: null, cron_expression: '0 9 * * 1', timezone: 'Europe/London', upcoming: true },
      );
      await forceDue(calendar.id);
      await schedules.due(w.id);
      assert.equal((await scheduledTasks(calendar.id)).length, 1);
      assert.equal(
        (
          await db.platform.query(
            `SELECT next_run_at > now() AS upcoming FROM ${table('tf_agent_schedules')} WHERE id=$1`,
            [calendar.id],
          )
        ).rows[0].upcoming,
        true,
      );
    });

    const paused = async id =>
      (
        await db.platform.query(
          `SELECT paused_at IS NOT NULL AS paused FROM ${table('tf_agent_schedules')} WHERE id=$1`,
          [id],
        )
      ).rows[0].paused;
    const pauseAudits = async id =>
      (
        await db.platform.query(
          `SELECT actor_id,operation FROM ${table('tf_audit_events')} WHERE subject_id=$1 AND operation='agent.schedule.pause.sponsor-access-lost'`,
          [id],
        )
      ).rows;

    await t.test(
      'a manager changes the interval in place, the next run moves with it, and the change is audited',
      async () => {
        const edited = { ...input, id: randomUUID(), trigger: { kind: 'interval', minutes: 120 } };
        await schedules.save(w.id, user, agent.agentId, edited);
        const minutesUntilNext = async () =>
          Number(
            (
              await db.platform.query(
                `SELECT round(extract(epoch FROM next_run_at - now()) / 60) AS minutes FROM ${table('tf_agent_schedules')} WHERE id=$1`,
                [edited.id],
              )
            ).rows[0].minutes,
          );
        const triggerAudits = async () =>
          (
            await db.platform.query(
              `SELECT actor_id FROM ${table('tf_audit_events')} WHERE operation='agent.schedule.trigger' AND subject_id=$1`,
              [edited.id],
            )
          ).rows;
        await db.platform.query(
          `UPDATE ${table('tf_agent_schedules')} SET next_run_at=now() + interval '100 minutes' WHERE id=$1`,
          [edited.id],
        );

        assert.deepEqual(
          await schedules.save(w.id, user, agent.agentId, { ...edited, trigger: { kind: 'interval', minutes: 60 } }),
          { saved: true },
        );
        assert.ok((await minutesUntilNext()) >= 59);
        assert.deepEqual(
          await schedules.save(w.id, user, agent.agentId, { ...edited, trigger: { kind: 'interval', minutes: 1440 } }),
          { saved: true },
        );
        assert.ok((await minutesUntilNext()) >= 1439);
        const listed = (await schedules.list(w.id, user, agent.agentId)).find(item => item.id === edited.id);
        assert.deepEqual(
          { trigger: listed.trigger, action: listed.action, revoked: listed.revoked },
          { trigger: { kind: 'interval', minutes: 1440 }, action, revoked: false },
        );
        assert.deepEqual(await triggerAudits(), [{ actor_id: sponsor }, { actor_id: sponsor }]);

        await schedules.save(w.id, user, agent.agentId, { ...edited, trigger: { kind: 'interval', minutes: 1440 } });
        assert.equal((await triggerAudits()).length, 2);
        await db.platform.query(
          `UPDATE ${table('tf_agent_schedules')} SET next_run_at=now() + interval '30 minutes' WHERE id=$1`,
          [edited.id],
        );
        await schedules.save(w.id, user, agent.agentId, { ...edited, trigger: { kind: 'interval', minutes: 60 } });
        assert.ok((await minutesUntilNext()) >= 59);

        await forceDue(edited.id);
        await schedules.save(w.id, user, agent.agentId, { ...edited, trigger: { kind: 'interval', minutes: 120 } });
        assert.ok((await minutesUntilNext()) >= 119);
        const nextRunAt = async () =>
          (
            await db.platform.query(`SELECT next_run_at FROM ${table('tf_agent_schedules')} WHERE id=$1`, [edited.id])
          ).rows[0].next_run_at.toISOString();
        const rescheduled = await nextRunAt();

        await assert.rejects(
          schedules.save(w.id, user, agent.agentId, { ...edited, trigger: { kind: 'interval', minutes: 59 } }),
          error => error.code === 'task-schedule-interval',
        );
        await schedules.revoke(w.id, user, agent.agentId, edited.id);
        await assert.rejects(
          schedules.save(w.id, user, agent.agentId, { ...edited, trigger: { kind: 'interval', minutes: 60 } }),
          error => error.code === 'schedule-identity-conflict',
        );
        assert.equal(await nextRunAt(), rescheduled);
      },
    );

    await t.test(
      'completed history permits starts; active capacity skips visibly and recovers next occurrence',
      async () => {
        const limited = { ...input, id: randomUUID() };
        await schedules.save(w.id, user, agent.agentId, limited);
        await forceDue(limited.id);
        await db.platform.query(
          `INSERT INTO ${table('tf_agent_tasks')} (id,owner_user_id,owner_membership_id,agent_id,activation_id,definition_revision,skills,scope,limits,flow_id,status) SELECT gen_random_uuid(),$1,$2,$3,$4,$5,'[]','[]','{}',gen_random_uuid(),'completed' FROM generate_series(1,1000)`,
          [user, sponsor, agent.agentId, agent.activationId, agent.revision],
        );
        assert.deepEqual(await schedules.due(w.id), []);
        const [started] = await scheduledTasks(limited.id);
        assert.equal(started.status, 'pending');
        const listed = async who =>
          (await schedules.list(w.id, who, agent.agentId)).find(item => item.id === limited.id).lastRun;
        assert.deepEqual(await listed(user), { kind: 'task', taskId: started.id, status: 'pending' });
        await db.platform.query(`UPDATE ${table('tf_agent_tasks')} SET status='completed' WHERE id=$1`, [started.id]);
        await db.platform.query(
          `UPDATE ${table('tf_agent_tasks')} SET status='paused' WHERE owner_membership_id=$1 AND schedule_id IS NULL`,
          [sponsor],
        );
        await forceDue(limited.id);
        assert.deepEqual(await schedules.due(w.id), []);
        assert.equal((await scheduledTasks(limited.id)).length, 1);
        assert.deepEqual(await listed(user), { kind: 'skipped', reason: 'task-limit' });
        assert.equal(await listed(w.userId), null);
        assert.equal(await paused(limited.id), false);
        assert.equal(
          (
            await db.platform.query(
              `SELECT next_run_at > now() + interval '59 minutes' AS advanced FROM ${table('tf_agent_schedules')} WHERE id=$1`,
              [limited.id],
            )
          ).rows[0].advanced,
          true,
        );
        const skips = async () =>
          (
            await db.platform.query(
              `SELECT actor_id FROM ${table('tf_audit_events')} WHERE subject_id=$1 AND operation='agent.schedule.skip.task-limit'`,
              [limited.id],
            )
          ).rows;
        assert.deepEqual(await skips(), [{ actor_id: sponsor }]);
        await schedules.due(w.id);
        assert.equal((await skips()).length, 1);
        await db.platform.query(
          `UPDATE ${table('tf_agent_tasks')} SET status='completed' WHERE owner_membership_id=$1 AND schedule_id IS NULL`,
          [sponsor],
        );
        await forceDue(limited.id);
        await schedules.due(w.id);
        const recovered = await scheduledTasks(limited.id);
        assert.equal(recovered.length, 2);
        assert.deepEqual(await listed(user), { kind: 'task', taskId: recovered[1].id, status: 'pending' });
        await db.platform.query(
          `DELETE FROM ${table('tf_agent_tasks')} WHERE owner_membership_id=$1 AND schedule_id IS NULL`,
          [sponsor],
        );
        await db.platform.query(`UPDATE ${table('tf_agent_schedules')} SET revoked_at=now() WHERE id=$1`, [limited.id]);
      },
    );

    await t.test('a disabled reviewed procedure pauses the schedule without a task', async () => {
      const skills = createWorkspaceSkills(runtime),
        skillId = randomUUID();
      const saved = await skills.save(w.id, user, skillId, {
        requestId: randomUUID(),
        expectedVersion: 0,
        definition: {
          name: 'Lead summary',
          description: 'Summarize new leads for review.',
          instructions: 'Summarize only new leads.',
        },
      });
      const reviewed = await skills.review(w.id, user, skillId, {
        requestId: randomUUID(),
        expectedVersion: 1,
        revision: saved.savedRevision,
      });
      const procedural = await agent.activate([{ id: skillId, revision: saved.savedRevision }]);
      const withSkill = { ...input, id: randomUUID(), activationId: procedural.activationId };
      await schedules.save(w.id, user, agent.agentId, withSkill);
      await forceDue(withSkill.id);
      await skills.setEnabled(w.id, user, skillId, {
        requestId: randomUUID(),
        expectedVersion: reviewed.version,
        enabled: false,
      });
      assert.deepEqual(await schedules.due(w.id), []);
      assert.equal(await paused(withSkill.id), true);
      assert.deepEqual(await scheduledTasks(withSkill.id), []);
    });

    await t.test(
      'a sponsor who loses scope access pauses with a manager-visible reason and can be replaced',
      async () => {
        const scoped = { ...input, id: randomUUID() };
        await schedules.save(w.id, user, agent.agentId, scoped);
        await forceDue(scoped.id);
        await db.platform.query(`DELETE FROM ${table('tf_grants')} WHERE team_id=$1 AND asset_id=$2`, [
          agent.teamId,
          tableId,
        ]);
        assert.deepEqual(await schedules.due(w.id), []);
        assert.equal(await paused(scoped.id), true);
        assert.deepEqual(await scheduledTasks(scoped.id), []);
        assert.deepEqual(
          (await schedules.list(w.id, w.userId, agent.agentId)).find(item => item.id === scoped.id).pauseReason,
          'sponsor-access-lost',
        );
        assert.deepEqual(await pauseAudits(scoped.id), [
          { actor_id: 'system:agent-schedule-sweep', operation: 'agent.schedule.pause.sponsor-access-lost' },
        ]);
        assert.deepEqual(await schedules.due(w.id), []);
        assert.equal((await pauseAudits(scoped.id)).length, 1);
        await db.platform.query(
          `INSERT INTO ${table('tf_grants')} (team_id,asset_id,permission) VALUES ($1,$2,'table.row.read')`,
          [agent.teamId, tableId],
        );
        await db.platform.query(`INSERT INTO ${table('tf_member_teams')} (membership_id,team_id) VALUES ($1,$2)`, [
          w.membershipId,
          agent.teamId,
        ]);
        assert.deepEqual(
          await schedules.save(w.id, w.userId, agent.agentId, { ...scoped, sponsorMembershipId: w.membershipId }),
          { saved: true },
        );
        const resumed = (await schedules.list(w.id, w.userId, agent.agentId)).find(item => item.id === scoped.id);
        assert.deepEqual(
          {
            paused: resumed.paused,
            pauseReason: resumed.pauseReason,
            sponsorMembershipId: resumed.sponsorMembershipId,
          },
          { paused: false, pauseReason: null, sponsorMembershipId: w.membershipId },
        );

        const invoked = { ...input, id: randomUUID() };
        await schedules.save(w.id, user, agent.agentId, invoked);
        await forceDue(invoked.id);
        await db.platform.query(`DELETE FROM ${table('tf_agent_grants')} WHERE agent_id=$1 AND permission='invoke'`, [
          agent.agentId,
        ]);
        assert.deepEqual(await schedules.due(w.id), []);
        assert.equal(await paused(invoked.id), true);
        assert.deepEqual(await scheduledTasks(invoked.id), []);

        await db.platform.query(
          `INSERT INTO ${table('tf_agent_grants')} (agent_id,team_id,permission) VALUES ($1,$2,'invoke')`,
          [agent.agentId, agent.teamId],
        );
        const removed = { ...input, id: randomUUID() };
        await schedules.save(w.id, user, agent.agentId, removed);
        await db.platform.query(`UPDATE ${table('tf_memberships')} SET removed_at=clock_timestamp() WHERE id=$1`, [
          sponsor,
        ]);
        assert.deepEqual(await schedules.due(w.id), []);
        assert.equal(await paused(removed.id), true);
        assert.deepEqual(
          (await schedules.list(w.id, w.userId, agent.agentId)).find(item => item.id === removed.id).pauseReason,
          'sponsor-access-lost',
        );
        assert.deepEqual(await pauseAudits(removed.id), [
          { actor_id: 'system:agent-schedule-sweep', operation: 'agent.schedule.pause.sponsor-access-lost' },
        ]);
      },
    );
  },
);
