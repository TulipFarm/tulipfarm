import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

test('split chat list retains loading, recovery, filters, pagination, and denial', { timeout: 60000 }, async () => {
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
    const page = await browser.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    let gate = Promise.withResolvers();
    let status = 400;
    let empty = true;
    const shellReads = new Map(workspaceShellReads(workspace.id));
    const listPage = (second, query, archived) => {
      const filtered = empty || query || archived;
      return {
        chats: filtered
          ? []
          : [
              {
                id: second ? '22222222-2222-4222-8222-222222222222' : workspace.id,
                title: second ? 'Older chat' : 'Saved chat',
                titleRevision: 1,
                archived: false,
                activityAt: workspace.createdAt,
                createdAt: workspace.createdAt,
              },
            ],
        nextCursor: filtered || second ? null : 'next',
      };
    };
    await page.route('**/v1/**', async route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      requests.push(path);
      if (await serveWorkspaceShellEvent(route, workspace)) return;
      if (shellReads.has(path)) return route.fulfill({ json: shellReads.get(path) });
      if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
      if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
      if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
      if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
      if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
      if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
      if (path.endsWith('/governance/me'))
        return route.fulfill({
          json: {
            membershipId: workspace.id,
            role: 'member',
            teams: [],
            capabilities: { manageGovernance: false, canLeave: true },
          },
        });
      if (path.endsWith('/credits'))
        return route.fulfill({
          json: { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] },
        });
      if (path.endsWith('/projects')) return route.fulfill({ json: [] });
      if (path.endsWith('/conversations')) {
        await gate.promise;
        const second = url.searchParams.has('cursor');
        return route.fulfill({
          status,
          json:
            status !== 200
              ? { error: 'unavailable' }
              : listPage(second, url.searchParams.get('query'), url.searchParams.get('archived') === 'true'),
        });
      }
      if (path.endsWith('/conversations/pages')) {
        await gate.promise;
        const body = route.request().postDataJSON();
        assert.equal(route.request().method(), 'POST');
        assert.equal(body.count, 2);
        return route.fulfill({
          status,
          json:
            status !== 200
              ? { error: 'unavailable' }
              : {
                  pages: [false, true].map((second, index) => ({
                    digest: String(index + 1).repeat(64),
                    value: listPage(second, body.query, body.archived),
                  })),
                },
        });
      }
      throw new Error(`Unexpected API request ${path}`);
    });
    await page.goto(`${origin}/${workspace.slug}/chat`);
    await page.getByRole('status', { name: 'Loading chats', exact: true }).waitFor();
    assert.equal(await page.getByText('No chats yet', { exact: true }).count(), 0);
    gate.resolve();
    await page.getByRole('heading', { name: 'Could not load chats' }).waitFor();
    gate = Promise.withResolvers();
    await page.getByRole('button', { name: 'Retry loading chats' }).click();
    await page.getByRole('status', { name: 'Loading chats', exact: true }).waitFor();
    gate.resolve();
    await page.getByRole('heading', { name: 'Could not load chats' }).waitFor();
    status = 200;
    await page.getByRole('button', { name: 'Retry loading chats' }).click();
    await page.getByRole('heading', { name: 'No chats yet' }).waitFor();
    assert.equal(
      await page.getByRole('link', { name: 'Start a chat', exact: true }).getAttribute('href'),
      `/${workspace.slug}`,
    );
    empty = false;
    await page.getByLabel('Search chat titles').fill('missing');
    await page.getByLabel('Search chat titles').press('Enter');
    await page.getByRole('heading', { name: 'No matching chats' }).waitFor();
    await page.getByRole('button', { name: 'Clear search', exact: true }).first().click();
    await page.getByRole('heading', { name: 'No chats yet' }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Saved chat', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Load more chats' }).click();
    await page.getByRole('button', { name: 'Older chat', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Saved chat', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Archived chats', exact: true }).click();
    await page.getByRole('heading', { name: 'No archived chats' }).waitFor();
    await page.getByRole('button', { name: 'Show active chats' }).click();
    await page.getByRole('button', { name: 'Saved chat', exact: true }).waitFor();
    status = 403;
    await page.getByLabel('Search chat titles').fill('denied');
    await page.getByLabel('Search chat titles').press('Enter');
    await page.getByRole('heading', { name: 'Personal chats unavailable' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Saved chat', exact: true }).count(), 0);
    assert.equal(
      requests.some(path => path.endsWith('/model-catalog')),
      false,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
});
