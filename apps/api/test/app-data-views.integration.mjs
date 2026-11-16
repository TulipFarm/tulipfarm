import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { AccessDenied } from '@tulipfarm/access';
import { inTransaction } from '@tulipfarm/workspace-storage/provisioning';
import { commonCompatibility, createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createTableService } from '@tulipfarm/tables/service';
import { activateGeneration, createGeneration } from '@tulipfarm/tables/store';
import { createAuth } from '../src/auth.ts';
import { registerApps } from '../src/apps.ts';
import {
  connect,
  fixture,
  loadPlatformBaseline,
  markWorkspaceReady,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';

test('members create, share, approve and revoke an app data view over HTTP', { timeout: 60000 }, async t => {
  const flag = process.env.FEATURE_FLAG_APP_HOSTING;
  process.env.FEATURE_FLAG_APP_HOSTING = 'true';
  const db = await fixture(),
    cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await db.close();
    if (flag === undefined) delete process.env.FEATURE_FLAG_APP_HOSTING;
    else process.env.FEATURE_FLAG_APP_HOSTING = flag;
  });
  await loadPlatformBaseline(db.platform);
  for (const migration of ['0011_app_hostnames.sql', '0013_app_server_routes.sql'])
    await db.platform.query(await readFile(new URL(`../../database/migrations/${migration}`, import.meta.url), 'utf8'));
  const pool = new Pool({ connectionString: db.connectionString, options: '-c search_path=app', max: 4 });
  cleanup.push(() => pool.end());
  const deliveries = [];
  const auth = createAuth(
    pool,
    async ({ url }) => void deliveries.push(url),
    async () => {},
  );
  const signIn = async name => {
    await auth.api.signInMagicLink({
      headers: new Headers({ origin: 'http://localhost:5173' }),
      body: { email: `${randomUUID()}@example.test`, name },
    });
    const response = await auth.handler(new Request(deliveries.pop()));
    const cookie = response.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ');
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return { id: session.user.id, cookie };
  };
  const admin = await signIn('Admin'),
    lead = await signIn('Lead'),
    editor = await signIn('Editor'),
    reader = await signIn('Reader'),
    outsider = await signIn('Outsider');
  const workspace = await db.create(db.baseline, { userId: admin.id });
  await markWorkspaceReady(db.platform, workspace.id);
  const schema = `"${workspace.names.schema}"`;
  const membership = {
    lead: '6f1c2d4e-0000-4000-8000-000000000001',
    editor: '6f1c2d4e-0000-4000-8000-000000000002',
    reader: '6f1c2d4e-0000-4000-8000-000000000003',
  };
  for (const [id, user, role] of [
    [membership.lead, lead.id, 'admin'],
    [membership.editor, editor.id, 'member'],
    [membership.reader, reader.id, 'member'],
  ])
    await db.platform.query(`INSERT INTO ${schema}.tf_memberships(id,user_id,role) VALUES($1,$2,$3)`, [id, user, role]);
  const runtime = createWorkspaceRuntime({
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  cleanup.push(() => runtime.close());
  const app = Fastify();
  app.register(
    async routes =>
      registerApps(routes, {
        auth,
        runtime,
        platform: pool,
        start: async () => {},
        repositories: null,
        publisher: () => ({ remove: async () => {} }),
        builders: () => ({ command: undefined, server: undefined }),
        sitesDomain: 'apps.example.test',
      }),
    { prefix: '/v1' },
  );
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => app.close());
  const base = `/v1/workspaces/${workspace.id}/apps`;
  const http = async (who, method, path, body) => {
    const response = await fetch(`${address}${base}${path}`, {
      method,
      headers: {
        ...(who ? { cookie: who.cookie } : {}),
        origin: 'http://localhost:5173',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const team = randomUUID();
  await db.platform.query(`INSERT INTO ${schema}.tf_teams(id,name) VALUES($1,'Support')`, [team]);
  const field = (label, extra = {}) => ({
    id: randomUUID(),
    label,
    required: false,
    kind: 'text',
    maxLength: 200,
    ...extra,
  });
  const fields = {
    title: field('Title'),
    owner: field('Owner'),
    secret: field('Secret'),
    attachment: {
      id: randomUUID(),
      label: 'Attachment',
      required: false,
      kind: 'file',
      cardinality: 'one',
      access: 'independent',
    },
  };
  const definition = {
    formatVersion: 2,
    id: randomUUID(),
    owningTeamId: team,
    label: 'Posts',
    fields: Object.values(fields),
    uniqueKeys: [],
  };
  const revision = 'a'.repeat(40);
  const migration = await connect(db.login(workspace, 'migration'));
  cleanup.push(() => migration.end());
  await inTransaction(migration, async client => {
    await client.query(`SET LOCAL ROLE "${workspace.names.customOwner}"`);
    const created = await createGeneration({ client, schema: workspace.names.schema }, { definition, revision });
    await activateGeneration(
      { client, schema: workspace.names.schema },
      { generationId: created.id, expectedActiveGenerationId: null },
    );
  });
  const adminMembership = (
    await db.platform.query(`SELECT id FROM ${schema}.tf_memberships WHERE user_id=$1`, [admin.id])
  ).rows[0].id;
  const service = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
  await service.mutate(
    workspace.id,
    { kind: 'human', userId: admin.id, membershipId: adminMembership },
    {
      kind: 'create',
      tableId: definition.id,
      revision,
      recordId: randomUUID(),
      values: {
        [fields.title.id]: { kind: 'text', value: 'Hello' },
        [fields.owner.id]: { kind: 'text', value: 'ada' },
      },
    },
  );

  const created = await http(lead, 'POST', '', {
    requestId: '11111111-1111-4111-8111-111111111111',
    kind: 'public',
    title: 'Blog',
  });
  const appId = created.body.id;
  for (const [who, role] of [
    [membership.editor, 'edit'],
    [membership.reader, 'use'],
  ])
    assert.equal((await http(lead, 'PUT', `/${appId}/grants/member:${who}`, { role })).status, 200);
  const live = randomUUID();
  const build = randomUUID().replaceAll('-', '').padEnd(64, '0');
  await db.platform.query(
    `INSERT INTO ${schema}.tf_app_builds(id,app_id,commit,recipe,builder,status,manifest_digest,requested_by)
    VALUES($1,$2,$3,'{}','test','succeeded',$4,$5)`,
    [build, appId, 'c'.repeat(40), 'd'.repeat(64), membership.lead],
  );
  await db.platform.query(
    `INSERT INTO ${schema}.tf_app_releases(id,app_id,number,build_id,commit,manifest_digest,published_by)
    VALUES($1,$2,1,$3,$4,$5,$6)`,
    [live, appId, build, 'c'.repeat(40), 'd'.repeat(64), membership.lead],
  );
  await db.platform.query(
    `UPDATE ${schema}.tf_apps SET public_name='Blog', approval_state='approved', live_release_id=$2 WHERE id=$1`,
    [appId, live],
  );

  const view = {
    requestId: '22222222-2222-4222-8222-222222222222',
    tableId: definition.id,
    fieldIds: [fields.title.id],
    predicate: { all: [{ fieldId: fields.owner.id, op: 'eq', operand: { kind: 'parameter', name: 'owner' } }] },
    actions: ['read'],
  };
  const views = `/${appId}/data-views`;

  await t.test('only signed-in members with the right access reach the routes', async () => {
    assert.equal((await http(null, 'GET', views)).status, 401);
    assert.equal((await http(null, 'POST', views, view)).status, 401);
    assert.deepEqual(await http(outsider, 'GET', views), { status: 404, body: { error: 'not-found' } });
    assert.equal((await http(reader, 'GET', views)).status, 403);
    assert.equal((await http(reader, 'POST', views, view)).status, 403);
    assert.deepEqual((await http(admin, 'GET', views)).body, { views: [] });
  });

  await t.test('creating a view checks its fields and the creator’s table rights', async () => {
    assert.equal((await http(editor, 'POST', views, view)).status, 404);
    const ranged = await http(lead, 'POST', views, {
      ...view,
      requestId: randomUUID(),
      predicate: { all: [{ fieldId: fields.secret.id, op: 'gt', operand: { kind: 'parameter', name: 'after' } }] },
    });
    assert.equal(ranged.status, 422);
    assert.equal(ranged.body.failure.code, 'definition-invalid');
    assert.deepEqual(ranged.body.issues, [
      { path: fields.secret.id, message: 'A parameter may only test a field the view does not list for equality' },
    ]);
    const file = await http(lead, 'POST', views, {
      ...view,
      requestId: randomUUID(),
      fieldIds: [fields.attachment.id],
    });
    assert.equal(file.status, 422);
    assert.equal(file.body.issues[0].path, fields.attachment.id);
    assert.equal(
      (await http(lead, 'POST', views, { ...view, requestId: randomUUID(), fieldIds: [randomUUID()] })).status,
      422,
    );
    assert.equal((await http(lead, 'POST', views, { ...view, fieldIds: [] })).status, 400);
    assert.deepEqual((await http(lead, 'GET', views)).body, { views: [] });
  });

  let viewId;
  await t.test('a repeated request returns the same view and a changed one is refused', async () => {
    const first = await http(lead, 'POST', views, view);
    assert.equal(first.status, 201);
    viewId = first.body.id;
    assert.deepEqual(
      { ...first.body, createdAt: typeof first.body.createdAt },
      {
        id: viewId,
        tableId: definition.id,
        fieldIds: view.fieldIds,
        predicate: view.predicate,
        actions: ['read'],
        createdBy: membership.lead,
        createdAt: 'string',
        grants: [],
      },
    );
    assert.deepEqual(await http(lead, 'POST', views, view), first);
    assert.equal((await http(lead, 'POST', views, { ...view, actions: ['read', 'create'] })).status, 409);
  });

  const grant = () => `${views}/${viewId}/releases/${live}`;
  const appActor = { kind: 'app', appId, releaseId: live };
  const read = () =>
    service.listThroughView(workspace.id, appActor, { viewId, parameters: { owner: 'ada' }, query: { limit: 10 } });

  await t.test('a shared view serves the release only once an admin approves it', async () => {
    assert.equal((await http(reader, 'PUT', grant())).status, 403);
    assert.equal((await http(editor, 'PUT', grant())).status, 404);
    const shared = await http(lead, 'PUT', grant());
    assert.equal(shared.status, 200);
    assert.deepEqual(
      shared.body.grants.map(({ sharedAt, ...rest }) => ({ ...rest, sharedAt: typeof sharedAt })),
      [
        {
          releaseId: live,
          releaseNumber: 1,
          sharedBy: membership.lead,
          sharedAt: 'string',
          approvedBy: null,
          approvedAt: null,
          blockers: ['not-approved'],
        },
      ],
    );
    await assert.rejects(read(), AccessDenied);
    assert.equal((await http(editor, 'PUT', `${grant()}/approval`)).status, 403);
    const approved = await http(admin, 'PUT', `${grant()}/approval`);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.grants[0].approvedBy, adminMembership);
    assert.deepEqual(approved.body.grants[0].blockers, []);
    assert.deepEqual(
      (await read()).records.map(record => record.values),
      [{ [fields.title.id]: { kind: 'text', value: 'Hello' } }],
    );
  });

  await t.test('the list reports a grant that stops serving when its sharer loses access', async () => {
    await db.platform.query(`UPDATE ${schema}.tf_memberships SET role='member' WHERE id=$1`, [membership.lead]);
    assert.deepEqual((await http(editor, 'GET', views)).body.views[0].grants[0].blockers, ['sharer-lost-access']);
    await assert.rejects(read(), AccessDenied);
    await db.platform.query(`UPDATE ${schema}.tf_memberships SET role='admin' WHERE id=$1`, [membership.lead]);
    assert.deepEqual((await http(editor, 'GET', views)).body.views[0].grants[0].blockers, []);
  });

  await t.test('revoking a grant stops the next app request', async () => {
    assert.equal((await http(reader, 'DELETE', grant())).status, 403);
    assert.equal((await read()).records.length, 1);
    assert.equal((await http(editor, 'DELETE', grant())).status, 204);
    await assert.rejects(read(), AccessDenied);
    assert.equal((await http(editor, 'DELETE', grant())).status, 204);
    assert.deepEqual((await http(admin, 'GET', views)).body.views[0].grants, []);
  });
});
