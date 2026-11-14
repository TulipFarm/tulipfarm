import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerExtension } from '@tulipfarm/extensions';
import { creditAccountExtension } from '@tulipfarm/workspace-storage/credit-account';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { s3AppStorage } from '../../../packages/apps/src/sites.ts';
import { appRepositories, createApp, readSourceBundles } from '../../../packages/apps/src/store/index.ts';
import { startObjectStore } from '../../../packages/apps/test/object-store.mjs';
import { conversationFixture } from '../../../packages/conversations/test/fixture.mjs';
import { createAppActivities } from '../src/app-activities.ts';
import { appEditingFromEnvironment, workerAppEditing } from '../src/app-editing-composition.ts';
import { createConversationActivities } from '../src/conversation-activities.ts';
import { captureMetrics } from './metric-capture.mjs';
import { useModelCatalog } from './model-catalog-fixture.mjs';
import {
  anthropicChat,
  anthropicText,
  completionReply,
  isCompletionRequest,
  isTitleRequest,
} from './native-chat-fixture.mjs';

await registerExtension(creditAccountExtension, { app: 'worker', env: {} });

const appToolNames = body => (body.tools ?? []).map(tool => tool.name).filter(name => name.startsWith('apps_'));

test('an app chat turn edits its app, and only a turn that completes saves', { timeout: 180000 }, async t => {
  const f = await conversationFixture();
  const objects = await startObjectStore();
  const root = await mkdtemp(join(tmpdir(), 'app-editing-'));
  const endpoint = await objects.storage.client.config.endpoint();
  const env = {
    ANTHROPIC_API_KEY: 'synthetic-test-key',
    FEATURE_FLAG_APP_HOSTING: 'true',
    TULIPFARM_OBJECT_STORAGE_APPS_BUCKET: objects.storage.bucket,
    TULIPFARM_OBJECT_STORAGE_ENDPOINT: `http://${endpoint.hostname}:${endpoint.port}`,
    TULIPFARM_OBJECT_STORAGE_ACCESS_KEY_ID: 'test',
    TULIPFARM_OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(useModelCatalog());
  t.after(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await objects.close();
    await rm(root, { recursive: true, force: true });
    await f.close();
  });

  const w = f.workspace;
  const platform = { client: f.db.platform, schema: w.names.schema };
  const created = await createApp(platform, {
    id: randomUUID(),
    kind: 'public',
    slug: 'orders',
    title: 'Orders',
    createdBy: w.membershipId,
  });
  const appId = created.app.id;
  const draft = async () => {
    const row = (
      await f.db.platform.query(
        `SELECT head_commit, lease_id, (SELECT count(*)::int FROM ${f.table('tf_app_draft_changes')} WHERE app_id = $1) AS staged
         FROM ${f.table('tf_app_drafts')} WHERE app_id = $1`,
        [appId],
      )
    ).rows[0];
    return { head: row.head_commit, lease: row.lease_id, staged: row.staged };
  };
  const repositories = appRepositories({ root: join(root, 'check'), storage: objects.storage });
  async function savedFiles(head) {
    const repository = await repositories.open(w.id, appId, head, await readSourceBundles(platform, appId));
    const files = {};
    for (const path of (await repositories.tree(repository, head)).keys())
      files[path] = new TextDecoder().decode(await repositories.file(repository, head, path));
    return files;
  }

  async function chat(app) {
    const chatId = randomUUID();
    await f.store.create(w.id, w.userId, { chatId, commandId: randomUUID() });
    if (app)
      await f.db.platform.query(`UPDATE ${f.table('tf_conversations')} SET app_id = $2 WHERE id = $1`, [chatId, app]);
    return chatId;
  }
  /** Runs one turn of `chatId`; `answer` gives the model's response to its nth chat request. */
  async function turn(chatId, answer) {
    const requests = [];
    const sent = await f.store.send(w.id, w.userId, chatId, {
      messageId: randomUUID(),
      commandId: randomUUID(),
      model: 'claude-sonnet',
      parts: [{ kind: 'text', text: 'Update the app.' }],
    });
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const body = JSON.parse(options.body);
      if (isTitleRequest(body)) return Response.json(anthropicText('Orders app'));
      if (isCompletionRequest(body)) return Response.json(completionReply('anthropic'));
      requests.push(body);
      return answer(requests.length, sent.turnId);
    });
    const apps = appEditingFromEnvironment(f.runtime, {
      start: async () => {},
      builders: () => ({ command: undefined, server: undefined }),
    });
    const result = await createConversationActivities(
      f.runtime,
      ...Array.from({ length: 12 }),
      apps,
    ).processConversationReply({
      workspaceId: w.id,
      conversationId: chatId,
      turnId: sent.turnId,
      generation: 0,
    });
    t.mock.restoreAll();
    return { result, requests };
  }
  const write = (path, content) =>
    Response.json(anthropicChat({ kind: 'tool', call: { tool: 'apps.files.write', path, content } }));
  const answer = text => Response.json(anthropicChat({ kind: 'answer', text }));

  const editing = await chat(appId);
  let saved;

  await t.test('a completed turn saves the file it wrote as the next draft commit', async () => {
    const { result, requests } = await turn(editing, n =>
      n === 1 ? write('index.html', '<h1>Orders</h1>') : answer('Done.'),
    );
    assert.equal(result, 'completed');
    assert.deepEqual(appToolNames(requests[0]), [
      'apps_status',
      'apps_files_list',
      'apps_files_read',
      'apps_files_write',
      'apps_files_delete',
      'apps_preview_build',
    ]);
    const after = await draft();
    assert.match(after.head, /^[0-9a-f]{40}$/);
    assert.deepEqual({ lease: after.lease, staged: after.staged }, { lease: null, staged: 0 });
    assert.deepEqual(await savedFiles(after.head), { 'index.html': '<h1>Orders</h1>' });
    saved = after.head;
  });

  await t.test('a cancelled turn leaves no staged changes and no lease', async () => {
    let staged;
    const { result } = await turn(editing, async (n, turnId) => {
      if (n === 1) return write('about.html', '<p>About</p>');
      staged = (await draft()).staged;
      await f.store.cancel(w.id, w.userId, editing, turnId, { commandId: randomUUID(), expectedGeneration: 0 });
      return answer('Done.');
    });
    assert.equal(result, 'stale');
    assert.equal(staged, 1);
    assert.deepEqual(await draft(), { head: saved, lease: null, staged: 0 });
  });

  await t.test('a failed turn leaves no staged changes and no lease', async () => {
    let staged;
    const { result } = await turn(editing, async n => {
      if (n === 1) return write('about.html', '<p>About</p>');
      staged = (await draft()).staged;
      return Response.json(
        { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        { status: 401 },
      );
    });
    assert.equal(result, 'failed');
    assert.equal(staged, 1);
    assert.deepEqual(await draft(), { head: saved, lease: null, staged: 0 });
    assert.deepEqual(await savedFiles(saved), { 'index.html': '<h1>Orders</h1>' });
  });

  await t.test('a chat that edits no app, or a workspace without app hosting, gets no app tools', async () => {
    const plain = await turn(await chat(null), () => answer('Hello.'));
    assert.equal(plain.result, 'completed');
    assert.deepEqual(appToolNames(plain.requests[0]), []);
    process.env.FEATURE_FLAG_APP_HOSTING = 'false';
    const off = await turn(await chat(appId), () => answer('Hello.'));
    process.env.FEATURE_FLAG_APP_HOSTING = 'true';
    assert.equal(off.result, 'completed');
    assert.deepEqual(appToolNames(off.requests[0]), []);
  });

  await t.test('a private app chat turn replaces a page and frees the draft when it completes', async () => {
    const privateApp = await createApp(platform, {
      id: randomUUID(),
      kind: 'private',
      slug: 'deals',
      title: 'Deals',
      createdBy: w.membershipId,
    });
    const page = {
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
            components: [{ id: 'root', component: 'Text', text: 'Open deals' }],
          },
        },
      ],
    };
    const { result, requests } = await turn(await chat(privateApp.app.id), n =>
      n === 1
        ? Response.json(anthropicChat({ kind: 'tool', call: { tool: 'apps.page.replace', page, expectedRevision: 0 } }))
        : answer('Done.'),
    );
    assert.equal(result, 'completed');
    assert.deepEqual(appToolNames(requests[0]), ['apps_page_read', 'apps_page_replace', 'apps_page_check']);
    const [replaced] = requests[1].messages.at(-1).content;
    assert.match(replaced.content, /apps\.page\.replace: \{"revision":1,"issues":\[\],/);
    const { rows } = await f.db.platform.query(
      `SELECT revision, lease_id, definition FROM ${f.table('tf_app_drafts')} WHERE app_id = $1`,
      [privateApp.app.id],
    );
    assert.deepEqual(rows, [{ revision: '1', lease_id: null, definition: { pages: [page] } }]);
  });

  await t.test('building the app starts the build and reports how it ended', async () => {
    const recorded = captureMetrics(t);
    const builder = {
      id: 'test-node22@1',
      async build(input) {
        if (input.recipe.command === 'npm run broken') return { ok: false, code: 'build-failed', log: '', units: 0n };
        return { ok: true, output: input.source, log: '', units: 0n };
      },
    };
    const builds = createAppActivities({
      transact: (workspaceId, action) =>
        f.runtime.transaction(workspaceId, commonCompatibility, tx => action({ client: tx.client, schema: tx.schema })),
      platform: f.db.platform,
      objects: s3AppStorage(objects.storage.client, objects.storage.bucket),
      source: async (workspaceId, id, commit) =>
        repositories.open(workspaceId, id, commit, await readSourceBundles(platform, id)),
      publisher: undefined,
      builder,
      credits: { available: async () => null, debit: async () => {} },
      async *workspaces() {},
      enabled: async () => true,
    });
    const commandBuilder = { id: builder.id };
    const apps = workerAppEditing(f.runtime, appRepositories({ root: join(root, 'tools'), storage: objects.storage }), {
      start: (workspaceId, buildId) => builds.buildApp({ workspaceId, buildId }),
      builders: () => ({ command: commandBuilder.id, server: undefined }),
    });
    const actor = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
    const on = { workspaceId: w.id, actor, conversationId: editing };
    // eslint-disable-next-line tulipfarm/product-copy -- A tool name, not user-facing copy.
    const build = () => apps.invoke(on, { tool: 'apps.preview.build' });
    const recipe = command => ({ kind: 'command', runtime: 'node22', command, output: 'dist' });
    const builderOf = async id =>
      (await f.db.platform.query(`SELECT builder FROM ${f.table('tf_app_builds')} WHERE id = $1`, [id])).rows[0]
        .builder;

    await apps.invoke(on, {
      tool: 'apps.files.write',
      path: 'app.json',
      content: JSON.stringify(recipe('npm run build')),
    });
    const built = await build();
    assert.deepEqual(
      { status: built.status, files: built.files, builder: await builderOf(built.buildId) },
      { status: 'succeeded', files: 2, builder: 'test-node22@1' },
    );

    await apps.invoke(on, {
      tool: 'apps.files.write',
      path: 'app.json',
      content: JSON.stringify(recipe('npm run broken')),
    });
    const broken = await build();
    assert.deepEqual(
      { status: broken.status, failure: broken.failure },
      { status: 'failed', failure: { code: 'build-failed', message: 'The build command failed', retryable: false } },
    );
    assert.deepEqual(await recorded.points('cloud_app_builds'), [
      { outcome: 'succeeded', failure_code: 'none', value: 1 },
      { outcome: 'failed', failure_code: 'build-failed', value: 1 },
    ]);

    await apps.invoke(on, {
      tool: 'apps.files.write',
      path: 'app.json',
      content: JSON.stringify({ kind: 'server', runtime: 'node22', serve: { port: 3000, start: 'node server.js' } }),
    });
    const server = await build();
    assert.deepEqual(
      { status: server.status, failure: server.failure },
      {
        status: 'failed',
        failure: {
          code: 'host-unavailable',
          message: 'This server cannot run apps that start their own server',
          retryable: false,
        },
      },
    );

    commandBuilder.id = undefined;
    await apps.invoke(on, {
      tool: 'apps.files.write',
      path: 'app.json',
      content: JSON.stringify(recipe('npm run ci')),
    });
    const refused = await build();
    assert.deepEqual(
      { status: refused.status, failure: refused.failure },
      {
        status: 'failed',
        failure: { code: 'builder-unavailable', message: 'This server cannot run build commands', retryable: false },
      },
    );
    assert.deepEqual(await apps.finishTurn(on, 'cancelled'), { saved: null });
  });
});
