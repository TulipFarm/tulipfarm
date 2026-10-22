import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test(
  'React providers share reads and polling, retain refresh errors, and fence session replacement',
  { timeout: 60_000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { port: 0 },
      plugins: [
        {
          name: 'query-test-page',
          configureServer(server) {
            server.middlewares.use('/query-test', async (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(await server.transformIndexHtml('/query-test', '<html><body></body></html>'));
            });
          },
        },
      ],
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${server.resolvedUrls.local[0]}query-test`);
      const result = await page.evaluate(async () => {
        const { React, createRoot, SessionQueryProvider, WorkspaceQueryProvider, useFeatureRead, useFeatureChanges } =
          await import('/test/query-browser-fixture.tsx');
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const wait = async predicate => {
          for (let i = 0; i < 200 && !predicate(); i++) await sleep(10);
          if (!predicate()) throw new Error('Timed out');
        };
        const element = document.createElement('div');
        document.body.replaceChildren(element);
        const root = createRoot(element);
        let calls = 0;
        let failure = false;
        let pending = true;
        let refresh;
        let change;
        const scope = { kind: 'workspace', userId: 'alice', workspaceId: 'workspace', membershipId: 'member' };
        const admitted = () => true;
        const subscribe = () => () => {};
        const load = async () => {
          calls++;
          if (failure) throw Object.assign(new Error('bad request'), { status: 422 });
          return { pending };
        };
        function Reader() {
          const read = useFeatureRead({
            key: ['test'],
            load,
            pollWhile: data => data.pending,
            interval: 100,
            maxChecks: 2,
          });
          refresh = read.refresh;
          change = useFeatureChanges().change;
          return React.createElement('output', null, JSON.stringify({ state: read.state, delayed: read.delayed }));
        }
        const render = sessionId =>
          root.render(
            React.createElement(
              React.StrictMode,
              null,
              React.createElement(
                SessionQueryProvider,
                { identity: { userId: 'alice', sessionId } },
                React.createElement(
                  WorkspaceQueryProvider,
                  { scope, admitted, subscribe },
                  React.createElement(Reader),
                  React.createElement(Reader),
                ),
              ),
            ),
          );
        render('one');
        await wait(() => element.textContent.includes('ready'));
        const initial = calls;
        window.dispatchEvent(new Event('focus'));
        await sleep(20);
        const afterFocus = calls;
        await wait(() => element.textContent.includes('"delayed":true'));
        const afterBudget = calls;
        await sleep(150);
        const afterExhaustion = calls;
        failure = true;
        await refresh();
        await wait(() => element.textContent.includes('Check your connection'));
        const retained = element.textContent.includes('"kind":"ready"');
        failure = false;
        pending = false;
        await change({ keys: [['test']] });
        await wait(() => element.textContent.includes('"pending":false'));
        const beforeReplacement = calls;
        render('two');
        await wait(() => calls > beforeReplacement && element.textContent.includes('ready'));
        root.unmount();
        return {
          initial,
          afterFocus,
          afterBudget,
          afterExhaustion,
          retained,
          replacementReads: calls - beforeReplacement,
        };
      });
      // StrictMode aborts its first mount's read, then starts one shared read on remount.
      assert.deepEqual(result, {
        initial: 2,
        afterFocus: 2,
        afterBudget: 4,
        afterExhaustion: 4,
        retained: true,
        replacementReads: 2,
      });
      const second = await context.newPage();
      await second.goto(`${server.resolvedUrls.local[0]}query-test`);
      for (const tab of [page, second])
        await tab.evaluate(async () => {
          const { createFeatureClient, QueryObserver } = await import('/test/query-browser-fixture.tsx');
          const scope = { kind: 'workspace', userId: 'cross-tab', workspaceId: 'workspace', membershipId: 'member' };
          const runtime = createFeatureClient({ userId: scope.userId, sessionId: 'session' }, { visible: () => true });
          runtime.start();
          runtime.admit(scope);
          const key = [
            'user',
            scope.userId,
            'workspace',
            scope.workspaceId,
            'membership',
            scope.membershipId,
            'credits',
          ];
          const state = { calls: 0, notices: 0 };
          const observer = new QueryObserver(runtime.client, { queryKey: key, queryFn: async () => ++state.calls });
          const unsubscribe = observer.subscribe(() => {});
          const channel = new BroadcastChannel('tulipfarm:query:v1');
          channel.onmessage = () => {
            state.notices++;
          };
          window.queryProof = {
            runtime,
            scope,
            state,
            close: () => {
              channel.close();
              unsubscribe();
              runtime.stop();
            },
          };
        });
      await page.evaluate(() => window.queryProof.runtime.change(window.queryProof.scope, { keys: [['credits']] }));
      await second.waitForFunction(() => window.queryProof.state.calls === 2);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(await page.evaluate(() => window.queryProof.state), { calls: 2, notices: 1 });
      assert.deepEqual(await second.evaluate(() => window.queryProof.state), { calls: 2, notices: 1 });
      await page.evaluate(() => window.queryProof.close());
      await second.evaluate(() => window.queryProof.close());
      // Real BroadcastChannels carry authority notices while a transport ignores cancellation.
      for (const tab of [page, second])
        await tab.evaluate(async () => {
          const { createFeatureClient, featureReadOptions, featureKey } =
            await import('/test/query-browser-fixture.tsx');
          const scope = {
            kind: 'workspace',
            userId: 'authority-user',
            workspaceId: 'workspace',
            membershipId: 'member',
          };
          const lost = [];
          const runtime = createFeatureClient(
            { userId: scope.userId, sessionId: 'current-session' },
            { authorityLost: scope => lost.push(scope) },
          );
          runtime.start();
          runtime.admit(scope);
          const other = { ...scope, workspaceId: 'other' };
          const replacement = { ...scope, membershipId: 'replacement' };
          runtime.client.setQueryData(featureKey(other, ['private']), 'other workspace');
          runtime.client.setQueryData(featureKey(replacement, ['private']), 'new membership');
          const late = Promise.withResolvers();
          let signal;
          const key = featureKey(scope, ['private']);
          const request = runtime.client
            .fetchQuery(
              featureReadOptions(runtime, scope, {
                key: ['private'],
                load: incoming => {
                  signal = incoming;
                  return late.promise;
                },
              }),
            )
            .catch(() => undefined);
          const notices = [];
          const channel = new BroadcastChannel('tulipfarm:query:v1');
          channel.onmessage = event => notices.push(event.data);
          window.authorityProof = {
            runtime,
            scope,
            other,
            replacement,
            key,
            late,
            request,
            lost,
            notices,
            channel,
            signal,
          };
        });
      await page.evaluate(() => {
        const { channel, scope } = window.authorityProof;
        channel.postMessage({
          version: 1,
          id: 'old-logout',
          sessionId: 'old-session',
          scope: { kind: 'account', userId: scope.userId },
          kind: 'logout',
          keys: [],
        });
        channel.postMessage({
          version: 1,
          id: 'wrong-user',
          sessionId: 'current-session',
          scope: { ...scope, userId: 'someone-else' },
          kind: 'denied',
          keys: [],
        });
      });
      await second.waitForFunction(() => window.authorityProof.notices.length === 2);
      assert.equal(
        await second.evaluate(() => window.authorityProof.runtime.isCurrent(window.authorityProof.scope)),
        true,
      );
      await page.evaluate(() => window.authorityProof.runtime.revoke(window.authorityProof.scope, true));
      await second.waitForFunction(() => window.authorityProof.lost.length === 1);
      for (const tab of [page, second]) {
        const authority = await tab.evaluate(async () => {
          const { featureKey } = await import('/test/query-browser-fixture.tsx');
          const proof = window.authorityProof;
          proof.late.resolve('late private data');
          await proof.request;
          await new Promise(resolve => setTimeout(resolve, 100));
          return {
            aborted: proof.signal.aborted,
            removed: proof.runtime.client.getQueryData(proof.key) === undefined,
            other: proof.runtime.client.getQueryData(featureKey(proof.other, ['private'])),
            replacement: proof.runtime.client.getQueryData(featureKey(proof.replacement, ['private'])),
            lost: proof.lost.length,
            deniedNotices: proof.notices.filter(
              event => event.kind === 'denied' && event.scope.userId === proof.scope.userId,
            ).length,
          };
        });
        assert.deepEqual(authority, {
          aborted: true,
          removed: true,
          other: 'other workspace',
          replacement: 'new membership',
          lost: 1,
          deniedNotices: 1,
        });
        await tab.evaluate(() => {
          window.authorityProof.channel.close();
          window.authorityProof.runtime.stop();
        });
      }
      const persisted = await page.evaluate(async () => {
        const { createFeatureClient } = await import('/test/query-browser-fixture.tsx');
        const runtime = createFeatureClient({ userId: 'catalog-user', sessionId: 'catalog-session' });
        const scope = { kind: 'workspace', userId: 'catalog-user', workspaceId: 'workspace', membershipId: 'member' };
        runtime.start();
        runtime.admit(scope);
        const updatedAt = Date.now() - 16 * 60_000;
        await runtime.catalog.save(scope, { families: [] }, updatedAt, () => true);
        await Promise.all([
          runtime.prepareCatalog(scope, ['models', 'catalog'], () => true),
          runtime.prepareCatalog(scope, ['models', 'catalog'], () => true),
        ]);
        const key = [
          'user',
          scope.userId,
          'workspace',
          scope.workspaceId,
          'membership',
          scope.membershipId,
          'models',
          'catalog',
        ];
        const restored = runtime.client.getQueryState(key);
        runtime.revoke(scope);
        const saved = await runtime.catalog.restore(scope, () => true);
        const result = {
          timestamp: restored?.dataUpdatedAt === updatedAt,
          data: restored?.data,
          revoked: runtime.client.getQueryData(key) === undefined,
          diskCleared: saved === null,
        };
        runtime.stop();
        return result;
      });
      assert.deepEqual(persisted, { timestamp: true, data: { families: [] }, revoked: true, diskCleared: true });
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
