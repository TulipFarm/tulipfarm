import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { Pool } from 'pg';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createAgentPlans } from '@tulipfarm/agents/plans';
import { createAuth } from '../src/auth.ts';
import { registerAgentPlans } from '../src/agent-plans.ts';

test(
  'plan routes show outlines to chat readers and let only the starter control the plan',
  { timeout: 120000 },
  async t => {
    const db = await fixture();
    let app, runtime, pool;
    t.after(async () => {
      await app?.close();
      await runtime?.close();
      await pool?.end();
      await db.close();
    });
    await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
    pool = new Pool({ connectionString: db.connectionString, options: '-c search_path=app' });
    let link;
    const auth = createAuth(
      pool,
      async data => {
        link = data.url;
      },
      async () => {},
    );
    async function login() {
      await auth.api.signInMagicLink({
        headers: new Headers({ origin: 'http://localhost:5173' }),
        body: { email: `${randomUUID()}@example.com`, name: 'Planner' },
      });
      const result = await auth.handler(new Request(link));
      const cookie = result.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ');
      const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
      return { cookie, userId: session.user.id };
    }
    const starter = await login(),
      viewer = await login(),
      outsider = await login();
    const workspace = await db.create(await workspaceTableMigrations(), { userId: starter.userId });
    runtime = createWorkspaceRuntime({
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    const s = `"${workspace.names.schema}"`,
      viewerMember = randomUUID(),
      projectId = randomUUID(),
      chatId = randomUUID();
    await db.platform.query(`UPDATE ${s}.tf_memberships SET role='member' WHERE id=$1`, [workspace.membershipId]);
    await db.platform.query(
      `INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member'),($3,$4,'member')`,
      [viewerMember, viewer.userId, randomUUID(), outsider.userId],
    );
    await db.platform.query(`INSERT INTO ${s}.tf_projects (id,name,creator_membership_id) VALUES ($1,'Launch',$2)`, [
      projectId,
      workspace.membershipId,
    ]);
    await db.platform.query(
      `INSERT INTO ${s}.tf_project_members (project_id,membership_id,role) VALUES ($1,$2,'manager'),($1,$3,'member')`,
      [projectId, workspace.membershipId, viewerMember],
    );
    await db.platform.query(
      `INSERT INTO ${s}.tf_conversations (id,owner_user_id,owner_membership_id,project_id) VALUES ($1,$2,$3,$4)`,
      [chatId, starter.userId, workspace.membershipId, projectId],
    );
    const created = await createAgentPlans(runtime).create(workspace.id, starter.userId, chatId, randomUUID(), {
      title: 'Build a waitlist',
      tasks: [
        { key: 'page', title: 'Page' },
        { key: 'qa', title: 'QA', dependsOn: ['page'] },
      ],
    });

    const woken = [];
    app = Fastify();
    await app.register(swagger, { openapi: { info: { title: 'Plans', version: '1' } } });
    await app.register(
      async routes =>
        registerAgentPlans(routes, {
          runtime,
          auth,
          wake: async (_workspace, planId) => {
            woken.push(planId);
          },
        }),
      { prefix: '/v1' },
    );
    await app.ready();
    for (const path of [
      '/v1/workspaces/{workspaceId}/conversations/{chatId}/plans',
      '/v1/workspaces/{workspaceId}/agent-plans/{planId}',
      '/v1/workspaces/{workspaceId}/agent-plans/{planId}/control',
    ])
      assert.ok(app.swagger().paths[path], path);

    const as = person => ({ cookie: person.cookie, origin: 'http://localhost:5173' });
    const read = person =>
      app.inject({ url: `/v1/workspaces/${workspace.id}/agent-plans/${created.id}`, headers: as(person) });
    const control = (person, payload) =>
      app.inject({
        method: 'POST',
        url: `/v1/workspaces/${workspace.id}/agent-plans/${created.id}/control`,
        headers: as(person),
        payload,
      });

    const list = await app.inject({
      url: `/v1/workspaces/${workspace.id}/conversations/${chatId}/plans`,
      headers: as(viewer),
    });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      list.json().plans.map(plan => [plan.id, plan.title, plan.counts.total]),
      [[created.id, 'Build a waitlist', 2]],
    );
    const viewed = await read(viewer);
    assert.equal(viewed.statusCode, 200);
    assert.equal(viewed.json().canControl, false);
    assert.equal((await read(starter)).json().canControl, true);
    assert.equal((await read(outsider)).statusCode, 404);
    assert.deepEqual((await read(outsider)).json(), { error: 'plan-not-found' });

    assert.deepEqual((await control(viewer, { requestId: randomUUID(), action: 'pause', expectedVersion: 0 })).json(), {
      error: 'not-starter',
    });
    assert.equal(
      (await control(starter, { requestId: randomUUID(), action: 'pause', expectedVersion: 9 })).statusCode,
      409,
    );
    assert.equal(
      (await control(starter, { requestId: randomUUID(), action: 'edit', expectedVersion: 0 })).statusCode,
      400,
    );
    assert.equal(
      (await control(starter, { requestId: randomUUID(), action: 'pause', expectedVersion: 0, mutations: [] }))
        .statusCode,
      400,
      'people cannot edit the outline through controls',
    );
    const paused = await control(starter, { requestId: randomUUID(), action: 'pause', expectedVersion: 0 });
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.json().version, 1);
    assert.equal((await read(viewer)).json().pause, 'starter');
    const resumed = await control(starter, {
      requestId: randomUUID(),
      action: 'resume',
      expectedVersion: 1,
      budget: { toolCalls: 300, activeMilliseconds: 1800000, credits: 500 },
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal((await read(starter)).json().budget.credits, 500);
    assert.equal(
      (await control(starter, { requestId: randomUUID(), action: 'stop', expectedVersion: 2 })).statusCode,
      200,
    );
    assert.deepEqual(
      (await read(starter)).json().tasks.map(task => task.state),
      ['cancelled', 'cancelled'],
    );
    assert.deepEqual(
      (await control(starter, { requestId: randomUUID(), action: 'resume', expectedVersion: 3 })).json(),
      { error: 'plan-closed' },
    );
    assert.deepEqual(woken, [created.id, created.id, created.id]);
  },
);
