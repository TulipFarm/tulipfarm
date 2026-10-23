import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { fileURLToPath } from 'node:url';
import { conversationPages } from '../../api/src/conversation-pages.ts';

test(
  'full reconciliation drains multi-page arrivals and refreshes older mutable rows and reordered filtered chat lists',
  { timeout: 60000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { port: 0 },
      plugins: [
        {
          name: 'pagination-proof',
          configureServer(server) {
            server.middlewares.use('/pagination-proof', async (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(await server.transformIndexHtml('/pagination-proof', '<html><body></body></html>'));
            });
          },
        },
      ],
    });
    await server.listen();
    const browser = await chromium.launch();
    const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
    const chat = index => ({
      id: uuid(index),
      title: `Chat ${index}`,
      titleRevision: 1,
      titleManual: false,
      archived: false,
      activityAt: `2026-10-02T00:00:0${index}Z`,
      createdAt: '2026-10-02T00:00:00Z',
    });
    let chats = [6, 5, 4, 3, 2, 1].map(chat);
    const message = index => ({
      id: uuid(index + 100),
      sequence: index,
      author: 'assistant',
      createdAt: '2026-10-02T00:00:00Z',
      parts: [{ kind: 'text', text: `Row ${index}` }],
      tools: [],
      turn: index === 1 ? { id: uuid(999), status: 'waiting', generation: 0 } : null,
    });
    const messages = Array.from({ length: 75 }, (_, index) => message(index + 1));
    const reads = { before: [], cursor: [], known: [] };
    try {
      const page = await browser.newPage();
      await page.route('**/v1/**', async route => {
        const url = new URL(route.request().url()),
          path = url.pathname;
        if (route.request().method() === 'PATCH') {
          const body = route.request().postDataJSON(),
            id = path.split('/').at(-1);
          const row = chats.find(chat => chat.id === id);
          if ('title' in body) {
            row.title = body.title;
            row.titleRevision++;
            return route.fulfill({ json: { titleRevision: row.titleRevision } });
          }
          row.archived = body.archived;
          return route.fulfill({ json: { archived: row.archived } });
        }
        if (path.endsWith('/pages')) {
          const input = route.request().postDataJSON();
          reads.known.push(input.known);
          if (path.endsWith('/messages/pages')) {
            const result = await conversationPages(
              input.count,
              input.before,
              input.known,
              async cursor => {
                const before = cursor ?? Infinity;
                reads.before.push(before);
                const remaining = messages.filter(row => row.sequence < before),
                  rows = remaining.slice(-50);
                return {
                  messages: rows,
                  nextBefore: remaining.length > 50 ? rows[0].sequence : null,
                  hasGitHubProposals: false,
                };
              },
              page => page.nextBefore,
            );
            return route.fulfill({ json: { ...result, chat: chats.find(chat => chat.id === path.split('/').at(-3)) } });
          }
          return route.fulfill({
            json: await conversationPages(
              input.count,
              input.cursor,
              input.known,
              async value => {
                const cursor = Number(value ?? 0);
                reads.cursor.push(cursor);
                const matching = chats.filter(
                  chat => chat.archived === input.archived && chat.title.includes(input.query),
                );
                return {
                  chats: matching.slice(cursor, cursor + 2),
                  nextCursor: cursor + 2 < matching.length ? String(cursor + 2) : null,
                };
              },
              page => page.nextCursor,
            ),
          });
        }
        if (path.endsWith('/messages')) {
          const before = Number(url.searchParams.get('before') ?? Infinity);
          reads.before.push(before);
          const remaining = messages.filter(row => row.sequence < before),
            rows = remaining.slice(-50);
          return route.fulfill({
            json: {
              messages: rows,
              nextBefore: remaining.length > 50 ? rows[0].sequence : null,
              hasGitHubProposals: false,
            },
          });
        }
        if (path.endsWith('/conversations')) {
          const cursor = Number(url.searchParams.get('cursor') ?? 0);
          reads.cursor.push(cursor);
          const matching = chats.filter(
            chat =>
              chat.archived === (url.searchParams.get('archived') === 'true') &&
              chat.title.includes(url.searchParams.get('query')),
          );
          return route.fulfill({
            json: {
              chats: matching.slice(cursor, cursor + 2),
              nextCursor: cursor + 2 < matching.length ? String(cursor + 2) : null,
            },
          });
        }
        return route.fulfill({ json: chats.find(chat => chat.id === path.split('/').at(-1)) });
      });
      await page.goto(`${server.resolvedUrls.local[0]}pagination-proof`);
      await page.evaluate(async id => {
        const f = await import('/test/chat-query-browser-fixture.tsx');
        const { React, createRoot, SessionQueryProvider, WorkspaceQueryProvider } = f;
        let scope = { kind: 'workspace', userId: 'pagination', workspaceId: id, membershipId: 'member' };
        const api = f.conversationApi(id, () => {}),
          p = {};
        function App() {
          p.identity = `${scope.userId}:${scope.membershipId}`;
          p.history = f.useConversationHistory(api, id, 5, false);
          p.list = f.useConversationList(api, false, '', 4);
          p.search = f.useConversationList(api, false, 'match', 4);
          p.archive = f.useConversationList(api, true, '', 4);
          p.write = f.useConversationCommand(api, () => {});
          return React.createElement(
            'output',
            null,
            JSON.stringify([p.history.state, p.list.state, p.search.state, p.archive.state]),
          );
        }
        const root = createRoot(document.body.appendChild(document.createElement('div')));
        p.reidentify = (userId, membershipId) => {
          scope = { ...scope, userId, membershipId };
          root.render(
            React.createElement(
              SessionQueryProvider,
              { identity: { userId: scope.userId, sessionId: 'pagination' } },
              React.createElement(
                WorkspaceQueryProvider,
                { scope, admitted: () => true, subscribe: () => () => {} },
                React.createElement(App),
              ),
            ),
          );
        };
        p.reidentify(scope.userId, scope.membershipId);
        window.pagination = p;
      }, uuid(1));
      await page.waitForFunction(() =>
        ['history', 'list', 'search', 'archive'].every(key => window.pagination[key]?.state.kind === 'ready'),
      );
      assert.deepEqual(
        await page.evaluate(() => window.pagination.history.state.data.messages.map(row => row.sequence)),
        Array.from({ length: 75 }, (_, index) => index + 1),
      );
      reads.before.length = 0;
      messages.push(...Array.from({ length: 120 }, (_, index) => message(index + 76)));
      messages[0].turn.status = 'completed';
      messages[0].turn.generation = 1;
      messages[1].parts = [{ kind: 'text', text: 'Older source redacted' }];
      await page.evaluate(() => window.pagination.history.refresh());
      assert.deepEqual(
        await page.evaluate(() => window.pagination.history.state.data.messages.map(row => row.sequence)),
        Array.from({ length: 195 }, (_, index) => index + 1),
        'no gaps or duplicates across more than two pages of arrivals',
      );
      assert.deepEqual(reads.before, [Infinity, 146, 96, 46]);
      assert.deepEqual(
        await page.evaluate(() =>
          window.pagination.history.state.data.messages
            .slice(0, 2)
            .map(row => [row.turn?.status ?? null, row.parts[0].text]),
        ),
        [
          ['completed', 'Row 1'],
          [null, 'Older source redacted'],
        ],
      );
      chats = [chats[5], ...chats.slice(0, 5)];
      await page.evaluate(
        id =>
          window.pagination.write.submit({
            kind: 'rename',
            chatId: id,
            commandId: crypto.randomUUID(),
            title: 'match moved from last page',
            expectedRevision: 1,
          }),
        uuid(1),
      );
      assert.deepEqual(
        await page.evaluate(() => window.pagination.list.state.data.chats.map(chat => chat.id)),
        [1, 6, 5, 4, 3, 2].map(uuid),
      );
      assert.deepEqual(await page.evaluate(() => window.pagination.search.state.data.chats.map(chat => chat.id)), [
        uuid(1),
      ]);
      await page.evaluate(
        id =>
          window.pagination.write.submit({
            kind: 'archive',
            chatId: id,
            commandId: crypto.randomUUID(),
            archived: true,
          }),
        uuid(5),
      );
      assert.deepEqual(
        await page.evaluate(() => window.pagination.list.state.data.chats.map(chat => chat.id)),
        [1, 6, 4, 3, 2].map(uuid),
      );
      assert.deepEqual(await page.evaluate(() => window.pagination.archive.state.data.chats.map(chat => chat.id)), [
        uuid(5),
      ]);
      await page.evaluate(
        id =>
          window.pagination.write.submit({
            kind: 'rename',
            chatId: id,
            commandId: crypto.randomUUID(),
            title: 'No longer in filter',
            expectedRevision: 2,
          }),
        uuid(1),
      );
      assert.deepEqual(await page.evaluate(() => window.pagination.search.state.data.chats), []);
      for (const [userId, membershipId] of [
        ['pagination', 'replacement-member'],
        ['other-user', 'other-member'],
      ]) {
        reads.known.length = 0;
        await page.evaluate(
          ([userId, membershipId]) => window.pagination.reidentify(userId, membershipId),
          [userId, membershipId],
        );
        await page.waitForFunction(
          ([userId, membershipId]) =>
            window.pagination.identity === `${userId}:${membershipId}` &&
            ['history', 'list', 'search', 'archive'].every(
              key => window.pagination[key]?.state.kind === 'ready' && !window.pagination[key].state.refreshing,
            ),
          [userId, membershipId],
        );
        assert.equal(reads.known.length, 4);
        assert.ok(
          reads.known.every(known => known.length === 0),
          'replacement memberships and accounts never send old validation state',
        );
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test('chat model selection uses the configured default, then the first available model, unless a preference is saved', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { port: 0 },
    plugins: [
      {
        name: 'chat-model-default-test',
        configureServer(server) {
          server.middlewares.use('/chat-model-default-test', async (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end(await server.transformIndexHtml('/chat-model-default-test', '<html><body></body></html>'));
          });
        },
      },
    ],
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/v1/**/model-catalog', async route => {
      // The server names its default model; without one listed, the first available model is used.
      const withoutDefault = route.request().url().includes('/without-default/');
      const families = withoutDefault
        ? chatCatalog.families.filter(family => family.id !== 'claude-sonnet')
        : chatCatalog.families;
      await route.fulfill({ json: { families, defaultChatFamilyId: 'claude-sonnet' } });
    });
    await page.goto(`${server.resolvedUrls.local[0]}chat-model-default-test`);
    await page.evaluate(async () => {
      const f = await import('/test/chat-query-browser-fixture.tsx');
      const { React, createRoot, SessionQueryProvider, WorkspaceQueryProvider } = f;
      const identity = { userId: 'chat-model-user', sessionId: 'chat-model-session' };
      const scope = workspaceId => ({
        kind: 'workspace',
        userId: identity.userId,
        workspaceId,
        membershipId: `member-${workspaceId}`,
      });
      function Model({ workspaceId, user }) {
        const models = f.useChatModels(workspaceId, user);
        const replaced = models.replacedModel ? ` (replaced: ${models.replacedModel})` : '';
        return React.createElement('output', null, `${models.model?.id}${replaced}`);
      }
      const model = (workspaceId, user) =>
        React.createElement(
          WorkspaceQueryProvider,
          { scope: scope(workspaceId), admitted: () => true, subscribe: () => () => {} },
          React.createElement(Model, { workspaceId, user }),
        );
      createRoot(document.body).render(
        React.createElement(
          SessionQueryProvider,
          { identity },
          React.createElement(
            React.Fragment,
            null,
            model('configured', { lastModelFamilyId: null }),
            model('without-default', { lastModelFamilyId: null }),
            model('saved', { lastModelFamilyId: 'claude-haiku' }),
            model('removed', { lastModelFamilyId: 'retired-model' }),
          ),
        ),
      );
    });
    await page.waitForFunction(
      expected => [...document.querySelectorAll('output')].map(output => output.textContent).join(',') === expected,
      'claude-sonnet,gpt-sol,claude-haiku,claude-sonnet (replaced: Claude Sonnet)',
    );
  } finally {
    await browser.close();
    await server.close();
  }
});

test(
  'model hook restores only an admitted, valid catalog and refreshes stale disk data without blocking chat',
  { timeout: 90000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { port: 0 },
      plugins: [
        {
          name: 'catalog-restoration-test',
          configureServer(server) {
            server.middlewares.use('/catalog-restoration-test', async (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(await server.transformIndexHtml('/catalog-restoration-test', '<html><body></body></html>'));
            });
          },
        },
      ],
    });
    await server.listen();
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      let requests = 0;
      let release;
      let gate = Promise.resolve();
      await page.route('**/v1/**/model-catalog', async route => {
        requests++;
        await gate;
        await route.fulfill({ json: chatCatalog });
      });
      await page.goto(`${server.resolvedUrls.local[0]}catalog-restoration-test`);
      const mount = () =>
        page.evaluate(async () => {
          const f = await import('/test/chat-query-browser-fixture.tsx');
          const { React, createRoot, SessionQueryProvider, WorkspaceQueryProvider } = f;
          const scope = {
            kind: 'workspace',
            userId: 'disk-user',
            workspaceId: '11111111-1111-4111-8111-111111111111',
            membershipId: 'disk-member',
          };
          const admitted = () => true,
            subscribe = () => () => {};
          const root = createRoot(document.body.appendChild(document.createElement('div')));
          function Reader() {
            const models = f.useChatModels(scope.workspaceId, { lastModelFamilyId: null });
            return React.createElement(
              'output',
              null,
              models.usable ? 'Available model restored' : 'Waiting for models',
            );
          }
          root.render(
            React.createElement(
              SessionQueryProvider,
              { identity: { userId: scope.userId, sessionId: 'disk-session' } },
              React.createElement(
                WorkspaceQueryProvider,
                { scope, admitted, subscribe },
                React.createElement(Reader),
                React.createElement(Reader),
              ),
            ),
          );
        });
      const snapshot = mode =>
        page.evaluate(async mode => {
          const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open('tulipfarm-model-catalog', 1);
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
          });
          await new Promise((resolve, reject) => {
            const tx = db.transaction('catalogs', 'readwrite');
            const store = tx.objectStore('catalogs');
            const request = store.openCursor();
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) {
                reject(Error('No persisted catalog'));
                return;
              }
              const value = cursor.value;
              if (mode === 'stale') value.updatedAt = Date.now() - 16 * 60000;
              if (mode === 'expired') value.updatedAt = Date.now() - 25 * 3600000;
              if (mode === 'wrong-user') value.userId = 'another-user';
              if (mode === 'wrong-version') value.version = 999;
              if (mode === 'corrupt') value.data = { families: 'invalid' };
              cursor.update(value);
            };
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });
          db.close();
        }, mode);
      await mount();
      await page.getByText('Available model restored', { exact: true }).first().waitFor();
      assert.equal(requests, 1);
      await snapshot('valid');
      await page.reload();
      assert.equal(
        await page.locator('output').count(),
        0,
        'no saved model is displayed before admission mounts the feature',
      );
      await mount();
      await page.getByText('Available model restored', { exact: true }).first().waitFor();
      assert.equal(requests, 1, 'fresh disk snapshot serves both consumers without a network read');
      await snapshot('stale');
      gate = new Promise(resolve => {
        release = resolve;
      });
      await page.reload();
      await mount();
      await page.getByText('Available model restored', { exact: true }).first().waitFor();
      await page.waitForTimeout(150);
      assert.equal(requests, 2, 'stale original timestamp causes one shared refresh');
      release();
      await page.waitForResponse('**/v1/**/model-catalog');
      await page.waitForTimeout(100);
      for (const mode of ['expired', 'wrong-user', 'wrong-version', 'corrupt']) {
        await snapshot(mode);
        gate = new Promise(resolve => {
          release = resolve;
        });
        const before = requests;
        await page.reload();
        await mount();
        await page.getByText('Waiting for models', { exact: true }).first().waitFor();
        await page.waitForTimeout(150);
        assert.equal(await page.getByText('Available model restored', { exact: true }).count(), 0, mode);
        assert.equal(requests, before + 1, `${mode} snapshot falls back to one network read`);
        release();
        await page.getByText('Available model restored', { exact: true }).first().waitFor();
        await snapshot('valid');
      }
      await page.reload();
      await page.evaluate(() => Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }));
      const before = requests;
      await mount();
      await page.getByText('Available model restored', { exact: true }).first().waitFor();
      assert.equal(requests, before + 1, 'blocked storage falls back to memory and network');
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
