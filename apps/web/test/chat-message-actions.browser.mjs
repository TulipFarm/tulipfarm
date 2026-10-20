import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

test(
  'message actions stay hidden until hover, show time, and copy keeps formatting with each link once',
  { timeout: 120000 },
  async () => {
    const { workspace, session } = createWorkspaceFixture();
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: 'reduce',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const shots = process.env.MESSAGE_ACTIONS_SCREENSHOTS;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const chatId = '11111111-1111-4111-8111-111111111111';
    const chat = {
      id: chatId,
      title: 'Docs link',
      titleRevision: 1,
      titleManual: false,
      archived: false,
      activityAt: '2026-10-06T10:00:00.000000Z',
      createdAt: '2026-10-06T10:00:00.000000Z',
      projectId: null,
    };
    const turn = status => ({ id: '88888888-8888-4888-8888-888888888888', status, generation: 0 });
    const history = [
      {
        id: '22222222-2222-4222-8222-222222222222',
        sequence: 1,
        author: 'human',
        createdAt: '2026-10-06T10:00:00.000Z',
        parts: [{ kind: 'text', text: 'Where are the docs?' }],
        turn: turn('completed'),
        tools: [],
        calendarResults: [],
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        sequence: 2,
        author: 'assistant',
        createdAt: '2026-10-06T10:00:05.000Z',
        parts: [
          {
            kind: 'text',
            text: 'Read **the guide**: [https://example.com/guide](https://example.com/guide) and [the API](https://example.com/api).',
          },
        ],
        turn: turn('completed'),
        tools: [],
        calendarResults: [],
      },
    ];
    try {
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
        if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
        if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
        if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
        if (path === `/v1/workspaces/${workspace.slug}/last-used` && method === 'PUT')
          return route.fulfill({ status: 204 });
        if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
        if (path.endsWith('/credits')) return route.fulfill({ json: credits });
        if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
        if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
        if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
        if (path.endsWith('/slack/status'))
          return route.fulfill({
            json: { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] },
          });
        if (path.endsWith('/github/accounts')) return route.fulfill({ json: { configured: true, accounts: [] } });
        if (path.endsWith('/atlassian/accounts'))
          return route.fulfill({
            json: {
              accounts: [],
              providers: [
                { protocol: 'atlassian-rest', configured: true },
                { protocol: 'trello', configured: true },
              ],
            },
          });
        if (path.endsWith('/bud'))
          return route.fulfill({
            json: {
              conversationId: null,
              onboarding: 'skipped',
              bubblesEnabled: false,
              snoozedUntil: null,
              nudge: null,
              preferences: [],
            },
          });
        if (path.endsWith('/recommendations/events'))
          return route.fulfill({ status: 503, json: { error: 'recommendations-unavailable' } });
        if (path.endsWith('/projects')) return route.fulfill({ json: [] });
        if (path.endsWith('/google-workspace/operations/proposals'))
          return route.fulfill({ json: { proposals: [], nextCursor: null } });
        if (path.endsWith('/workspace-mcp/capabilities'))
          return route.fulfill({ status: 404, json: { error: 'not-found' } });
        if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
        if (path === `/v1/workspaces/${workspace.id}/skills`)
          return route.fulfill({ json: { workspace: [], nextCursor: null } });
        if (path.endsWith('/conversations') && method === 'GET')
          return route.fulfill({ json: { chats: [chat], nextCursor: null } });
        const conversation = /\/conversations\/([\w-]+)(\/.*)?$/.exec(path);
        if (conversation) {
          const [, , rest = ''] = conversation;
          if (method === 'GET' && rest === '/messages')
            return route.fulfill({ json: { messages: history, nextBefore: null, hasGitHubProposals: false } });
          if (method === 'GET' && !rest) return route.fulfill({ json: chat });
          if (method === 'GET') return route.fulfill({ json: [] });
        }
        if (path === '/v1/feature-flags') return route.fulfill({ json: {} });
        throw new Error(`Unexpected API request ${method} ${path}`);
      });

      await page.goto(`${server.resolvedUrls.local[0]}${workspace.slug}/chat/${chatId}`);
      const messages = page.getByRole('list', { name: 'Messages' });
      await messages.getByText('Where are the docs?').waitFor();
      const copyUser = page.getByRole('button', { name: 'Copy message' });
      const copyReply = page.getByRole('button', { name: 'Copy response' });
      const hidden = async locator =>
        Number(await locator.evaluate(element => getComputedStyle(element.parentElement).opacity)) === 0;
      assert.ok(await hidden(copyUser), 'user actions are hidden before hover');
      assert.ok(await hidden(copyReply), 'assistant actions are hidden before hover');
      if (shots) await page.screenshot({ path: `${shots}/message-actions-idle.png` });

      await messages.getByText('Where are the docs?').hover();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-slot=message-actions] [role=group]')].some(
          group => getComputedStyle(group).opacity === '1',
        ),
      );
      const timestamp = copyUser.locator('xpath=..').locator('time');
      await timestamp.waitFor();
      assert.equal(await timestamp.getAttribute('datetime'), history[0].createdAt);
      assert.equal(
        await timestamp.getAttribute('title'),
        await page.evaluate(
          createdAt => new Date(createdAt).toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' }),
          history[0].createdAt,
        ),
      );
      if (shots) await page.screenshot({ path: `${shots}/message-actions-user-hover.png` });
      await copyUser.click();
      await page.getByRole('button', { name: 'Message copied' }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Where are the docs?');

      await messages.getByText('Read').hover();
      await copyReply.click();
      await page.getByRole('button', { name: 'Response copied' }).waitFor();
      await page
        .getByRole('status')
        .filter({ hasText: 'Response copied to clipboard.' })
        .waitFor({ state: 'attached' });
      if (shots) await page.screenshot({ path: `${shots}/message-actions-assistant-hover.png` });
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        'Read **the guide**: https://example.com/guide and the API (https://example.com/api).',
      );
      const html = await page.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        return (await item.getType('text/html')).text();
      });
      assert.match(html, /<strong>the guide<\/strong>/);
      assert.match(html, /href="https:\/\/example\.com\/api"/);

      await page.mouse.move(0, 0);
      const copiedReply = page.getByRole('button', { name: 'Response copied' });
      await copiedReply.focus();
      assert.ok(!(await hidden(copiedReply)), 'keyboard focus reveals the actions');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
);
