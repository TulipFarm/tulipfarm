import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { conversationPage, conversationPages } from '../../api/src/conversation-pages.ts';

test('five-page chat request and payload budgets', { timeout: 60000 }, async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
  const original = process.env.CHAT_PAGE_BASE_REF;
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const workspaceId = uuid(9999),
    chatId = uuid(1),
    createdAt = '2026-10-12T00:00:00Z';
  const chats = Array.from({ length: 250 }, (_, i) => ({
    id: uuid(i + 1),
    title: `Operations chat ${i + 1}`,
    titleRevision: 1,
    titleManual: false,
    archived: false,
    isClosed: false,
    activityAt: new Date(Date.parse(createdAt) - i * 1000).toISOString(),
    createdAt,
    projectId: null,
  }));
  const messages = Array.from({ length: 250 }, (_, i) => ({
    id: uuid(1000 + i),
    sequence: i + 1,
    author: i % 2 ? 'assistant' : 'human',
    createdAt,
    parts: [{ kind: 'text', text: `Operations update ${i + 1}: reconcile order inventory and delivery status.` }],
    turn: i === 248 ? { id: uuid(9998), status: 'processing', generation: 0 } : null,
    tools: [],
    calendarResults: [],
  }));
  const list = async value => {
    const cursor = Number(value ?? 0);
    return {
      chats: chats.slice(cursor, cursor + 50),
      nextCursor: cursor + 50 < chats.length ? String(cursor + 50) : null,
    };
  };
  const history = async before => {
    const remaining = messages.filter(row => row.sequence < (before ?? Infinity)),
      rows = remaining.slice(-50);
    return { messages: rows, nextBefore: remaining.length > 50 ? rows[0].sequence : null, hasGitHubProposals: false };
  };
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { port: 0 },
    plugins: [
      {
        name: 'chat-page-measurement',
        enforce: 'pre',
        transform(_code, id) {
          if (!original) return;
          for (const path of [
            'apps/web/src/features/chat/conversation-api.ts',
            'apps/web/src/features/chat/queries.ts',
          ]) {
            if (id.split('?')[0] === `${root}/${path}`)
              return execFileSync('git', ['show', `${original}:${path}`], { cwd: root, encoding: 'utf8' });
          }
        },
        configureServer(server) {
          server.middlewares.use('/page-measurement', async (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end(await server.transformIndexHtml('/page-measurement', '<html><body></body></html>'));
          });
        },
      },
    ],
  });
  let browser;
  const samples = [];
  let reads = [];
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.route('**/v1/**', async route => {
      const url = new URL(route.request().url());
      await new Promise(resolve => setTimeout(resolve, 30));
      let data;
      if (url.pathname.endsWith('/pages')) {
        const input = route.request().postDataJSON();
        data = url.pathname.endsWith('/messages/pages')
          ? {
              chat: chats[0],
              ...(await conversationPages(input.count, input.before, input.known, history, page => page.nextBefore)),
            }
          : await conversationPages(input.count, input.cursor, input.known, list, page => page.nextCursor);
      } else if (url.pathname.endsWith('/messages')) {
        const value = await history(url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null);
        data = { ...value, digest: conversationPage(value).digest };
      } else if (url.pathname.endsWith('/conversations')) {
        const value = await list(url.searchParams.get('cursor'));
        data = { ...value, digest: conversationPage(value).digest };
      } else if (url.pathname.endsWith(`/${chatId}`)) data = chats[0];
      else throw new Error(`Unexpected request ${url.pathname}`);
      reads.push(Buffer.byteLength(JSON.stringify(data)));
      await route.fulfill({ json: data });
    });
    await page.goto(`${server.resolvedUrls.local[0]}page-measurement`);
    await page.evaluate(
      async ({ workspaceId, chatId }) => {
        const f = await import('/test/chat-query-browser-fixture.tsx');
        window.measurement = {
          f,
          chatId,
          api: f.conversationApi(workspaceId, () => {}),
          list: { generation: 0, pages: [] },
          history: { generation: 0, pages: [] },
        };
      },
      { workspaceId, chatId },
    );
    for (let repeat = 0; repeat < 5; repeat++) {
      for (const kind of ['list', 'history']) {
        for (const [step, depth] of [1, 2, 3, 4, 5, 5].entries()) {
          reads = [];
          const result = await page.evaluate(
            async ({ kind, depth }) => {
              const p = window.measurement,
                started = performance.now();
              const data =
                kind === 'list'
                  ? await p.api.list(new AbortController().signal, false, '', depth, null, p.list)
                  : await p.api.history(p.chatId, new AbortController().signal, depth, p.history);
              return { ms: performance.now() - started, rows: (data.chats ?? data.messages).length };
            },
            { kind, depth },
          );
          assert.equal(result.rows, depth * 50);
          if (!original) assert.equal(reads.length, kind === 'history' && depth === 1 ? 2 : 1);
          if (!original && step === 5)
            assert.ok(
              reads.reduce((sum, bytes) => sum + bytes, 0) < 1000,
              'validated unchanged window stays below 1 KiB',
            );
          samples.push({
            repeat,
            kind,
            depth,
            step,
            ...result,
            requests: reads.length,
            bytes: reads.reduce((sum, bytes) => sum + bytes, 0),
          });
        }
      }
      await page.evaluate(
        ({ workspaceId, repeat }) => {
          const p = window.measurement,
            f = p.f;
          const scope = { kind: 'workspace', userId: 'measurement', workspaceId, membershipId: 'member' };
          const admitted = () => true,
            subscribe = () => () => {};
          const node = document.body.appendChild(document.createElement('div')),
            root = f.createRoot(node);
          p.completed = 0;
          function App() {
            const read = f.useConversationHistory(p.api, p.chatId, 5, false);
            f.React.useEffect(() => {
              if (read.state.kind === 'ready' && !read.state.refreshing && !read.state.error) p.completed++;
            }, [read.state.kind, read.state.refreshing, read.state.error]);
            return null;
          }
          p.close = () => {
            root.unmount();
            node.remove();
          };
          root.render(
            f.React.createElement(
              f.SessionQueryProvider,
              { identity: { userId: scope.userId, sessionId: `poll-${repeat}` } },
              f.React.createElement(
                f.WorkspaceQueryProvider,
                { scope, admitted, subscribe },
                f.React.createElement(App),
              ),
            ),
          );
        },
        { workspaceId, repeat },
      );
      await page.waitForFunction(() => window.measurement.completed >= 1);
      reads = [];
      const started = performance.now();
      await page.waitForFunction(() => window.measurement.completed >= 2);
      if (!original) assert.equal(reads.length, 1, 'pending poll uses one bounded validation request');
      samples.push({
        repeat,
        kind: 'poll',
        depth: 5,
        step: 0,
        ms: performance.now() - started,
        requests: reads.length,
        bytes: reads.reduce((sum, bytes) => sum + bytes, 0),
      });
      await page.evaluate(() => window.measurement.close());
    }
    const stats = values => {
      const sorted = values.sort((a, b) => a - b);
      return { median: sorted[2], min: sorted[0], max: sorted[4] };
    };
    const groups = Object.groupBy(samples, sample => `${sample.kind}:${sample.depth}:${sample.step}`);
    console.log(
      JSON.stringify({
        revision: original ?? 'working-tree',
        delayMs: 30,
        repeats: 5,
        results: Object.fromEntries(
          Object.entries(groups).map(([key, rows]) => [
            key,
            {
              ms: stats(rows.map(row => row.ms)),
              requests: stats(rows.map(row => row.requests)),
              bytes: stats(rows.map(row => row.bytes)),
            },
          ]),
        ),
      }),
    );
  } finally {
    await browser?.close();
    await server.close();
  }
});
