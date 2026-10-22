import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

const chatId = '12121212-1212-4212-8212-121212121212';
const created = {
  id: '44444444-4444-4444-8444-444444444444',
  kind: 'file',
  name: 'Q3 summary.md',
  parentId: null,
  creatorMembershipId: '99999999-9999-4999-8999-999999999999',
  mediaType: 'text/markdown',
  size: 2048,
  trashed: false,
  role: 'manager',
};
const hidden = '77777777-7777-4777-8777-777777777777';
const tool = (id, fileId, status = 'completed') => ({
  id,
  tool: 'files.create',
  status,
  activity: null,
  presentation: { label: 'Saving a file to Files', brand: null },
  web: null,
  ...(fileId ? { fileId } : {}),
});

test('a file created in a reply shows as a card that opens the Files viewer', { timeout: 120000 }, async () => {
  const { workspace, session } = createWorkspaceFixture();
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await chromium.launch();
  const shots = process.env.FILE_OUTPUT_SCREENSHOTS;
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        hasTouch: mobile,
        isMobile: mobile,
        colorScheme: mobile ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let detailsStatus = 503;
      const chat = {
        id: chatId,
        title: 'Q3 summary',
        titleRevision: 1,
        titleManual: false,
        archived: false,
        activityAt: '2026-10-05T10:00:00.000000Z',
        createdAt: '2026-10-05T10:00:00.000000Z',
        projectId: null,
      };
      const history = [
        {
          id: '13131313-1313-4313-8313-131313131313',
          sequence: 1,
          author: 'human',
          createdAt: '2026-10-05T10:00:01.000Z',
          parts: [{ kind: 'text', text: 'Write the Q3 summary as a file' }],
          turn: { id: '88888888-8888-4888-8888-888888888888', status: 'completed', generation: 0 },
          tools: [
            tool('14141414-1414-4414-8414-141414141414', created.id),
            tool('15151515-1515-4515-8515-151515151515', hidden),
            tool('16161616-1616-4616-8616-161616161616', null, 'failed'),
          ],
          calendarResults: [],
        },
        {
          id: '17171717-1717-4717-8717-171717171717',
          sequence: 2,
          author: 'assistant',
          createdAt: '2026-10-05T10:00:02.000Z',
          parts: [{ kind: 'text', text: 'Saved Q3 summary.md.' }],
          turn: null,
          tools: [],
          calendarResults: [],
        },
      ];
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        if (await serveWorkspaceShellEvent(route, workspace)) return;
        const shell = workspaceShellReads(workspace.id).find(([url]) => url === path);
        if (shell) return route.fulfill({ json: shell[1] });
        if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
        if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
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
        if (path === `/v1/workspaces/${workspace.id}/files/${created.id}`)
          return detailsStatus === 200
            ? route.fulfill({ json: created })
            : route.fulfill({ status: detailsStatus, json: { error: 'files-unavailable' } });
        if (path === `/v1/workspaces/${workspace.id}/files/${hidden}`)
          return route.fulfill({ status: 404, json: { error: 'file-not-found' } });
        if (path.endsWith(`/files/${created.id}/content`))
          return route.fulfill({ contentType: 'text/markdown', body: '# Q3 results\n\nSynthetic report for review.' });
        if (path.includes(`/files/${created.id}/`)) return route.fulfill({ status: 404, json: { error: 'not-found' } });
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
        throw new Error(`Unexpected API request ${method} ${path}`);
      });
      try {
        await page.goto(`${server.resolvedUrls.local[0]}${workspace.slug}/chat/${chatId}`);
        const outputs = page.getByRole('region', { name: 'Files created in this reply' });
        await outputs.getByRole('alert').filter({ hasText: 'Couldn’t load file details.' }).waitFor();
        await outputs.getByText('A file created in this reply is unavailable to you.').waitFor();
        assert.equal(await outputs.getByText(hidden).count(), 0, 'an unreadable output never reveals its id');
        detailsStatus = 200;
        await outputs.getByRole('button', { name: 'Retry file details' }).click();
        // Cloud file-mentions.tsx:337-338 (51d9a255 #1053) shows a created file as a File result card with a View file action.
        const card = outputs
          .getByRole('region', { name: `File: ${created.name}`, exact: true })
          .getByRole('button', { name: 'View file', exact: true });
        await card.waitFor();
        assert.equal(
          await outputs.getByRole('button', { name: 'View file', exact: true }).count(),
          1,
          'a failed call shows no card',
        );
        if (shots)
          await page.screenshot({ path: `${shots}/file-output-card-${mobile ? 'mobile-dark' : 'desktop-light'}.png` });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await card.click();
        const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
        await canvas.getByRole('heading', { name: 'Q3 results', exact: true }).waitFor();
        assert.equal(new URL(page.url()).pathname, `/${workspace.slug}/chat/${chatId}`);
        await canvas.getByRole('link', { name: 'Open in Files', exact: true }).click();
        await page.waitForURL(new RegExp(`/${workspace.slug}/files/${created.id}$`));
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
