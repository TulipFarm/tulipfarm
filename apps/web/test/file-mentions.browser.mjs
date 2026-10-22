import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

const file = (id, name, mediaType, size) => ({
  id,
  kind: 'file',
  name,
  parentId: null,
  creatorMembershipId: membership.membershipId,
  mediaType,
  size,
  trashed: false,
  role: 'manager',
});
const revenue = file('44444444-4444-4444-8444-444444444444', 'Q3 revenue summary.pdf', 'application/pdf', 428_000);

test(
  'TipTap formats a message, inserts an inline workspace file, persists both, and opens the sent file in the canvas',
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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let chat = null;
    let history = [];
    const searches = [];
    const sends = [];
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
        if (path.endsWith('/governance/me')) return route.fulfill({ json: membership });
        if (path.endsWith('/credits')) return route.fulfill({ json: credits });
        if (path.endsWith('/recommendations'))
          return route.fulfill({ status: 503, json: { error: 'recommendations-unavailable' } });
        if (path.endsWith('/model-catalog')) return route.fulfill({ json: chatCatalog });
        if (path.endsWith('/google-workspace/availability')) return route.fulfill({ json: { configured: false } });
        if (path.endsWith('/google-workspace')) return route.fulfill({ json: { status: 'disconnected' } });
        if (path.endsWith('/projects')) return route.fulfill({ json: [] });
        if (path.endsWith('/google-workspace/operations/proposals'))
          return route.fulfill({ json: { proposals: [], nextCursor: null } });
        if (path.endsWith('/workspace-mcp/capabilities'))
          return route.fulfill({ status: 404, json: { error: 'not-found' } });
        if (path.endsWith('/candidates')) return route.fulfill({ json: [] });
        if (path === `/v1/workspaces/${workspace.id}/files/suggestions`) {
          const query = url.searchParams.get('query') ?? '';
          searches.push(query);
          return route.fulfill({
            json: {
              items: query === '' || revenue.name.toLowerCase().includes(query.toLowerCase()) ? [revenue] : [],
              next: null,
            },
          });
        }
        if (path === `/v1/workspaces/${workspace.id}/files/${revenue.id}`) return route.fulfill({ json: revenue });
        if (path === `/v1/workspaces/${workspace.id}/files/${revenue.id}/recent-use`)
          return route.fulfill({ json: { id: revenue.id } });
        if (path === `/v1/workspaces/${workspace.id}/files/${revenue.id}/content`)
          return route.fulfill({ status: 404, json: { error: 'file-unavailable' } });
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
            history = [
              {
                id: messageId,
                sequence: 1,
                author: 'human',
                createdAt: '2026-10-06T10:00:01.000Z',
                parts: body.parts,
                turn: { id: '88888888-8888-4888-8888-888888888888', status: 'completed', generation: 0 },
                tools: [],
                calendarResults: [],
              },
            ];
            chat = { ...chat, title: 'Important review', titleRevision: 1 };
            return route.fulfill({ json: { messageId, turnId: '88888888-8888-4888-8888-888888888888', sequence: 1 } });
          }
          if (method === 'GET' && rest === '/messages')
            return route.fulfill({ json: { messages: history, nextBefore: null, hasGitHubProposals: false } });
          if (method === 'GET' && !rest) return route.fulfill({ json: chat });
          if (method === 'GET') return route.fulfill({ json: [] });
        }
        if (path === '/v1/feature-flags') return route.fulfill({ json: {} });
        if (path.endsWith('/last-used')) return route.fulfill({ status: 204 });
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
        if (path.endsWith('/recommendations') || path.endsWith('/recommendations/events'))
          return route.fulfill({ status: 503, json: { error: 'recommendations-unavailable' } });
        if (path.endsWith('/workspace-mcp/capabilities'))
          return route.fulfill({ status: 404, json: { error: 'not-found' } });
        if (method === 'GET' && path.endsWith('/github/accounts'))
          return route.fulfill({ json: { configured: false, accounts: [] } });
        if (method === 'GET' && path.endsWith('/atlassian/accounts'))
          return route.fulfill({ json: { accounts: [], providers: [] } });
        if (method === 'GET' && path.endsWith('/integrations')) return route.fulfill({ json: { integrations: [] } });
        if (method === 'GET' && path.endsWith('/slack/status'))
          return route.fulfill({
            json: { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] },
          });
        throw new Error(`Unexpected API request ${method} ${path}`);
      });

      await page.goto(`${server.resolvedUrls.local[0]}${workspace.slug}`);
      const editor = page.getByRole('textbox', { name: 'Message' });
      await editor.click();
      // Sprout's RichTextEditor omits aria-expanded on the textbox (not allowed by ARIA); aria-controls names the open list.
      assert.equal(await editor.getAttribute('aria-controls'), null);
      await editor.pressSequentially('**Important**');
      await editor.locator('strong').waitFor();
      await editor.pressSequentially(' review @q');
      const list = page.getByRole('listbox', { name: 'Files you can add' });
      await list.waitFor();
      await list.getByRole('option').filter({ hasText: revenue.name }).waitFor();
      assert.equal(await editor.getAttribute('aria-controls'), await list.getAttribute('id'));
      assert.ok(searches.includes('q'));
      await editor.press('Enter');
      await list.waitFor({ state: 'detached' });
      assert.match(await editor.textContent(), /Q3 revenue summary\.pdf/);
      await editor.press('Enter');
      await page.getByRole('list', { name: 'Messages' }).waitFor();

      assert.equal(sends.length, 1);
      const [textPart, filePart] = sends[0].parts;
      assert.equal(textPart.kind, 'text');
      assert.equal(textPart.content.version, 1);
      assert.ok(JSON.stringify(textPart.content).includes('"type":"bold"'));
      assert.ok(JSON.stringify(textPart.content).includes(`"id":"${revenue.id}"`));
      assert.deepEqual(filePart, { kind: 'file', fileId: revenue.id });
      const messages = page.getByRole('list', { name: 'Messages' });
      await messages.locator('strong').filter({ hasText: 'Important' }).first().waitFor();
      const fileButton = messages.getByRole('button', { name: `Inspect ${revenue.name}` });
      await fileButton.first().waitFor();
      await page.waitForURL(/\/chat\//);
      const chatUrl = page.url();
      await fileButton.first().click();
      await page.getByRole('region', { name: 'Canvas', exact: true }).waitFor();
      await page.getByRole('tab', { name: revenue.name, exact: true }).waitFor();
      assert.equal(page.url(), chatUrl, 'the chat remains open');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
);
