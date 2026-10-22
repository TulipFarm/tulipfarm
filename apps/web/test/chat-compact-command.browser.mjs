import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

test(
  '/ offers /compact in an existing personal chat, and sending it posts only a compact part with the handoff instructions',
  { timeout: 120000 },
  async () => {
    const { workspace, session } = createWorkspaceFixture();
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const shots = process.env.COMPACT_COMMAND_SCREENSHOTS;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let chat = null;
    const history = [];
    const sends = [];
    try {
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();
        if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
        if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
        if (path === `/v1/workspaces/${workspace.slug}/last-used`) return route.fulfill({ status: 204 });
        if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
        if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
        if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
        if (path.endsWith('/credits')) return route.fulfill({ json: credits });
        if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
        if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
        if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
        if (path.endsWith('/projects')) return route.fulfill({ json: [] });
        if (path.endsWith('/google-workspace/operations/proposals'))
          return route.fulfill({ json: { proposals: [], nextCursor: null } });
        if (path.endsWith('/workspace-mcp/capabilities'))
          return route.fulfill({ status: 404, json: { error: 'not-found' } });
        if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
        if (path === `/v1/workspaces/${workspace.id}/skills`)
          return route.fulfill({ json: { workspace: [], nextCursor: null } });
        if (path.endsWith('/conversations') && method === 'GET')
          return route.fulfill({ json: { chats: chat ? [chat] : [], nextCursor: null } });
        const conversation = /\/conversations\/([\w-]+)(\/.*)?$/.exec(path);
        if (conversation) {
          const [, id, rest = ''] = conversation;
          if (method === 'PUT' && !rest) {
            chat = {
              id,
              title: 'New chat',
              titleRevision: 0,
              titleManual: false,
              archived: false,
              activityAt: '2026-10-06T10:00:00.000000Z',
              createdAt: '2026-10-06T10:00:00.000000Z',
              projectId: null,
            };
            return route.fulfill({ json: { id } });
          }
          if (method === 'PUT' && rest.startsWith('/messages/')) {
            const body = request.postDataJSON();
            sends.push(body);
            const messageId = rest.split('/').at(-1);
            const turnId = `8888888${history.length}-8888-4888-8888-888888888888`;
            history.push({
              id: messageId,
              sequence: history.length + 1,
              author: 'human',
              createdAt: '2026-10-06T10:00:01.000Z',
              parts: body.parts,
              turn: { id: turnId, status: 'completed', generation: 0 },
              tools: [],
              calendarResults: [],
            });
            chat = { ...chat, title: 'Plan review', titleRevision: 1 };
            return route.fulfill({ json: { messageId, turnId, sequence: history.length } });
          }
          if (method === 'GET' && rest === '/messages')
            return route.fulfill({ json: { messages: history, nextBefore: null, hasGitHubProposals: false } });
          if (method === 'GET' && !rest) return route.fulfill({ json: chat });
          if (method === 'GET') return route.fulfill({ json: [] });
        }
        if (method === 'GET' && !path.includes('/conversations'))
          return route.fulfill({ status: 404, json: { error: 'not-found' } });
        throw new Error(`Unexpected API request ${method} ${path}`);
      });

      await page.goto(`${server.resolvedUrls.local[0]}${workspace.slug}`);
      const editor = page.getByRole('textbox', { name: 'Message' });
      await editor.click();
      await editor.pressSequentially('Plan the review');
      await editor.press('Enter');
      await page.waitForURL(/\/chat\//);
      const messages = page.getByRole('list', { name: 'Messages' });
      await messages.getByText('Plan the review').waitFor();

      await editor.click();
      await editor.pressSequentially('/comp');
      const list = page.getByRole('listbox', { name: 'Skills you can use' });
      await list.waitFor({ state: 'attached' });
      const option = list.getByRole('option').first();
      if (shots)
        await option
          .waitFor({ timeout: 2000 })
          .catch(() => {})
          .then(() => page.screenshot({ path: `${shots}/compact-picker.png` }));
      await option.filter({ hasText: '/compact' }).waitFor();
      await option.filter({ hasText: 'Summarize earlier messages to free context.' }).waitFor();
      await editor.press('Enter');
      await list.waitFor({ state: 'detached' });
      assert.equal((await editor.textContent()).trim(), '/compact', 'choosing the option types the command');
      await editor.pressSequentially('keep the decisions');
      assert.equal(await list.count(), 0, 'a typed command hides the picker so Enter sends');
      await editor.press('Enter');

      await messages.getByText('keep the decisions').waitFor();
      if (shots) await page.screenshot({ path: `${shots}/compact-sent.png` });
      assert.equal(sends.length, 2);
      assert.deepEqual(sends[1].parts, [{ kind: 'compact', prompt: 'keep the decisions' }]);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
);
