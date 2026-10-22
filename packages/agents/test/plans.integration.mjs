import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { fixture, connect, denied } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAgentPlans } from '../src/plans.ts';
import { AgentPlanError, PlanGraphError } from '../src/plan-contracts.ts';
import { savedTaskAgent } from './task-fixture.mjs';

const planError = code => error => error instanceof AgentPlanError && error.code === code;
const graphError = code => error => error instanceof PlanGraphError && error.code === code;
const states = view => Object.fromEntries(view.tasks.map(task => [task.key, task.state]));

test(
  'chat plans persist atomic outlines, versioned updates, worker scope and chat audiences',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    let runtime, client;
    t.after(async () => {
      await client?.end();
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
      resolveCredential: async () => ({ workspaceId: w.id, generation: 1, connectionString: db.login(w) }),
    });
    const table = name => `"${w.names.schema}".${name}`;
    const [starter, viewer, stranger] = [randomUUID(), randomUUID(), randomUUID()];
    const [starterMember, viewerMember, strangerMember] = [randomUUID(), randomUUID(), randomUUID()];
    await db.platform.query(
      `INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member'),($3,$4,'member'),($5,$6,'member')`,
      [starterMember, starter, viewerMember, viewer, strangerMember, stranger],
    );
    const privateChat = randomUUID(),
      projectChat = randomUUID(),
      projectId = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_projects')} (id,name,creator_membership_id) VALUES ($1,'Launch',$2)`,
      [projectId, starterMember],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_project_members')} (project_id,membership_id,role) VALUES ($1,$2,'manager'),($1,$3,'member')`,
      [projectId, starterMember, viewerMember],
    );
    await db.platform.query(
      `INSERT INTO ${table('tf_conversations')} (id,owner_user_id,owner_membership_id,project_id) VALUES ($1,$3,$4,NULL),($2,$3,$4,$5)`,
      [privateChat, projectChat, starter, starterMember, projectId],
    );
    const plans = createAgentPlans(runtime);

    const outline = {
      title: 'Build a waitlist',
      brief: 'A single page that collects sign-ups.',
      specialists: [
        {
          key: 'frontend-dev',
          name: 'Frontend specialist',
          role: 'Builds the page',
          instructions: 'Build the page and verify it.',
          tools: ['web.search'],
        },
      ],
      tasks: [
        { key: 'build', kind: 'group', title: 'Build' },
        {
          key: 'frontend',
          parent: 'build',
          title: 'Frontend',
          assignee: { kind: 'specialist', specialist: 'frontend-dev' },
        },
        { key: 'backend', parent: 'build', kind: 'group', order: 'serial', title: 'Backend' },
        { key: 'data-shape', parent: 'backend', title: 'Data shape' },
        { key: 'reads', parent: 'backend', title: 'Reads' },
        { key: 'integration', title: 'Integration', dependsOn: ['build'], criteria: ['Sign-ups reach the table'] },
        { key: 'qa', title: 'QA', dependsOn: ['integration'] },
      ],
    };
    const requestId = randomUUID();
    const created = await plans.create(w.id, starter, privateChat, requestId, outline);
    assert.deepEqual(await plans.create(w.id, starter, privateChat, requestId, outline), created);
    await assert.rejects(
      plans.create(w.id, starter, privateChat, requestId, { ...outline, title: 'Other' }),
      planError('idempotency-conflict'),
    );
    await assert.rejects(plans.create(w.id, starter, privateChat, randomUUID(), outline), planError('plan-open'));
    await assert.rejects(plans.create(w.id, stranger, privateChat, randomUUID(), outline), AccessDenied);
    await assert.rejects(
      plans.create(w.id, starter, projectChat, randomUUID(), {
        ...outline,
        tasks: [
          { key: 'a', title: 'A', dependsOn: ['b'] },
          { key: 'b', title: 'B', dependsOn: ['a'] },
        ],
      }),
      graphError('dependency-cycle'),
    );

    let view = await plans.read(w.id, starter, created.id);
    assert.equal(view.canControl, true);
    assert.equal(view.counts.total, 5);
    assert.deepEqual(states(view), {
      build: 'pending',
      frontend: 'ready',
      backend: 'pending',
      'data-shape': 'ready',
      reads: 'pending',
      integration: 'pending',
      qa: 'pending',
    });
    assert.deepEqual(view.tasks.find(task => task.key === 'integration').dependsOn, ['build']);
    assert.deepEqual(view.tasks.find(task => task.key === 'frontend').assignee, {
      kind: 'specialist',
      specialist: 'frontend-dev',
      name: 'Frontend specialist',
    });
    assert.equal(view.tasks.find(task => task.key === 'backend').summary.counts.total, 2);
    assert.equal(
      JSON.stringify(view).includes('Build the page and verify it.'),
      false,
      'specialist instructions stay out of the projection',
    );
    await assert.rejects(plans.read(w.id, stranger, created.id), AccessDenied);
    assert.deepEqual(
      (await plans.list(w.id, starter, privateChat)).map(item => item.id),
      [created.id],
    );

    const add = { op: 'add', task: { key: 'api', parent: 'build', title: 'API' } };
    await assert.rejects(
      plans.update(w.id, starter, created.id, randomUUID(), { expectedVersion: 7, mutations: [add] }),
      planError('version-conflict'),
    );
    const updateId = randomUUID();
    const updated = await plans.update(w.id, starter, created.id, updateId, { expectedVersion: 0, mutations: [add] });
    assert.deepEqual(updated, { id: created.id, version: 1, added: ['api'], yielded: false });
    assert.deepEqual(
      await plans.update(w.id, starter, created.id, updateId, { expectedVersion: 0, mutations: [add] }),
      updated,
    );
    view = await plans.read(w.id, starter, created.id);
    assert.equal(view.version, 1);
    assert.equal(states(view).api, 'ready');

    await db.platform.query(
      `UPDATE ${table('tf_agent_plan_tasks')} SET state='running' WHERE plan_id=$1 AND key='frontend'`,
      [created.id],
    );
    const subtask = key => ({ op: 'add', task: { key, parent: 'frontend', title: key } });
    await assert.rejects(
      plans.update(w.id, starter, created.id, randomUUID(), { expectedVersion: 1, mutations: [subtask('form')] }),
      graphError('settled-prerequisite'),
    );
    await assert.rejects(
      plans.update(
        w.id,
        starter,
        created.id,
        randomUUID(),
        { expectedVersion: 1, mutations: [{ op: 'cancel', key: 'qa', reason: 'No' }] },
        { kind: 'worker', task: 'frontend' },
      ),
      graphError('outside-scope'),
    );
    const yielded = await plans.update(
      w.id,
      starter,
      created.id,
      randomUUID(),
      { expectedVersion: 1, mutations: [subtask('form'), subtask('styles')] },
      { kind: 'worker', task: 'frontend' },
    );
    assert.deepEqual(yielded, { id: created.id, version: 2, added: ['form', 'styles'], yielded: true });
    view = await plans.read(w.id, starter, created.id);
    assert.deepEqual([states(view).frontend, states(view).form, states(view).styles], ['pending', 'ready', 'ready']);
    assert.equal(
      (
        await db.platform.query(`SELECT count(*)::int AS n FROM ${table('tf_agent_plan_events')} WHERE plan_id=$1`, [
          created.id,
        ])
      ).rows[0].n,
      3,
    );
    const event = (
      await db.platform.query(
        `SELECT actor, changes FROM ${table('tf_agent_plan_events')} WHERE plan_id=$1 AND version=2`,
        [created.id],
      )
    ).rows[0];
    assert.equal(event.actor, 'worker:frontend');
    assert.ok(
      event.changes.some(change => change.key === 'frontend' && change.from === 'running' && change.to === 'pending'),
    );

    const agent = await savedTaskAgent(db, w, runtime, starter, starterMember, [], ['rows.list']);
    await assert.rejects(
      plans.update(w.id, starter, created.id, randomUUID(), {
        expectedVersion: 2,
        mutations: [{ op: 'assign', key: 'reads', assignee: { kind: 'agent', agentId: randomUUID() } }],
      }),
      AccessDenied,
    );
    await plans.update(w.id, starter, created.id, randomUUID(), {
      expectedVersion: 2,
      mutations: [{ op: 'assign', key: 'reads', assignee: { kind: 'agent', agentId: agent.agentId } }],
    });
    view = await plans.read(w.id, starter, created.id);
    assert.deepEqual(view.tasks.find(task => task.key === 'reads').assignee, {
      kind: 'agent',
      agentId: agent.agentId,
      name: 'Private assistant',
    });

    const shared = await plans.create(w.id, starter, projectChat, randomUUID(), {
      title: 'Shared',
      tasks: [{ key: 'one', title: 'One' }],
    });
    const viewed = await plans.read(w.id, viewer, shared.id);
    assert.equal(viewed.canControl, false);
    assert.equal(viewed.tasks.length, 1);
    await assert.rejects(
      plans.update(w.id, viewer, shared.id, randomUUID(), {
        expectedVersion: 0,
        mutations: [{ op: 'retry', key: 'one' }],
      }),
      planError('not-starter'),
    );
    await assert.rejects(
      plans.control(w.id, viewer, shared.id, { requestId: randomUUID(), action: 'stop', expectedVersion: 0 }),
      planError('not-starter'),
    );
    assert.equal(viewed.tasks[0].waitingTaskId, null);
    await assert.rejects(plans.read(w.id, stranger, shared.id), AccessDenied);
    await db.platform.query(
      `UPDATE ${table('tf_project_members')} SET removed_at=clock_timestamp() WHERE project_id=$1 AND membership_id=$2`,
      [projectId, viewerMember],
    );
    await assert.rejects(plans.read(w.id, viewer, shared.id), AccessDenied);
    await db.platform.query(`UPDATE ${table('tf_conversations')} SET deleted_at=clock_timestamp() WHERE id=$1`, [
      projectChat,
    ]);
    await assert.rejects(plans.read(w.id, starter, shared.id), AccessDenied);

    client = await connect(db.login(w));
    await client.query(`SET search_path TO "${w.names.schema}"`);
    await denied(client, `UPDATE tf_agent_plan_specialists SET definition='{}' WHERE plan_id=$1`, [created.id]);
    await denied(client, `UPDATE tf_agent_plan_tasks SET key='renamed' WHERE plan_id=$1`, [created.id]);
    await denied(client, `UPDATE tf_agent_plans SET starter_membership_id=$2 WHERE id=$1`, [created.id, viewerMember]);
    await denied(client, `DELETE FROM tf_agent_plan_tasks WHERE plan_id=$1`, [created.id]);
    await denied(client, `UPDATE tf_agent_plan_events SET changes='[]' WHERE plan_id=$1`, [created.id]);
  },
);
