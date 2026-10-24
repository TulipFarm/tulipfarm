import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

const chatId = '12121212-1212-4212-8212-121212121212';
const turnId = '88888888-8888-4888-8888-888888888888';
const owner = '99999999-9999-4999-8999-999999999999';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const summary = (id, name) => ({
  id,
  kind: 'file',
  name,
  parentId: null,
  creatorMembershipId: owner,
  mediaType: 'image/png',
  size: png.length,
  trashed: false,
  role: 'manager',
});
const generated = summary('44444444-4444-4444-8444-444444444444', 'Orchid poster.png');
const source = summary('55555555-5555-4555-8555-555555555555', 'Greenhouse photo.png');
const ids = ['66666666-6666-4666-8666-666666666661', '66666666-6666-4666-8666-666666666662'];
const chat = {
  id: chatId,
  title: 'Orchid poster',
  titleRevision: 1,
  titleManual: false,
  archived: false,
  activityAt: '2026-10-05T10:00:00.000000Z',
  createdAt: '2026-10-05T10:00:00.000000Z',
  projectId: null,
};

/** Answers the app shell's reads. Returns false for a request the test itself must answer. */
async function serveShell(route, workspace, session, path) {
  if (await serveWorkspaceShellEvent(route, workspace)) return true;
  const shell = new Map([
    ...workspaceShellReads(workspace.id),
    ['/v1/feature-flags', { images: true }],
    ['/v1/auth/get-session', session],
    ['/v1/user/visit', { firstSession: false }],
    ['/v1/workspaces', [workspace]],
    [`/v1/workspaces/${workspace.slug}`, workspace],
  ]);
  const suffixes = [
    ['/governance/me', membership],
    ['/credits', credits],
    ['/model-catalog', chatCatalog],
    ['/google-workspace/availability', { configured: false }],
    ['/google-workspace', { status: 'disconnected' }],
    ['/projects', []],
    ['/google-workspace/operations/proposals', { proposals: [], nextCursor: null }],
    ['/candidates', []],
    ['/integrations', { integrations: [] }],
  ];
  const body = shell.has(path) ? shell.get(path) : suffixes.find(([suffix]) => path.endsWith(suffix))?.[1];
  if (body !== undefined) {
    await route.fulfill({ json: body });
    return true;
  }
  if (path.endsWith('/workspace-mcp/capabilities') || path.endsWith('/bud')) {
    await route.fulfill({ status: 404, json: { error: 'not-found' } });
    return true;
  }
  return false;
}

async function withBrowser(run) {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    try {
      await run(context, server.resolvedUrls.local[0]);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

test(
  'generated images show pending cards that resolve, and Edit references the image in the composer',
  {
    timeout: 120000,
  },
  async () => {
    const { workspace, session } = createWorkspaceFixture();
    await withBrowser(async (context, origin) => {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let states = ['pending', 'pending'];
      const history = () => [
        {
          id: '13131313-1313-4313-8313-131313131313',
          sequence: 1,
          author: 'human',
          createdAt: '2026-10-05T10:00:01.000Z',
          parts: [{ kind: 'text', text: 'Make two orchid posters' }],
          turn: { id: turnId, status: states[0] === 'pending' ? 'processing' : 'completed', generation: 0 },
          tools: [
            {
              id: '14141414-1414-4414-8414-141414141414',
              tool: 'images.generate',
              status: states[0] === 'pending' ? 'running' : 'completed',
              activity: null,
              presentation: { label: 'Creating images', brand: null },
              web: null,
              images: [
                { index: 0, id: states[0] === 'saved' ? generated.id : ids[0], state: states[0] },
                { index: 1, id: ids[1], state: states[1] },
              ],
            },
          ],
          calendarResults: [],
        },
      ];
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        if (await serveShell(route, workspace, session, path)) return;
        if (path === `/v1/workspaces/${workspace.id}/files/${generated.id}`) return route.fulfill({ json: generated });
        if (path.endsWith(`/files/${generated.id}/content`))
          return route.fulfill({ contentType: 'image/png', body: png });
        if (path.endsWith('/conversations') && method === 'GET')
          return route.fulfill({ json: { chats: [chat], nextCursor: null } });
        const conversation = /\/conversations\/([\w-]+)(\/.*)?$/.exec(path);
        if (conversation) {
          const [, , rest = ''] = conversation;
          if (method === 'GET' && rest === '/messages')
            return route.fulfill({ json: { messages: history(), nextBefore: null, hasGitHubProposals: false } });
          if (method === 'GET' && !rest) return route.fulfill({ json: chat });
          if (method === 'GET') return route.fulfill({ json: [] });
        }
        throw new Error(`Unexpected API request ${method} ${path}`);
      });
      await page.goto(`${origin}${workspace.slug}/chat/${chatId}`);
      const cards = page.getByRole('list', { name: 'Images created in this reply' });
      await cards.getByRole('listitem').first().waitFor();
      assert.equal(await cards.getByRole('status').filter({ hasText: 'Creating image…' }).count(), 2);

      states = ['saved', 'refused'];
      await page.reload();
      const card = cards.getByRole('figure', { name: `Image: ${generated.name}` });
      await card.getByRole('img', { name: generated.name }).waitFor();
      await cards.getByText('The provider refused this image').waitFor();
      assert.equal(await cards.getByText('Creating image…').count(), 0);

      const download = page.waitForEvent('download');
      await card.getByRole('button', { name: `Download ${generated.name}` }).click();
      assert.equal((await download).suggestedFilename(), generated.name);

      await card.getByRole('button', { name: `Edit ${generated.name}` }).click();
      const editor = page.getByRole('textbox', { name: 'Message' });
      const chips = () => editor.textContent().then(text => text.split(generated.name).length - 1);
      await page.waitForFunction(
        name => document.querySelector('[aria-label="Message"]')?.textContent?.includes(name),
        generated.name,
      );
      assert.equal(await chips(), 1);
      await card.getByRole('button', { name: `Edit ${generated.name}` }).click();
      assert.equal(await chips(), 1, 'a second Edit adds no duplicate');

      await card.getByRole('button', { name: `Open ${generated.name}` }).click();
      await page.getByRole('tab', { name: generated.name, exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, `/${workspace.slug}/chat/${chatId}`);
      assert.deepEqual(errors, []);
    });
  },
);

test(
  'the file viewer shows how an image was generated and only links sources the reader can open',
  {
    timeout: 120000,
  },
  async () => {
    const { workspace, session } = createWorkspaceFixture();
    await withBrowser(async (context, origin) => {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        if (await serveShell(route, workspace, session, path)) return;
        const files = `/v1/workspaces/${workspace.id}/files`;
        if (path === `${files}/${generated.id}`) return route.fulfill({ json: generated });
        if (path === `${files}/${source.id}`) return route.fulfill({ json: source });
        if (path === `${files}/${generated.id}/content`) return route.fulfill({ contentType: 'image/png', body: png });
        if (path === `${files}/${generated.id}/recent-use` && method === 'POST') return route.fulfill({ status: 204 });
        if (path === `${files}/${generated.id}/details`)
          return route.fulfill({
            json: {
              item: generated,
              owner: { membershipId: owner, name: 'Ada' },
              path: [],
              pathRestricted: false,
              generation: {
                prompt: 'An orchid festival poster in warm colours',
                imageModelId: 'openai/gpt-image-1',
                catalogRevision: null,
                origin: { kind: 'turn', conversationId: chatId, turnId },
                sources: [{ kind: 'file', id: source.id }],
                hiddenSources: 2,
              },
            },
          });
        throw new Error(`Unexpected API request ${method} ${path}`);
      });
      await page.goto(`${origin}${workspace.slug}/files/${generated.id}`);
      const section = page.getByRole('region', { name: 'Generated' });
      await section.getByText('An orchid festival poster in warm colours').waitFor();
      await section.getByText('openai/gpt-image-1').waitFor();
      const link = section.getByRole('link', { name: source.name });
      await link.waitFor();
      assert.equal(new URL(await link.getAttribute('href'), origin).pathname, `/${workspace.slug}/files/${source.id}`);
      await section.getByText('2 sources you can’t open').waitFor();
      assert.equal(await section.getByRole('link').count(), 2, 'only the readable source and the chat are links');
      assert.equal(
        new URL(await section.getByRole('link', { name: 'A chat' }).getAttribute('href'), origin).pathname,
        `/${workspace.slug}/chat/${chatId}`,
      );
      assert.deepEqual(errors, []);
    });
  },
);
