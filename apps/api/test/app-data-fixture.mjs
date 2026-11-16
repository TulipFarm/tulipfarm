import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import Fastify from 'fastify';
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

/** A workspace with a public app on a live release, a Posts table holding one row owned by ada, and members of each role. */
export async function appDataFixture(t) {
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
  for (const migration of ['0011_app_hostnames.sql', '0013_app_server_routes.sql', '0016_app_live_requests.sql'])
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
  const helloId = randomUUID();
  const service = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
  await service.mutate(
    workspace.id,
    { kind: 'human', userId: admin.id, membershipId: adminMembership },
    {
      kind: 'create',
      tableId: definition.id,
      revision,
      recordId: helloId,
      values: {
        [fields.title.id]: { kind: 'text', value: 'Hello' },
        [fields.owner.id]: { kind: 'text', value: 'ada' },
      },
    },
  );

  /** Creates a public app on a live release; the editor may edit it and the reader may use it. */
  const publishApp = async title => {
    const created = await http(lead, 'POST', '', { requestId: randomUUID(), kind: 'public', title });
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
      `UPDATE ${schema}.tf_apps SET public_name=$3, approval_state='approved', live_release_id=$2 WHERE id=$1`,
      [appId, live, title],
    );
    return { appId, live, build };
  };
  const { appId, live, build } = await publishApp('Blog');
  return {
    cleanup,
    db,
    pool,
    auth,
    runtime,
    service,
    workspace,
    schema,
    membership,
    adminMembership,
    members: { admin, lead, editor, reader, outsider },
    http,
    team,
    fields,
    definition,
    revision,
    helloId,
    appId,
    live,
    build,
    publishApp,
  };
}
