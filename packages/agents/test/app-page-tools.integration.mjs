import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkspaceRuntime } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createApp, publishAppVersion, putAppGrant } from '../../apps/src/store/index.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createAppPages } from '../src/app-page-tools.ts';

const missingTable = '11111111-1111-4111-8111-111111111111';
const page = (id, components = [{ id: 'root', component: 'Text', text: 'Open deals' }], fields = {}) => ({
  id,
  slug: id.toLowerCase(),
  title: id,
  sources: [],
  actions: [],
  ...fields,
  surface: [{ version: '1.0', createSurface: { surfaceId: id, catalogId: 'tulipfarm/apps@1', components } }],
});

test('a private app chat reads, replaces and checks its draft pages', { timeout: 120000 }, async t => {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  const w = await db.create(await workspaceTableMigrations());
  const schema = w.names.schema;
  const table = name => `"${schema}".${name}`;
  runtime = createWorkspaceRuntime({
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 20,
    resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
  });
  const platform = { client: db.platform, schema };
  const owner = { kind: 'human', userId: w.userId, membershipId: w.membershipId };
  async function member(role) {
    const actor = { kind: 'human', userId: randomUUID(), membershipId: randomUUID() };
    await db.platform.query(`INSERT INTO ${table('tf_memberships')}(id,user_id,role) VALUES($1,$2,'member')`, [
      actor.membershipId,
      actor.userId,
    ]);
    await putAppGrant(platform, {
      appId,
      grantee: { kind: 'member', membershipId: actor.membershipId },
      role,
      grantedBy: owner.membershipId,
    });
    return actor;
  }
  const app = kind =>
    createApp(platform, {
      id: randomUUID(),
      kind,
      slug: `${kind}-deals`,
      title: 'Deals',
      createdBy: owner.membershipId,
    });
  const appId = (await app('private')).app.id;
  const publicAppId = (await app('public')).app.id;
  async function chat(actor, on) {
    const id = randomUUID();
    await db.platform.query(
      `INSERT INTO ${table('tf_conversations')} (id, owner_user_id, owner_membership_id, app_id) VALUES ($1,$2,$3,$4)`,
      [id, actor.userId, actor.membershipId, on],
    );
    return { workspaceId: w.id, actor, conversationId: id };
  }
  const helper = await member('edit');
  const reader = await member('use');
  const ownerChat = await chat(owner, appId);
  const helperChat = await chat(helper, appId);

  let hosting = true;
  const pages = createAppPages(runtime, { enabled: async () => hosting });
  const read = (on, id) => pages.invoke(on, { tool: 'apps.page.read', ...(id ? { page: id } : {}) });
  const replace = (on, value, expectedRevision) =>
    pages.invoke(on, { tool: 'apps.page.replace', page: value, expectedRevision });
  const check = on => pages.invoke(on, { tool: 'apps.page.check' });
  const lease = async () =>
    (await db.platform.query(`SELECT lease_id FROM ${table('tf_app_drafts')} WHERE app_id = $1`, [appId])).rows[0]
      .lease_id;
  const refused = { error: 'forbidden', message: 'This chat cannot edit app pages', retryable: false };

  await t.test('the tools refuse readers, other chats and a workspace without app hosting', async () => {
    assert.equal(await pages.admitted(ownerChat), true);
    assert.equal(await pages.admitted(await chat(reader, appId)), false);
    assert.deepEqual(await read(await chat(reader, appId)), refused);
    assert.deepEqual(await read(await chat(owner, publicAppId)), refused);
    assert.deepEqual(await read(await chat(owner, null)), refused);
    hosting = false;
    assert.equal(await pages.admitted(ownerChat), false);
    assert.deepEqual(await replace(ownerChat, page('Home'), 0), {
      error: 'forbidden',
      message: 'App hosting is off in this workspace',
      retryable: false,
    });
    hosting = true;
  });

  await t.test('a new app reads as no pages, and its check says it needs one', async () => {
    assert.deepEqual(await read(ownerChat), { revision: 0, pages: [] });
    assert.deepEqual(await check(ownerChat), {
      revision: 0,
      ok: false,
      issues: [{ path: '/pages', message: 'Too small: expected array to have >=1 items' }],
    });
  });

  await t.test('replacing a page at the read revision writes it and takes the draft', async () => {
    assert.deepEqual(await replace(ownerChat, page('Home'), 0), { revision: 1, issues: [] });
    assert.deepEqual(await read(ownerChat, 'Home'), { revision: 1, page: page('Home') });
    assert.deepEqual(await check(ownerChat), { revision: 1, ok: true, issues: [] });
    assert.notEqual(await lease(), null);
  });

  await t.test('a stale revision changes nothing', async () => {
    assert.deepEqual(await replace(ownerChat, page('Home', [{ id: 'root', component: 'Text', text: 'Old' }]), 0), {
      error: 'stale-draft',
      message: 'The draft is at revision 1. Read it again, then replace the page.',
      retryable: false,
    });
    assert.deepEqual(await read(ownerChat), { revision: 1, pages: [page('Home')] });
  });

  await t.test('issues come back by JSON path, including records that no longer exist', async () => {
    const deal = page('Deal', undefined, {
      sources: [{ id: 'deals', kind: 'rows', tableId: missingTable, query: { version: 2, mode: 'rows' } }],
      actions: [{ id: 'back', label: 'Back', kind: 'open-page', pageId: 'Gone' }],
    });
    assert.deepEqual(await replace(ownerChat, deal, 1), {
      revision: 2,
      issues: [{ path: '/pages/1/actions/0/pageId', message: 'No page has ID Gone' }],
    });
    const fixed = { ...deal, actions: [{ ...deal.actions[0], pageId: 'Home' }] };
    assert.deepEqual(await replace(ownerChat, fixed, 2), {
      revision: 3,
      issues: [{ path: '/pages/1/sources/0/tableId', message: `The table ${missingTable} no longer exists` }],
    });
    assert.deepEqual(await check(ownerChat), {
      revision: 3,
      ok: false,
      issues: [{ path: '/pages/1/sources/0/tableId', message: `The table ${missingTable} no longer exists` }],
    });
    assert.deepEqual(
      (await read(ownerChat)).pages.map(({ id }) => id),
      ['Home', 'Deal'],
    );
    assert.deepEqual(await read(ownerChat, 'Gone'), {
      error: 'not-found',
      message: 'No page has ID Gone',
      retryable: false,
    });
  });

  await t.test('another chat gets draft-busy until the editing turn settles', async () => {
    assert.deepEqual(await replace(helperChat, page('Deal'), 3), {
      error: 'draft-busy',
      message: 'Another chat is editing this app',
      retryable: true,
    });
    await pages.finishTurn(ownerChat);
    assert.equal(await lease(), null);
    assert.deepEqual(await replace(helperChat, page('Deal'), 3), { revision: 4, issues: [] });
  });

  await t.test('a chat whose lease expired keeps editing while no other chat took the draft', async () => {
    const held = await lease();
    await db.platform.query(
      `UPDATE ${table('tf_app_drafts')} SET lease_expires_at = clock_timestamp() - interval '1 minute' WHERE app_id = $1`,
      [appId],
    );
    assert.deepEqual(await replace(helperChat, page('Home', [{ id: 'root', component: 'Text', text: 'Hi' }]), 4), {
      revision: 5,
      issues: [],
    });
    assert.equal(await lease(), held);
    await pages.finishTurn(helperChat);
  });

  await t.test('the editor publishes the revision the tools wrote', async () => {
    const published = await publishAppVersion(platform, {
      appId,
      requestId: randomUUID(),
      requestedBy: owner.membershipId,
      generation: 0,
      revision: 5,
    });
    assert.equal(published.ok, true);
    assert.equal(published.version.number, 1);
  });
});
