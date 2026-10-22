import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

for (const change of ['selection', 'provider authority']) {
  test(
    `${change} conceals both tabs before an unrelated invalidation refresh is released`,
    { timeout: 30000 },
    async () =>
      fixture(async (browser, url) => {
        const context = await browser.newContext();
        const errors = [];
        context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
        const pages = [await context.newPage(), await context.newPage()];
        for (const page of pages) {
          await page.goto(url);
          await page.evaluate(async () => {
            const f = await import('/test/query-authority-fixture.tsx');
            const q = await import('/src/features/integrations/queries.ts');
            const scope = {
              kind: 'workspace',
              userId: 'overlap',
              workspaceId: '11111111-1111-4111-8111-111111111111',
              membershipId: 'member',
            };
            const unrelatedKey = ['unrelated', crypto.randomUUID()];
            const p = { scope, hold: false, version: 1, reads: 0, notices: [], changeSettled: false };
            const channel = new BroadcastChannel('tulipfarm:query:v1');
            channel.onmessage = event => p.notices.push(event.data);
            window.fetch = async url => {
              const path = new URL(url).pathname;
              if (path.endsWith('/selection')) return Response.json({ accountId: null, generation: null, version: 1 });
              if (path.endsWith('/google-workspace'))
                return Response.json({
                  status: 'connected',
                  integrationId: scope.workspaceId,
                  generation: 1,
                  accountId: 'fixture',
                  email: 'fixture@example.test',
                  scopes: [],
                });
              throw new Error(`Unexpected request ${path}`);
            };
            function App() {
              p.runtime = f.useFeatureContext().runtime;
              p.changes = q.useIntegrationChanges();
              q.useGoogleIntegration(scope.workspaceId);
              q.useGitHubSelection(scope.workspaceId, scope.workspaceId);
              f.useFeatureRead({
                key: unrelatedKey,
                load: async () => {
                  p.reads++;
                  if (p.hold)
                    await new Promise(resolve => {
                      p.release = resolve;
                    });
                  return 'Unrelated result';
                },
              });
              p.chat = f.useConversationHistory(
                {
                  history: async () => {
                    await p.chatGate;
                    return {
                      chat: { id: scope.workspaceId },
                      messages: [{ id: 'message', content: `PRIVATE VERSION ${p.version}` }],
                      nextCursor: null,
                    };
                  },
                },
                scope.workspaceId,
                1,
                false,
              );
              return f.React.createElement('output', { id: 'chat' }, JSON.stringify(p.chat.state));
            }
            const root = f.createRoot(document.body.appendChild(document.createElement('div')));
            root.render(
              f.React.createElement(
                f.SessionQueryProvider,
                { identity: { userId: scope.userId, sessionId: 'session' } },
                f.React.createElement(
                  f.WorkspaceQueryProvider,
                  { scope, admitted: () => true, subscribe: () => () => {} },
                  f.React.createElement(App),
                ),
              ),
            );
            p.begin = () => {
              p.hold = true;
              p.chatGate = new Promise(resolve => {
                p.releaseChat = resolve;
              });
              p.blocked = p.runtime.change(scope, { keys: [unrelatedKey] }).then(() => {
                p.changeSettled = true;
              });
            };
            p.close = () => {
              root.unmount();
              channel.close();
            };
            window.proof = p;
          });
          await page.waitForFunction(() => window.proof.chat?.state.kind === 'ready' && window.proof.reads === 1);
        }
        for (const page of pages) {
          await page.evaluate(() => window.proof.begin());
          await page.waitForFunction(() => !!window.proof.release);
        }
        // Hold replacement chat reads so immediate concealment remains observable after dispatch.
        await pages[0].evaluate(change => {
          const p = window.proof;
          p.changed = change === 'selection' ? p.changes.selection(p.scope.workspaceId) : p.changes.authority('google');
          p.synchronouslyConcealed = !p.runtime.client
            .getQueryCache()
            .getAll()
            .some(query => JSON.stringify(query.state.data)?.includes('PRIVATE VERSION 1'));
        }, change);
        await pages[1].waitForFunction(() =>
          window.proof.notices.some(event => event.keys.some(key => key[0] === 'integrations')),
        );
        for (const page of pages) {
          await page.waitForFunction(() => window.proof.chat.state.kind === 'loading', null, { timeout: 1000 });
          assert.equal(
            await page.evaluate(() => window.proof.changeSettled),
            false,
            'concealment does not wait for the unrelated refresh',
          );
          assert.equal(
            await page.evaluate(() =>
              window.proof.runtime.client
                .getQueryCache()
                .getAll()
                .some(query => JSON.stringify(query.state.data)?.includes('PRIVATE VERSION 1')),
            ),
            false,
          );
        }
        assert.equal(
          await pages[0].evaluate(() => window.proof.synchronouslyConcealed),
          true,
          'the sending tab conceals synchronously',
        );
        for (const page of pages) {
          await page.evaluate(() => {
            const p = window.proof;
            p.version = 2;
            p.releaseChat();
          });
          await page.waitForFunction(() => document.getElementById('chat')?.textContent.includes('PRIVATE VERSION 2'));
          assert.equal(
            await page.evaluate(() => window.proof.changeSettled),
            false,
            'chat refresh finishes independently of the unrelated read',
          );
          await page.evaluate(async () => {
            const p = window.proof;
            p.hold = false;
            p.release();
            await p.blocked;
          });
        }
        const notices = await pages[1].evaluate(() =>
          window.proof.notices.filter(event => event.keys.some(key => key[0] === 'integrations')),
        );
        assert.equal(notices.length, 1, 'the confirmed change sends one notice without an observer echo');
        assert.equal(notices[0].kind, 'conceal');
        assert.equal(JSON.stringify(notices).includes('PRIVATE'), false);
        for (const page of pages) await page.evaluate(() => window.proof.close());
        assert.deepEqual(errors, []);
      }),
  );
}

async function fixture(run) {
  const server = await createServer({
    cacheDir: 'node_modules/.vite-chat-dependencies',
    server: { port: 0 },
    plugins: [
      {
        name: 'dependency-proof',
        configureServer(server) {
          server.middlewares.use('/dependency-proof', async (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end(await server.transformIndexHtml('/dependency-proof', '<html><body></body></html>'));
          });
        },
      },
    ],
  });
  await server.listen();
  const browser = await chromium.launch();
  try {
    await run(browser, `${server.resolvedUrls.local[0]}dependency-proof`);
  } finally {
    await browser.close();
    await server.close();
  }
}

test(
  'task source picker follows chat create, rename, archive, draft upload, send and attachment changes',
  { timeout: 60000 },
  async () =>
    fixture(async (browser, url) => {
      const page = await browser.newPage();
      await page.goto(url);
      await page.evaluate(async () => {
        const f = await import('/test/chat-query-browser-fixture.tsx');
        const { React, createRoot, SessionQueryProvider, WorkspaceQueryProvider } = f;
        const scope = { kind: 'workspace', userId: 'dependencies', workspaceId: 'workspace', membershipId: 'member' };
        const chat = {
          id: 'chat',
          title: 'Original',
          archived: false,
          titleRevision: 1,
          titleManual: false,
          activityAt: '2026-10-02',
          createdAt: '2026-10-02',
        };
        const p = { chats: [chat], messages: [], files: {}, reads: { list: 0, history: 0, attachment: 0 }, show: true };
        const api = {
          ...f.conversationApi(scope.workspaceId, () => {}),
          list: async () => {
            p.reads.list++;
            return { chats: structuredClone(p.chats.filter(chat => !chat.archived)), nextCursor: null };
          },
          history: async id => {
            p.reads.history++;
            return {
              chat: structuredClone(p.chats.find(chat => chat.id === id)),
              messages: structuredClone(p.messages),
              nextBefore: null,
              hasGitHubProposals: false,
            };
          },
          attachment: async (_chatId, id) => {
            p.reads.attachment++;
            return structuredClone(p.files[id]);
          },
          upload: async (_chatId, id, file) => {
            p.files[id] = { id, filename: file.name, state: 'ready' };
            return p.files[id];
          },
          command: async command => {
            if (command.kind === 'create')
              p.chats.push({ ...chat, id: command.chatId, title: 'Draft upload', archived: false });
            if (command.kind === 'rename') p.chats.find(chat => chat.id === command.chatId).title = command.title;
            if (command.kind === 'archive')
              p.chats.find(chat => chat.id === command.chatId).archived = command.archived;
            if (command.kind === 'send') {
              p.messages.push({
                id: 'message',
                sequence: 1,
                author: 'human',
                parts: command.parts,
                turn: null,
                tools: [],
              });
              for (const part of command.parts)
                if (part.kind === 'attachment') p.files[part.attachmentId].state = 'bound';
            }
            return { id: command.chatId };
          },
        };
        function Picker() {
          p.chatsRead = f.useTaskSourceChats(api, true);
          p.filesRead = f.useTaskSourceFiles(api, 'draft', true);
          return React.createElement(
            'output',
            { id: 'picker' },
            JSON.stringify({ chats: p.chatsRead.state, files: p.filesRead.state }),
          );
        }
        function Attachments() {
          p.chatAttachment = f.useConversationAttachment(api, 'draft', p.fileId);
          p.taskAttachment = f.useTaskAttachment(api, 'draft', p.fileId);
          return React.createElement(
            'output',
            { id: 'attachments' },
            JSON.stringify([p.chatAttachment.state, p.taskAttachment.state]),
          );
        }
        function App() {
          p.changes = f.useConversationChanges();
          p.list = f.useConversationList(api, false, '', 1);
          p.write = f.useConversationCommand(api, () => {});
          const draft = React.useMemo(
            () =>
              f.draftConversationApi(api, 'draft', () => {
                void p.changes.created('draft');
              }),
            [],
          );
          p.uploads = f.useConversationAttachments(draft, 'draft');
          return React.createElement(
            React.Fragment,
            null,
            p.show && React.createElement(Picker),
            p.fileId && React.createElement(Attachments),
          );
        }
        const root = createRoot(document.body.appendChild(document.createElement('div')));
        p.render = () =>
          root.render(
            React.createElement(
              SessionQueryProvider,
              { identity: { userId: scope.userId, sessionId: 'dependencies' } },
              React.createElement(
                WorkspaceQueryProvider,
                { scope, admitted: () => true, subscribe: () => () => {} },
                React.createElement(App),
              ),
            ),
          );
        window.proof = p;
        p.render();
      });
      await page.waitForFunction(
        () => window.proof.chatsRead?.state.kind === 'ready' && window.proof.filesRead?.state.kind === 'ready',
      );
      await page.evaluate(() =>
        window.proof.write.submit({
          kind: 'rename',
          chatId: 'chat',
          commandId: 'rename',
          title: 'Renamed',
          expectedRevision: 1,
        }),
      );
      assert.match(await page.locator('#picker').textContent(), /Renamed/, 'mounted picker refreshes after rename');
      await page.evaluate(() =>
        window.proof.write.submit({ kind: 'archive', chatId: 'chat', commandId: 'archive', archived: true }),
      );
      assert.deepEqual(
        await page.evaluate(() => window.proof.chatsRead.state.data.chats),
        [],
        'archived chats leave the picker',
      );
      await page.evaluate(() => window.proof.uploads.add([new File(['content'], 'draft.txt')]));
      await page.waitForFunction(() => window.proof.uploads.files[0]?.kind === 'ready');
      await page.waitForFunction(() => window.proof.chatsRead.state.data.chats.some(chat => chat.id === 'draft'));
      assert.deepEqual(
        await page.evaluate(() => window.proof.filesRead.state.data),
        [],
        'uploaded but unsent files are not task context',
      );
      await page.evaluate(() => {
        const p = window.proof;
        p.fileId = p.uploads.files[0].id;
        p.render();
      });
      await page.waitForFunction(
        () =>
          window.proof.taskAttachment?.state.kind === 'ready' && window.proof.chatAttachment?.state.kind === 'ready',
      );
      assert.equal(
        await page.evaluate(() => window.proof.reads.attachment),
        1,
        'same attachment shape shares one canonical read',
      );
      await page.evaluate(() => {
        const p = window.proof;
        return p.write.submit({
          kind: 'send',
          chatId: 'draft',
          commandId: 'send',
          messageId: 'message',
          model: 'model',
          parts: [{ kind: 'attachment', attachmentId: p.fileId }],
        });
      });
      assert.deepEqual(
        await page.evaluate(() => window.proof.filesRead.state.data.map(file => [file.filename, file.state])),
        [['draft.txt', 'bound']],
      );
      assert.equal(await page.evaluate(() => window.proof.taskAttachment.state.data.state), 'bound');
      await page.evaluate(() => {
        const p = window.proof;
        p.show = false;
        p.render();
      });
      await page.locator('#picker').waitFor({ state: 'detached' });
      await page.evaluate(() =>
        window.proof.write.submit({
          kind: 'rename',
          chatId: 'draft',
          commandId: 'rename-inactive',
          title: 'Changed while closed',
          expectedRevision: 1,
        }),
      );
      await page.evaluate(() => {
        window.proof.show = true;
        window.proof.render();
      });
      await page.waitForFunction(() => document.querySelector('#picker')?.textContent.includes('Changed while closed'));
    }),
);

test(
  'successful GitHub selection conceals only its chat and batches while fresh reads stall or fail, including another tab',
  { timeout: 60000 },
  async () =>
    fixture(async (browser, url) => {
      const context = await browser.newContext();
      const id = '11111111-1111-4111-8111-111111111111',
        second = '22222222-2222-4222-8222-222222222222';
      let selected = id,
        hold = false,
        fail = false,
        writes = 0;
      const pending = [];
      await context.route('**/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/accounts'))
          return route.fulfill({
            json: {
              configured: true,
              accounts: [id, second].map((id, index) => ({
                id,
                state: 'active',
                configured: true,
                identity: { id: String(index + 1), login: index ? 'second' : 'first' },
                generation: 1,
                scopes: [],
              })),
            },
          });
        if (path.endsWith('/selection')) {
          if (route.request().method() === 'PUT') {
            selected = second;
            writes++;
          }
          return route.fulfill({ json: { accountId: selected, generation: 1, version: writes + 1 } });
        }
        if (path.includes('/github/')) {
          if (hold) await new Promise(resolve => pending.push(resolve));
          return route.fulfill({
            status: fail ? 503 : 200,
            json: fail
              ? { error: 'unavailable' }
              : { batches: selected === id ? [{ id, decision: null, actions: [] }] : [] },
          });
        }
        if (hold) await new Promise(resolve => pending.push(resolve));
        return route.fulfill({
          status: fail ? 503 : 200,
          json: fail
            ? { error: 'unavailable' }
            : { text: selected === id ? 'Old private source reply' : 'Fresh context' },
        });
      });
      async function mount(page) {
        await page.goto(url);
        await page.evaluate(async id => {
          const f = await import('/test/chat-query-browser-fixture.tsx');
          const { React, createRoot, SessionQueryProvider, WorkspaceQueryProvider } = f;
          const scope = { kind: 'workspace', userId: 'selection', workspaceId: id, membershipId: 'member' };
          const p = { pages: 1 };
          const api = {
            ...f.conversationApi(id, () => {}),
            history: async (chatId, signal) => {
              if (chatId === 'unrelated')
                return { chat: { id: chatId }, messages: [{ parts: [{ text: 'Unaffected chat' }] }], nextBefore: null };
              await p.pageGate;
              const response = await fetch(`/v1/history/${chatId}`, { signal });
              if (!response.ok) throw Error('History unavailable');
              const { text } = await response.json();
              return { chat: { id: chatId }, messages: [{ parts: [{ text }] }], nextBefore: null };
            },
          };
          function App() {
            const [pages, setPages] = React.useState(1);
            p.pages = pages;
            p.expand = () => setPages(2);
            p.history = f.useConversationHistory(api, id, p.pages, false);
            p.other = f.useConversationHistory(api, 'unrelated', 1, false);
            p.batches = f.useGitHubBatches(id, id);
            return React.createElement(
              React.Fragment,
              null,
              React.createElement(f.GitHubAccountCard, {
                workspaceId: id,
                chatId: id,
                slug: 'test',
                disabled: false,
                picked: () => {},
              }),
              React.createElement('output', { id: 'history' }, JSON.stringify(p.history.state)),
              React.createElement('output', { id: 'other' }, JSON.stringify(p.other.state)),
              React.createElement('output', { id: 'batches' }, JSON.stringify(p.batches.state)),
            );
          }
          const route = f.createRootRoute({ component: App });
          const router = f.createRouter({ routeTree: route });
          const root = createRoot(document.body.appendChild(document.createElement('div')));
          p.render = () =>
            root.render(
              React.createElement(
                SessionQueryProvider,
                { identity: { userId: scope.userId, sessionId: 'selection' } },
                React.createElement(
                  WorkspaceQueryProvider,
                  { scope, admitted: () => true, subscribe: () => () => {} },
                  React.createElement(f.RouterProvider, { router }),
                ),
              ),
            );
          window.proof = p;
          p.render();
        }, id);
        await page.getByRole('button', { name: 'second', exact: true }).waitFor();
        await page.waitForFunction(
          () => window.proof.history?.state.kind === 'ready' && window.proof.batches.state.kind === 'ready',
        );
      }
      const page = await context.newPage(),
        other = await context.newPage();
      await mount(page);
      await mount(other);
      await other.evaluate(() => {
        const p = window.proof;
        p.pageGate = new Promise(resolve => {
          p.releasePage = resolve;
        });
        p.expand();
      });
      await other.waitForFunction(
        () => window.proof.history.state.kind === 'ready' && window.proof.history.state.refreshing,
      );
      hold = true;
      await page.getByRole('button', { name: 'second', exact: true }).click();
      await page.waitForFunction(() => window.proof.history.state.kind === 'loading', null, { timeout: 3000 });
      for (const tab of [page, other]) {
        await tab.waitForFunction(
          () => window.proof.history.state.kind === 'loading' && window.proof.batches.state.kind === 'loading',
        );
        assert.doesNotMatch(await tab.locator('#history').textContent(), /Old private source reply/);
        assert.doesNotMatch(await tab.locator('#batches').textContent(), /11111111/);
        assert.match(await tab.locator('#other').textContent(), /Unaffected chat/);
      }
      fail = true;
      hold = false;
      pending.splice(0).forEach(resolve => resolve());
      await other.evaluate(() => window.proof.releasePage());
      for (const tab of [page, other]) {
        await tab.waitForFunction(
          () => window.proof.history.state.kind === 'error' && window.proof.batches.state.kind === 'error',
        );
        assert.doesNotMatch(await tab.locator('#history').textContent(), /Old private source reply/);
      }
      fail = false;
      await page.evaluate(() => Promise.all([window.proof.history.refresh(), window.proof.batches.refresh()]));
      assert.match(await page.locator('#history').textContent(), /Fresh context/);
      assert.equal(writes, 1);
    }),
);
