import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { changeAppStop, createApp, listAppVersions, publishAppVersion, putAppGrant } from '@tulipfarm/apps/store';
import { humanReadableTableFiles } from '@tulipfarm/agents/table-sources';
import { createTableService } from '@tulipfarm/tables/service';
import { commonCompatibility, createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { createAuth } from '../src/auth.ts';
import { registerAppPages } from '../src/app-pages.ts';
import {
  fixture,
  loadPlatformBaseline,
  markWorkspaceReady,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { createTableWithRows, tableDefinition, textField } from '../../../packages/tables/test/fixture.mjs';

test(
  'app pages read as the viewing member, check action values, and report a broken reference once',
  { timeout: 120000 },
  async t => {
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
      seller = await signIn('Seller'),
      viewer = await signIn('Viewer'),
      editor = await signIn('Editor'),
      outsider = await signIn('Outsider');
    const workspace = await db.create(db.baseline, { userId: admin.id });
    await markWorkspaceReady(db.platform, workspace.id);
    const schema = `"${workspace.names.schema}"`;
    const sellerMembership = randomUUID(),
      viewerMembership = randomUUID(),
      editorMembership = randomUUID();
    for (const [id, user] of [
      [sellerMembership, seller.id],
      [viewerMembership, viewer.id],
      [editorMembership, editor.id],
    ])
      await db.platform.query(`INSERT INTO ${schema}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
        id,
        user,
      ]);
    const owners = randomUUID(),
      sales = randomUUID();
    await db.platform.query(`INSERT INTO ${schema}.tf_teams(id,name) VALUES($1,'Owners'),($2,'Sales')`, [
      owners,
      sales,
    ]);
    await db.platform.query(`INSERT INTO ${schema}.tf_member_teams(membership_id,team_id) VALUES($1,$2)`, [
      sellerMembership,
      sales,
    ]);
    const runtime = createWorkspaceRuntime({
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    cleanup.push(() => runtime.close());

    const name = textField('Name');
    const deals = await createTableWithRows({
      db,
      workspace,
      runtime,
      definition: tableDefinition({ owningTeamId: owners, label: 'Deals', fields: [name] }),
      records: ['Acme', 'Globex'].map(value => ({ values: { [name.id]: { kind: 'text', value } } })),
    });
    await db.platform.query(
      `INSERT INTO ${schema}.tf_grants(team_id,asset_id,permission) VALUES($1,$2,'table.row.read')`,
      [sales, deals.tableId],
    );
    const tables = createTableService(runtime, { readableFiles: humanReadableTableFiles }, commonCompatibility);

    const transact = action => runtime.transaction(workspace.id, commonCompatibility, action);
    const appId = randomUUID(),
      chatId = randomUUID(),
      editorChatId = randomUUID(),
      viewerChatId = randomUUID();
    await transact(async tx => {
      await createApp(tx, {
        id: appId,
        kind: 'private',
        slug: 'pipeline',
        title: 'Pipeline',
        createdBy: workspace.membershipId,
      });
      await tx.client.query(
        `INSERT INTO ${schema}.tf_conversations(id,owner_user_id,owner_membership_id,title,title_manual,app_id)
         VALUES($1,$2,$3,'Pipeline',true,$4)`,
        [chatId, admin.id, workspace.membershipId, appId],
      );
      for (const [membershipId, role] of [
        [sellerMembership, 'use'],
        [viewerMembership, 'use'],
        [editorMembership, 'edit'],
      ])
        await putAppGrant(tx, {
          appId,
          grantee: { kind: 'member', membershipId },
          role,
          grantedBy: workspace.membershipId,
        });
      // A chat left from when the viewer could edit; a viewer is not told about the app's references.
      for (const [id, user, membershipId] of [
        [editorChatId, editor.id, editorMembership],
        [viewerChatId, viewer.id, viewerMembership],
      ])
        await tx.client.query(
          `INSERT INTO ${schema}.tf_conversations(id,owner_user_id,owner_membership_id,title,title_manual,app_id)
           VALUES($1,$2,$3,'Pipeline',true,$4)`,
          [id, user, membershipId, appId],
        );
    });
    const surface = (id, components) => [
      { version: '1.0', createSurface: { surfaceId: id, catalogId: 'tulipfarm/apps@1', components } },
    ];
    const definition = {
      pages: [
        {
          id: 'deals',
          slug: 'deals',
          title: 'Deals',
          sources: [
            {
              id: 'open',
              kind: 'rows',
              tableId: deals.tableId,
              query: { version: 2, mode: 'rows', select: [name.id], sort: [{ fieldId: name.id, direction: 'asc' }] },
            },
            { id: 'count', kind: 'summary', tableId: deals.tableId, query: { version: 2, mode: 'summary' } },
          ],
          actions: [{ id: 'openDeal', label: 'Open', kind: 'open-page', pageId: 'deal', row: { context: 'row' } }],
          surface: surface('deals', [
            {
              id: 'root',
              component: 'Button',
              label: 'Open',
              action: { event: { name: 'openDeal', context: { row: { '@path': '/params/row' } } } },
            },
          ]),
        },
        {
          id: 'deal',
          slug: 'deal',
          title: 'Deal',
          row: { tableId: deals.tableId },
          sources: [{ id: 'deal', kind: 'row' }],
          actions: [],
          surface: surface('deal', [{ id: 'root', component: 'Text', text: 'Deal' }]),
        },
      ],
    };
    await db.platform.query(`UPDATE ${schema}.tf_app_drafts SET definition=$2, revision=revision+1 WHERE app_id=$1`, [
      appId,
      JSON.stringify(definition),
    ]);
    const published = await transact(async tx => {
      const { generation } = await listAppVersions(tx, appId);
      return publishAppVersion(tx, {
        appId,
        requestId: randomUUID(),
        requestedBy: workspace.membershipId,
        generation,
        revision: 1,
      });
    });
    assert.equal(published.ok, true);

    const started = [];
    const app = Fastify();
    app.register(
      async routes =>
        registerAppPages(routes, {
          auth,
          runtime,
          tables,
          startWorkflow: async (...call) => {
            started.push(call);
            return { runId: randomUUID() };
          },
          askAgent: async (...call) => {
            started.push(call);
            return { taskId: randomUUID() };
          },
        }),
      { prefix: '/v1' },
    );
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    const http = async (who, method, path, body) => {
      const response = await fetch(`${address}/v1/workspaces/${workspace.id}/apps/${appId}/pages${path}`, {
        method,
        headers: {
          ...(who ? { cookie: who.cookie } : {}),
          origin: 'http://localhost:5173',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      return {
        status: response.status,
        cache: response.headers.get('cache-control'),
        body: text ? JSON.parse(text) : null,
      };
    };
    const sources = response => {
      assert.equal(response.status, 200);
      return Object.fromEntries(
        Object.entries(response.body.updateDataModel.value).map(([id, { status, value }]) => [id, { status, value }]),
      );
    };

    assert.equal((await http(null, 'GET', '/deals')).status, 401);
    assert.equal((await http(outsider, 'GET', '/deals')).status, 404);
    assert.equal((await http(viewer, 'GET', '/missing')).status, 404);

    const page = await http(viewer, 'GET', '/deals');
    assert.equal(page.cache, 'private, no-store');
    assert.deepEqual(page.body, {
      draft: false,
      navigation: [
        { slug: 'deals', title: 'Deals' },
        { slug: 'deal', title: 'Deal' },
      ],
      page: {
        slug: 'deals',
        title: 'Deals',
        surface: definition.pages[0].surface,
        actions: [{ id: 'openDeal', label: 'Open', kind: 'open-page', availability: 'available' }],
      },
    });
    assert.deepEqual((await http(viewer, 'GET', '')).body, page.body);
    assert.equal((await http(outsider, 'GET', '')).status, 404);
    assert.equal((await http(viewer, 'GET', '/deals?draft=true')).status, 403);

    const sellerData = await http(seller, 'POST', '/deals/data', {});
    assert.equal(sellerData.body.version, '1.0');
    assert.equal(sellerData.body.updateDataModel.surfaceId, 'deals');
    assert.equal(sellerData.body.updateDataModel.path, '/sources');
    const seen = sources(sellerData);
    assert.equal(seen.open.status, 'ready');
    assert.deepEqual(
      seen.open.value.records.map(record => record.values[name.id].value),
      ['Acme', 'Globex'],
    );
    assert.equal(seen.open.value.total, '2');
    assert.equal(seen.count.status, 'ready');
    assert.deepEqual(seen.count.value, { groups: [{ keys: [], values: ['2'] }], groupCount: null });
    assert.deepEqual(sources(await http(viewer, 'POST', '/deals/data', {})), {
      open: { status: 'restricted', value: null },
      count: { status: 'restricted', value: null },
    });

    const acme = deals.records[0].id;
    const rowData = sources(await http(seller, 'POST', '/deal/data', { row: acme }));
    assert.equal(rowData.deal.status, 'ready');
    assert.equal(rowData.deal.value.values[name.id].value, 'Acme');
    assert.deepEqual(sources(await http(viewer, 'POST', '/deal/data', { row: acme })), {
      deal: { status: 'restricted', value: null },
    });
    assert.deepEqual(sources(await http(seller, 'POST', '/deal/data', {})), { deal: { status: 'empty', value: null } });

    const click = (who, context) => http(who, 'POST', '/deals/actions/openDeal', { requestId: randomUUID(), context });
    assert.deepEqual(await click(viewer, { row: acme }).then(({ status, body }) => ({ status, body })), {
      status: 200,
      body: { kind: 'open-page', page: 'deal', row: acme },
    });
    assert.deepEqual((await click(viewer, { row: acme, secret: 'x' })).body, { error: 'invalid-context' });
    assert.equal((await click(viewer, { row: acme, secret: 'x' })).status, 400);
    assert.equal((await click(viewer, {})).status, 400);
    assert.equal((await click(viewer, { row: 'x'.repeat(9000) })).status, 400);
    assert.equal(
      (await http(viewer, 'POST', '/deals/actions/nothing', { requestId: randomUUID(), context: {} })).status,
      404,
    );

    assert.equal((await http(admin, 'GET', '/deals?draft=true')).body.draft, true);
    const preview = { requestId: randomUUID(), context: { row: acme } };
    assert.deepEqual((await http(admin, 'POST', '/deals/actions/openDeal?draft=true', preview)).body, {
      kind: 'open-page',
      page: 'deal',
      row: acme,
    });

    const untrusted = await fetch(`${address}/v1/workspaces/${workspace.id}/apps/${appId}/pages/deals/data`, {
      method: 'POST',
      headers: { cookie: seller.cookie, origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(untrusted.status, 403);

    await db.platform.query(`UPDATE ${schema}.tf_table_catalog SET archived_at=now() WHERE id=$1`, [deals.tableId]);
    assert.deepEqual(sources(await http(seller, 'POST', '/deals/data', {})), {
      open: { status: 'unavailable', value: null },
      count: { status: 'unavailable', value: null },
    });
    assert.deepEqual(sources(await http(viewer, 'POST', '/deals/data', {})), {
      open: { status: 'unavailable', value: null },
      count: { status: 'unavailable', value: null },
    });
    const notices = await db.platform.query(
      `SELECT m.conversation_id, p.text FROM ${schema}.tf_conversation_messages m
       JOIN ${schema}.tf_conversation_parts p ON p.message_id = m.id
       WHERE m.conversation_id = ANY($1::uuid[]) AND m.author_kind = 'assistant'`,
      [[chatId, editorChatId, viewerChatId]],
    );
    const notice =
      'The current version of this app uses a table and a field that no longer exist. People you share the app with see that part of “Deals” as no longer available. Other pages that use them show the same. Reply here to fix it, then publish.';
    assert.deepEqual(
      notices.rows.map(row => [row.conversation_id, row.text]).sort(),
      [
        [chatId, notice],
        [editorChatId, notice],
      ].sort(),
    );

    process.env.FEATURE_FLAG_APP_HOSTING = 'false';
    assert.equal((await http(seller, 'GET', '/deals')).status, 404);
    process.env.FEATURE_FLAG_APP_HOSTING = 'true';

    const disabled = await transact(tx =>
      changeAppStop(tx, { appId, requestId: randomUUID(), requestedBy: workspace.membershipId, kind: 'disable' }),
    );
    assert.equal(disabled.ok, true);
    const confirmed = { requestId: randomUUID(), context: { row: acme }, confirmed: true };
    assert.deepEqual(
      [
        await http(seller, 'GET', '/deals'),
        await http(admin, 'GET', '/deals'),
        await http(admin, 'GET', '/deals?draft=true'),
        await http(admin, 'POST', '/deals/data?draft=true', {}),
        await http(admin, 'POST', '/deals/actions/openDeal?draft=true', confirmed),
      ].map(({ status }) => status),
      [404, 404, 404, 404, 404],
    );
    assert.deepEqual(started, []);
  },
);
