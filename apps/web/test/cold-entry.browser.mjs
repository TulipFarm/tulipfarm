import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { shellRead } from './shell-reads.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { credits } from './chat-query.fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test('cold admission overlaps discovery and membership without admitting partial results', async t => {
  const { workspace, session } = createWorkspaceFixture();
  const server = await preview({
    root: fileURLToPath(new URL('..', import.meta.url)),
    preview: { host: '127.0.0.1', port: 0 },
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  try {
    for (const status of [200, 403, 404, 503])
      await t.test(`membership ${status} while discovery is held`, async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const list = Promise.withResolvers();
        const membership = Promise.withResolvers();
        let memberStatus = status;
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/v1/**', async route => {
          const path = new URL(route.request().url()).pathname;
          if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
          if (path === '/v1/workspaces') {
            await list.promise;
            return route.fulfill({ json: [workspace] });
          }
          if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
          if (path.endsWith('/governance/me')) {
            membership.resolve();
            return route.fulfill({
              status: memberStatus,
              json:
                memberStatus === 200
                  ? {
                      membershipId: workspace.id,
                      role: 'member',
                      teams: [],
                      capabilities: { manageGovernance: false, canLeave: true },
                    }
                  : { error: 'unavailable' },
            });
          }
          if (path.endsWith('/credits'))
            return route.fulfill({
              json: { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] },
            });
          if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
          if (path === '/v1/feature-flags') return route.fulfill({ json: {} });
          const shell = shellRead(route.request().method(), path, workspace);
          if (shell) return route.fulfill(shell);
          throw new Error(`Unexpected request ${path}`);
        });
        try {
          await page.goto(`${origin}/${workspace.slug}/help`);
          await Promise.race([
            membership.promise,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Membership waited for discovery')), 5000).unref(),
            ),
          ]);
          assert.equal(
            await page.getByRole('heading', { name: 'Help and support', exact: true }).count(),
            0,
            'Membership alone does not admit the page',
          );
          list.resolve();
          if (status === 200) await page.getByRole('heading', { name: 'Help and support', exact: true }).waitFor();
          else if (status === 503) {
            await page.getByRole('heading', { name: 'Could not open TulipFarm' }).waitFor();
            await delay(500);
            memberStatus = 200;
            await page.getByRole('button', { name: 'Try again', exact: true }).click();
            await page.getByRole('heading', { name: 'Help and support', exact: true }).waitFor();
          } else {
            // Cold-entry denial renders the workspace not-found boundary at the requested URL.
            await page.getByRole('heading', { name: 'Page not found', exact: true }).waitFor();
            assert.equal(page.url(), `${origin}/${workspace.slug}/help`);
            assert.equal(await page.getByRole('heading', { name: 'Help and support', exact: true }).count(), 0);
          }
          assert.deepEqual(errors, []);
        } finally {
          list.resolve();
          await context.close();
        }
      });
  } finally {
    await browser.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
});

test('cold chat routes read during admission, reuse those reads and never show them after denial', async t => {
  const { workspace, session } = createWorkspaceFixture();
  const userId = session.user.id;
  const staleId = '99999999-9999-4999-8999-999999999999';
  const chats = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'].map((id, index) => ({
    id,
    title: `Saved chat ${index + 1}`,
    titleRevision: 1,
    titleManual: false,
    archived: false,
    activityAt: workspace.createdAt,
    createdAt: workspace.createdAt,
  }));
  const message = chat => ({
    id: '44444444-4444-4444-8444-44444444444' + chats.indexOf(chat),
    sequence: 1,
    author: 'human',
    createdAt: workspace.createdAt,
    parts: [{ kind: 'text', text: `Opened ${chat.title}` }],
    turn: null,
  });
  const server = await preview({
    root: fileURLToPath(new URL('..', import.meta.url)),
    preview: { host: '127.0.0.1', port: 0 },
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  const hints = page =>
    page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), `tulipfarm:workspace-ids:${userId}`);

  async function open(path, { hint, memberStatus = 200, discovery } = {}) {
    const context = await browser.newContext();
    if (hint)
      await context.addInitScript(
        ([key, value]) => localStorage.setItem(key, value),
        [`tulipfarm:workspace-ids:${userId}`, JSON.stringify({ [workspace.slug]: hint })],
      );
    const page = await context.newPage();
    const membership = Promise.withResolvers();
    const requests = [];
    const unexpected = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/v1/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      requests.push(path);
      if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
      if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
      if (path === `/v1/workspaces/${workspace.slug}`) {
        await discovery;
        return route.fulfill({ json: workspace });
      }
      // Reads made with the stale hinted id fail as the API would for an unknown workspace.
      if (path.startsWith(`/v1/workspaces/${staleId}/`))
        return route.fulfill({ status: 404, json: { error: 'not-found' } });
      if (path.endsWith('/governance/me')) {
        await membership.promise;
        return route.fulfill(
          memberStatus === 200
            ? {
                json: {
                  membershipId: workspace.id,
                  role: 'member',
                  teams: [],
                  capabilities: { manageGovernance: false, canLeave: true },
                },
              }
            : { status: memberStatus, json: { error: 'denied' } },
        );
      }
      const base = `/v1/workspaces/${workspace.id}`;
      // A 404 here conceals chats as a lost integration would, so answer with the neutral state.
      if (path === `${base}/workspace-mcp/capabilities`) return route.fulfill({ json: { enabled: false } });
      if (path === `${base}/google-workspace/operations/proposals`)
        return route.fulfill({ json: { proposals: [], nextCursor: null } });
      const shell = shellRead(request.method(), path, workspace);
      if (shell) return route.fulfill(shell);
      const chat = chats.find(chat => path.startsWith(`${base}/conversations/${chat.id}`));
      // Left open so the chat stream never connects and refreshes the history it would reread.
      if (chat && path.endsWith('/events')) return;
      if (chat && path.endsWith('/messages'))
        return route.fulfill({ json: { messages: [message(chat)], nextBefore: null } });
      if (chat && path === `${base}/conversations/${chat.id}`) return route.fulfill({ json: chat });
      if (path === `${base}/conversations`) return route.fulfill({ json: { chats, nextCursor: null } });
      if (path === `${base}/projects`) return route.fulfill({ json: [] });
      if (path === `${base}/credits`) return route.fulfill({ json: credits });
      if (path === `${base}/model-catalog`) return route.fulfill({ json: chatCatalog });
      if (path === `${base}/integrations`) return route.fulfill({ json: { integrations: [] } });
      if (path === `${base}/operations/proposals`) return route.fulfill({ json: { proposals: [], nextCursor: null } });
      if (path === `${base}/system-package-installations`)
        return route.fulfill({ json: { installations: [], nextCursor: null } });
      if (path.endsWith('/plans')) return route.fulfill({ json: { plans: [], nextCursor: null } });
      if (path.endsWith('/batches')) return route.fulfill({ json: { batches: [] } });
      unexpected.push(path);
      return route.fulfill({ status: 404, json: { error: 'not-found' } });
    });
    const count = suffix => requests.filter(path => path === `/v1/workspaces/${workspace.id}${suffix}`).length;
    // Resolves once the reads have started while membership is still unanswered.
    const started = (...suffixes) =>
      Promise.all(
        suffixes.map(suffix =>
          page.waitForRequest(request => new URL(request.url()).pathname === `/v1/workspaces/${workspace.id}${suffix}`),
        ),
      );
    const visit = page.goto(`${origin}${path}`);
    return { context, page, membership, count, started, visit, requests, unexpected, errors };
  }

  try {
    for (const hint of [undefined, workspace.id])
      await t.test(`chat list and projects ${hint ? 'with' : 'without'} a remembered workspace id`, async () => {
        const run = await open(`/${workspace.slug}/chat`, { hint });
        try {
          await run.started('/conversations', '/projects');
          run.membership.resolve();
          await run.page.getByRole('button', { name: chats[0].title, exact: true }).first().waitFor();
          await delay(300);
          assert.equal(run.count('/conversations'), 1);
          assert.equal(run.count('/projects'), 1);
          assert.deepEqual(await hints(run.page), { [workspace.slug]: workspace.id });
          assert.deepEqual(run.unexpected, []);
          assert.deepEqual(run.errors, []);
        } finally {
          run.membership.resolve();
          await run.context.close();
        }
      });

    await t.test('an opened chat reads its messages and detail during admission', async () => {
      const [chat] = chats;
      const run = await open(`/${workspace.slug}/chat/${chat.id}`, { hint: workspace.id });
      try {
        await run.started(`/conversations/${chat.id}/messages`, `/conversations/${chat.id}`);
        run.membership.resolve();
        await run.page.getByText(`Opened ${chat.title}`, { exact: true }).first().waitFor();
        await delay(300);
        assert.equal(run.count(`/conversations/${chat.id}/messages`), 1);
        assert.equal(run.count(`/conversations/${chat.id}`), 1);
        assert.deepEqual(run.unexpected, []);
      } finally {
        run.membership.resolve();
        await run.context.close();
      }
    });

    await t.test('a stale remembered id is replaced and its reads are never shown', async () => {
      const discovery = Promise.withResolvers();
      const run = await open(`/${workspace.slug}/chat`, { hint: staleId, discovery: discovery.promise });
      try {
        await run.page.waitForRequest(
          request => new URL(request.url()).pathname === `/v1/workspaces/${staleId}/conversations`,
        );
        discovery.resolve();
        run.membership.resolve();
        await run.page.getByRole('button', { name: chats[0].title, exact: true }).first().waitFor();
        await delay(300);
        assert.equal(run.count('/conversations'), 1);
        assert.deepEqual(await hints(run.page), { [workspace.slug]: workspace.id });
        assert.deepEqual(run.errors, []);
      } finally {
        discovery.resolve();
        await run.context.close();
      }
    });

    for (const memberStatus of [403, 404])
      await t.test(`membership ${memberStatus} conceals the chats read during admission`, async () => {
        const run = await open(`/${workspace.slug}/chat`, { hint: workspace.id, memberStatus });
        try {
          await run.started('/conversations');
          run.membership.resolve();
          await run.page.getByRole('heading', { name: 'Page not found', exact: true }).waitFor();
          await delay(300);
          assert.equal(await run.page.getByText(chats[0].title).count(), 0);
          assert.deepEqual(await hints(run.page), {});
        } finally {
          await run.context.close();
        }
      });

    await t.test('hovering or focusing a chat fills the cache its page reads', async () => {
      const run = await open(`/${workspace.slug}/chat`, { hint: workspace.id });
      try {
        run.membership.resolve();
        for (const [chat, intent] of [
          [chats[0], button => button.hover()],
          [chats[1], button => button.focus()],
        ]) {
          const button = run.page.getByRole('button', { name: chat.title, exact: true }).first();
          await button.waitFor();
          const prefetched = run.started(`/conversations/${chat.id}/messages`, `/conversations/${chat.id}`);
          await intent(button);
          await prefetched;
          await delay(100);
          await button.click();
          await run.page.getByText(`Opened ${chat.title}`, { exact: true }).first().waitFor();
          assert.equal(run.count(`/conversations/${chat.id}/messages`), 1);
          assert.equal(run.count(`/conversations/${chat.id}`), 1);
          await run.page.goBack();
        }
        assert.deepEqual(run.unexpected, []);
      } finally {
        await run.context.close();
      }
    });
  } finally {
    await browser.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
});
