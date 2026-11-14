import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { readAppRecipe } from '@tulipfarm/apps';
import { finishBuild, requestBuild, stageDraftChange } from '@tulipfarm/apps/store';
import { createAuth } from '../src/auth.ts';
import { registerApps } from '../src/apps.ts';
import {
  fixture,
  loadPlatformBaseline,
  markWorkspaceReady,
} from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { commonCompatibility, createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';

test(
  'app routes answer members by role, behind the app-hosting flag, and repeat safely',
  { timeout: 60000 },
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
    await db.platform.query(
      await readFile(new URL('../../database/migrations/0011_app_hostnames.sql', import.meta.url), 'utf8'),
    );
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
      editor = await signIn('Editor'),
      reader = await signIn('Reader'),
      outsider = await signIn('Outsider');
    const workspace = await db.create(db.baseline, { userId: admin.id });
    await markWorkspaceReady(db.platform, workspace.id);
    const schema = `"${workspace.names.schema}"`;
    const editorMembership = '6f1c2d4e-0000-4000-8000-000000000001',
      readerMembership = '6f1c2d4e-0000-4000-8000-000000000002';
    for (const [id, user] of [
      [editorMembership, editor.id],
      [readerMembership, reader.id],
    ])
      await db.platform.query(`INSERT INTO ${schema}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [
        id,
        user,
      ]);
    const runtime = createWorkspaceRuntime({
      resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(workspace) }),
      replicaCount: 1,
      reservedConnections: 2,
      databaseConnectionBudget: 30,
    });
    cleanup.push(() => runtime.close());
    const started = [];
    const removed = [];
    let holdPromotion = null;
    const platform = {
      query: (...args) => pool.query(...args),
      connect: async () => {
        const hold = holdPromotion;
        holdPromotion = null;
        await hold?.();
        return pool.connect();
      },
    };
    const app = Fastify();
    app.register(
      async routes =>
        registerApps(routes, {
          auth,
          runtime,
          platform,
          start: async (workflow, workflowId, input) => void started.push({ workflow, workflowId, input }),
          repositories: null,
          publisher: () => ({ remove: async route => void removed.push(route) }),
          builderId: () => undefined,
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

    assert.equal((await http(null, 'GET', '')).status, 401);
    assert.deepEqual(await http(outsider, 'GET', ''), { status: 404, body: { error: 'not-found' } });

    const create = { requestId: '11111111-1111-4111-8111-111111111111', kind: 'public', title: 'Order Board' };
    const created = await http(editor, 'POST', '', create);
    assert.equal(created.status, 201);
    assert.equal(created.body.slug, 'order-board');
    assert.equal(created.body.role, 'edit');
    assert.deepEqual(created.body.approval, { state: 'not-requested' });
    assert.equal(created.body.webAddress, null);
    const appId = created.body.id;
    const again = await http(editor, 'POST', '', create);
    assert.equal(again.body.id, appId);
    assert.equal(again.body.chatId, created.body.chatId);
    const second = await http(editor, 'POST', '', { ...create, requestId: '11111111-1111-4111-8111-111111111112' });
    assert.equal(second.body.slug, 'order-board-2');

    process.env.FEATURE_FLAG_APP_HOSTING = 'false';
    assert.deepEqual(await http(editor, 'GET', ''), { status: 404, body: { error: 'not-found' } });
    assert.equal((await http(editor, 'GET', `/${appId}`)).status, 404);
    process.env.FEATURE_FLAG_APP_HOSTING = 'true';

    assert.deepEqual(
      (await http(editor, 'GET', '')).body.apps.map(found => found.slug),
      ['order-board-2', 'order-board'],
    );
    assert.deepEqual((await http(reader, 'GET', '')).body, { apps: [] });
    assert.equal((await http(admin, 'GET', '')).body.apps.length, 2);
    assert.equal((await http(reader, 'GET', `/${appId}`)).status, 404);
    assert.equal((await http(outsider, 'GET', `/${appId}`)).status, 404);

    const detail = await http(editor, 'GET', `/${appId}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.draft, { revision: 0, headCommit: null, previewBuildId: null, state: 'empty' });
    assert.equal(detail.body.sitesDomain, 'apps.example.test');

    assert.equal(
      (await http(editor, 'PUT', `/${appId}/grants/member:${readerMembership}`, { role: 'use' })).status,
      200,
    );
    assert.deepEqual((await http(editor, 'GET', `/${appId}/grants`)).body.grants.map(grant => grant.role).sort(), [
      'edit',
      'use',
    ]);
    assert.equal((await http(reader, 'GET', `/${appId}`)).body.role, 'use');
    const team = randomUUID();
    await db.platform.query(`INSERT INTO ${schema}.tf_teams(id,name) VALUES($1,'Purchasing')`, [team]);
    assert.deepEqual((await http(editor, 'PUT', `/${appId}/grants/team:${team}`, { role: 'use' })).body.grantee, {
      kind: 'team',
      teamId: team,
      name: 'Purchasing',
    });
    assert.deepEqual(
      (await http(editor, 'GET', `/${appId}/grants`)).body.grants.find(grant => grant.grantee.kind === 'team').grantee,
      { kind: 'team', teamId: team, name: 'Purchasing' },
    );
    assert.equal((await http(editor, 'DELETE', `/${appId}/grants/team:${team}`)).status, 204);
    const forbidden = await http(reader, 'PATCH', `/${appId}`, { title: 'Mine now' });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.failure.code, 'forbidden');
    assert.equal(
      (await http(editor, 'PUT', `/${appId}/grants/member:6f1c2d4e-0000-4000-8000-00000000dead`, { role: 'use' }))
        .status,
      404,
    );
    assert.equal((await http(editor, 'PATCH', `/${appId}`, {})).status, 400);
    assert.equal((await http(editor, 'PATCH', `/${appId}`, { title: 'Orders' })).body.title, 'Orders');

    const untrusted = await fetch(`${address}${base}/${appId}`, {
      method: 'PATCH',
      headers: { cookie: editor.cookie, origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Stolen' }),
    });
    assert.equal(untrusted.status, 403);

    const noHead = await http(editor, 'POST', `/${appId}/builds`, {
      requestId: '22222222-2222-4222-8222-222222222222',
    });
    assert.equal(noHead.status, 404);
    assert.equal(noHead.body.failure.code, 'not-found');

    await runtime.transaction(workspace.id, commonCompatibility, tx =>
      stageDraftChange(
        tx,
        {
          appId,
          conversationId: created.body.chatId,
          membershipId: editorMembership,
          path: 'index.html',
          content: new TextEncoder().encode('<h1>Orders</h1>'),
        },
        new Map(),
      ),
    );
    assert.deepEqual((await http(editor, 'GET', `/${appId}/files`)).body, {
      headCommit: null,
      files: [{ path: 'index.html', bytes: 15, staged: true }],
    });
    assert.deepEqual((await http(editor, 'GET', `/${appId}/files?path=index.html`)).body, {
      path: 'index.html',
      staged: true,
      encoding: 'utf8',
      content: '<h1>Orders</h1>',
      bytes: 15,
    });
    assert.equal((await http(editor, 'GET', `/${appId}/files?path=missing.html`)).status, 404);
    assert.equal((await http(editor, 'GET', `/${appId}`)).body.draft.state, 'editing');

    const build = await runtime.transaction(workspace.id, commonCompatibility, async tx => {
      const queued = await requestBuild(tx, {
        appId,
        commit: 'a'.repeat(40),
        recipe: readAppRecipe(null).recipe,
        builder: 'copy',
        requestedBy: editorMembership,
      });
      return finishBuild(tx, queued.id, {
        ok: true,
        manifestKey: 'manifests/orders.json',
        manifestDigest: 'b'.repeat(64),
        files: 1,
        bytes: 15,
      });
    });
    const shown = await http(editor, 'GET', `/${appId}/builds/${build.id}`);
    assert.equal(shown.body.status, 'succeeded');
    assert.equal(shown.body.builder, 'copy');

    const publish = { requestId: '33333333-3333-4333-8333-333333333333', buildId: build.id };
    const unapproved = await http(editor, 'POST', `/${appId}/publish`, publish);
    assert.equal(unapproved.status, 409);
    assert.equal(unapproved.body.failure.code, 'approval-required');
    assert.equal((await http(reader, 'POST', `/${appId}/publish`, publish)).status, 403);

    const asked = await http(editor, 'POST', `/${appId}/approval-request`, {
      requestId: '44444444-4444-4444-8444-444444444444',
    });
    assert.equal(asked.body.approval.state, 'requested');
    assert.equal(
      (
        await http(editor, 'POST', `/${appId}/approval`, {
          requestId: '77777777-7777-4777-8777-777777777777',
          decision: 'approve',
        })
      ).status,
      403,
    );
    const approved = await http(admin, 'POST', `/${appId}/approval`, {
      requestId: '77777777-7777-4777-8777-777777777778',
      decision: 'approve',
      monthlyLimitUnits: '5000',
    });
    assert.equal(approved.body.approval.state, 'approved');
    assert.equal(approved.body.approval.monthlyLimitUnits, '5000');
    assert.equal(approved.body.role, null);

    const published = await http(editor, 'POST', `/${appId}/publish`, publish);
    assert.equal(published.status, 202);
    assert.equal(published.body.operation.kind, 'publish');
    assert.equal(published.body.operation.status, 'admitted');
    const repeated = await http(editor, 'POST', `/${appId}/publish`, publish);
    assert.equal(repeated.body.operation.id, published.body.operation.id);
    const operationId = published.body.operation.id;
    assert.deepEqual(
      started.filter(entry => entry.workflow === 'appPublish').map(entry => entry.workflowId),
      [`app-publish-${appId}-${operationId}`, `app-publish-${appId}-${operationId}`],
    );
    assert.deepEqual(started.find(entry => entry.workflow === 'appPublish').input, {
      workspaceId: workspace.id,
      operationId,
    });
    assert.equal((await http(editor, 'GET', `/${appId}/operations/${operationId}`)).body.operation.id, operationId);
    const releases = (await http(editor, 'GET', `/${appId}/releases`)).body.releases;
    assert.equal(releases.length, 1);
    assert.equal(releases[0].number, 1);
    assert.equal(releases[0].buildId, build.id);
    assert.equal(releases[0].live, false);

    assert.deepEqual((await http(editor, 'GET', '/names/orders')).body, { name: 'orders', available: true });
    assert.deepEqual((await http(editor, 'GET', '/names/admin')).body, {
      name: 'admin',
      available: false,
      reason: 'name-reserved',
    });
    const rename = { requestId: '55555555-5555-4555-8555-555555555555', name: 'orders' };
    const renamed = await http(editor, 'PUT', `/${appId}/name`, rename);
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.app.publicName, 'orders');
    assert.equal(renamed.body.app.webAddress, 'orders.apps.example.test');
    assert.equal((await http(editor, 'GET', `/${appId}`)).body.webAddress, 'orders.apps.example.test');
    assert.equal(renamed.body.operation.kind, 'rename');
    assert.equal((await http(editor, 'PUT', `/${appId}/name`, rename)).body.operation.id, renamed.body.operation.id);
    assert.deepEqual((await http(editor, 'GET', '/names/orders')).body, {
      name: 'orders',
      available: false,
      reason: 'name-taken',
    });
    const taken = await http(editor, 'PUT', `/${second.body.id}/name`, {
      requestId: '55555555-5555-4555-8555-555555555556',
      name: 'orders',
    });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.failure.code, 'name-taken');
    const renamedAgain = await http(editor, 'PUT', `/${appId}/name`, {
      requestId: '55555555-5555-4555-8555-555555555557',
      name: 'orders-live',
    });
    assert.equal(renamedAgain.body.app.publicName, 'orders-live');
    assert.equal(removed[0].name, 'orders');
    assert.deepEqual((await http(editor, 'GET', '/names/orders')).body, {
      name: 'orders',
      available: false,
      reason: 'name-taken',
    });

    const boardId = second.body.id;
    const currentNames = async () =>
      (
        await pool.query(`SELECT name FROM app.app_hostnames WHERE app_id = $1 AND state = 'current'`, [boardId])
      ).rows.map(row => row.name);
    await t.test('a reused rename request id with another name changes nothing', async () => {
      const boardRename = { requestId: '55555555-5555-4555-8555-555555555558', name: 'board-foo' };
      assert.equal((await http(editor, 'PUT', `/${boardId}/name`, boardRename)).status, 200);
      const reused = await http(editor, 'PUT', `/${boardId}/name`, { ...boardRename, name: 'board-bar' });
      assert.equal(reused.status, 409);
      assert.equal(reused.body.failure.code, 'superseded');
      assert.equal((await http(editor, 'GET', `/${boardId}`)).body.publicName, 'board-foo');
      assert.deepEqual(await currentNames(), ['board-foo']);
      assert.deepEqual((await http(editor, 'GET', '/names/board-bar')).body, { name: 'board-bar', available: true });
      assert.equal(
        removed.some(route => route.name === 'board-foo'),
        false,
      );
    });

    await t.test('of two overlapping renames, the name committed last is the one served', async () => {
      let reachedPromotion, releasePromotion;
      const reached = new Promise(resolve => (reachedPromotion = resolve));
      holdPromotion = () => (reachedPromotion(), new Promise(resolve => (releasePromotion = resolve)));
      const earlier = http(editor, 'PUT', `/${boardId}/name`, { requestId: randomUUID(), name: 'board-a' });
      await reached;
      const later = await http(editor, 'PUT', `/${boardId}/name`, { requestId: randomUUID(), name: 'board-b' });
      assert.equal(later.status, 200);
      releasePromotion();
      const overtaken = await earlier;
      assert.equal(overtaken.status, 409);
      assert.equal(overtaken.body.failure.code, 'superseded');
      assert.equal((await http(editor, 'GET', `/${boardId}`)).body.publicName, 'board-b');
      assert.deepEqual(await currentNames(), ['board-b']);
      assert.deepEqual(
        removed.filter(route => route.name.startsWith('board-')).map(route => route.name),
        ['board-foo'],
      );
    });

    const pause = { requestId: '66666666-6666-4666-8666-666666666666' };
    const paused = await http(editor, 'POST', `/${appId}/pause`, pause);
    assert.equal(paused.status, 200);
    assert.notEqual(paused.body.app.stops.editorPausedAt, null);
    assert.equal((await http(editor, 'POST', `/${appId}/pause`, pause)).body.operation.id, paused.body.operation.id);
    assert.equal((await http(editor, 'POST', `/${appId}/disable`, { requestId: randomUUID() })).status, 403);
    const disabled = await http(admin, 'POST', `/${appId}/disable`, { requestId: randomUUID() });
    assert.notEqual(disabled.body.app.stops.disabledAt, null);
    assert.ok(started.some(entry => entry.workflow === 'appProjectEdge' && entry.input.appId === appId));

    assert.equal((await http(editor, 'DELETE', `/${second.body.id}`)).status, 204);
    assert.equal((await http(editor, 'DELETE', `/${second.body.id}`)).status, 204);
    assert.equal((await http(editor, 'GET', `/${second.body.id}`)).status, 404);
    assert.deepEqual(
      (await http(editor, 'GET', '')).body.apps.map(found => found.id),
      [appId],
    );

    await t.test('a private app publishes, lists and restores versions through the release routes', async () => {
      const created = await http(editor, 'POST', '', {
        requestId: randomUUID(),
        kind: 'private',
        title: 'Deal Desk',
      });
      const privateId = created.body.id;
      const pages = text => ({
        pages: [
          {
            id: 'home',
            slug: 'home',
            title: 'Home',
            sources: [],
            actions: [],
            surface: [
              {
                version: '1.0',
                createSurface: {
                  surfaceId: 'home',
                  catalogId: 'tulipfarm/apps@1',
                  components: [{ id: 'root', component: 'Text', text }],
                },
              },
            ],
          },
        ],
      });
      const saveDraft = async definition =>
        Number(
          (
            await db.platform.query(
              `UPDATE ${schema}.tf_app_drafts SET definition = $2, revision = revision + 1 WHERE app_id = $1
               RETURNING revision`,
              [privateId, JSON.stringify(definition)],
            )
          ).rows[0].revision,
        );
      const liveText = async () =>
        (
          await db.platform.query(
            `SELECT v.definition FROM ${schema}.tf_app_versions v JOIN ${schema}.tf_apps a ON a.live_version_id = v.id
             WHERE a.id = $1`,
            [privateId],
          )
        ).rows[0].definition.pages[0].surface[0].createSurface.components[0].text;
      assert.equal(
        (await http(editor, 'PUT', `/${privateId}/grants/member:${readerMembership}`, { role: 'use' })).status,
        200,
      );

      const first = { requestId: randomUUID(), revision: await saveDraft(pages('Open deals')) };
      const published = await http(editor, 'POST', `/${privateId}/publish`, first);
      assert.equal(published.status, 200);
      assert.equal(published.body.operation.kind, 'publish');
      assert.equal(published.body.operation.status, 'switched');
      assert.equal(published.body.version.number, 1);
      assert.equal(published.body.version.live, true);
      assert.equal(published.body.version.staged, true);
      assert.equal(published.body.version.publishedBy, editorMembership);
      const repeated = await http(editor, 'POST', `/${privateId}/publish`, first);
      assert.equal(repeated.body.version.id, published.body.version.id);

      const listed = await http(editor, 'GET', `/${privateId}/releases`);
      const second = await http(editor, 'POST', `/${privateId}/publish`, {
        requestId: randomUUID(),
        revision: await saveDraft(pages('Closed deals')),
        generation: listed.body.generation,
      });
      assert.equal(second.body.version.number, 2);
      assert.equal(await liveText(), 'Closed deals');

      const overtaken = await http(editor, 'POST', `/${privateId}/publish`, {
        requestId: randomUUID(),
        revision: await saveDraft(pages('Lost deals')),
        generation: listed.body.generation,
      });
      assert.equal(overtaken.status, 409);
      assert.equal(overtaken.body.failure.code, 'superseded');
      const stale = await http(editor, 'POST', `/${privateId}/publish`, { requestId: randomUUID(), revision: 1 });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.failure.code, 'stale-draft');

      const readerList = await http(reader, 'GET', `/${privateId}/releases`);
      assert.equal(readerList.status, 200);
      assert.equal(readerList.body.generation, 2);
      assert.deepEqual(
        readerList.body.releases.map(({ number, live, staged }) => ({ number, live, staged })),
        [
          { number: 2, live: true, staged: true },
          { number: 1, live: false, staged: true },
        ],
      );
      const readerPublish = await http(reader, 'POST', `/${privateId}/publish`, {
        requestId: randomUUID(),
        revision: await saveDraft(pages('Reader deals')),
      });
      assert.equal(readerPublish.status, 403);
      assert.equal(readerPublish.body.failure.code, 'forbidden');
      const readerRestore = await http(reader, 'POST', `/${privateId}/rollback`, {
        requestId: randomUUID(),
        releaseId: published.body.version.id,
      });
      assert.equal(readerRestore.status, 403);

      const invalid = await http(editor, 'POST', `/${privateId}/publish`, {
        requestId: randomUUID(),
        revision: await saveDraft({ pages: [] }),
      });
      assert.equal(invalid.status, 422);
      assert.deepEqual(invalid.body, {
        failure: {
          name: 'AppFailure',
          code: 'definition-invalid',
          message: 'Fix the listed issues, then publish',
        },
        issues: [{ path: '/pages', message: 'Too small: expected array to have >=1 items' }],
      });
      assert.equal(
        (await http(editor, 'POST', `/${privateId}/publish`, { requestId: randomUUID(), buildId: randomUUID() }))
          .status,
        400,
      );

      assert.equal((await http(editor, 'DELETE', `/${privateId}/grants/member:${readerMembership}`)).status, 204);
      const restored = await http(editor, 'POST', `/${privateId}/rollback`, {
        requestId: randomUUID(),
        releaseId: published.body.version.id,
      });
      assert.equal(restored.status, 200);
      assert.equal(restored.body.operation.kind, 'rollback');
      assert.equal(restored.body.operation.status, 'switched');
      assert.equal(restored.body.version.number, 3);
      assert.equal(restored.body.version.digest, published.body.version.digest);
      assert.equal(await liveText(), 'Open deals');
      assert.deepEqual(
        (await http(editor, 'GET', `/${privateId}/releases`)).body.releases.map(({ number, live }) => [number, live]),
        [
          [3, true],
          [2, false],
          [1, false],
        ],
      );
      assert.deepEqual((await http(editor, 'GET', `/${privateId}/grants`)).body.grants, [
        { grantee: { kind: 'member', membershipId: editorMembership }, role: 'edit', grantedBy: editorMembership },
      ]);
      assert.equal((await http(reader, 'GET', `/${privateId}/releases`)).status, 404);
    });
  },
);
