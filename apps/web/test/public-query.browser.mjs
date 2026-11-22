import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test(
  'options the page already fetched render on the first paint, once and only for the same URL',
  { timeout: 90_000 },
  async () => {
    const server = await createServer({
      cacheDir: 'node_modules/.vite-public-query-browser',
      server: { port: 0 },
      plugins: [
        {
          name: 'public-query-test',
          configureServer(server) {
            server.middlewares.use('/public-query-test', async (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(await server.transformIndexHtml('/public-query-test', '<html><body></body></html>'));
            });
          },
        },
      ],
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.resolvedUrls.local[0]}public-query-test`);
      const result = await page.evaluate(async () => {
        const { React, createRoot, flushSync, PublicAuthQueryProvider, useAuthOptions, apiOrigin } =
          await import('/test/public-query-fixture.tsx');
        const calls = [];
        window.fetch = async url => {
          calls.push(new URL(url).pathname);
          return Response.json({ turnstileSiteKey: 'network-key' });
        };
        const early =
          data =>
          (url = `${apiOrigin}/v1/auth/options`) => ({
            url: new URL(url, location.href).href,
            response: Promise.resolve(Response.json(data)),
            data,
          });
        function Reader() {
          const read = useAuthOptions();
          return React.createElement('output', null, read.data?.turnstileSiteKey ?? read.status);
        }
        const firstPaint = async seed => {
          window.__tfAuthOptions = seed;
          const root = createRoot(document.body.appendChild(document.createElement('div')));
          flushSync(() => root.render(React.createElement(PublicAuthQueryProvider, null, React.createElement(Reader))));
          await new Promise(resolve => requestAnimationFrame(resolve));
          const text = document.querySelector('output')?.textContent;
          root.unmount();
          document.body.replaceChildren();
          return text;
        };
        const seeded = await firstPaint(early({ turnstileSiteKey: 'early-key', google: true })());
        const seededCalls = calls.length;
        const consumed = window.__tfAuthOptions === undefined;
        const otherUrl = await firstPaint(
          early({ turnstileSiteKey: 'early-key' })('https://elsewhere.test/v1/auth/options'),
        );
        const invalid = await firstPaint(early({ turnstileSiteKey: 42 })());
        return { seeded, seededCalls, consumed, otherUrl, invalid };
      });
      assert.equal(result.seeded, 'early-key');
      assert.equal(result.seededCalls, 0);
      assert.equal(result.consumed, true);
      assert.equal(result.otherUrl, 'pending', 'Options fetched for another API origin are not used');
      assert.notEqual(result.invalid, '42', 'Options that fail the schema are not rendered');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test(
  'public options share a memory-only client without session context or focus reads',
  { timeout: 90_000 },
  async () => {
    const server = await createServer({
      cacheDir: 'node_modules/.vite-public-query-browser',
      server: { port: 0 },
      plugins: [
        {
          name: 'public-query-test',
          configureServer(server) {
            server.middlewares.use('/public-query-test', async (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(await server.transformIndexHtml('/public-query-test', '<html><body></body></html>'));
            });
          },
        },
      ],
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.resolvedUrls.local[0]}public-query-test`);
      const result = await page.evaluate(async () => {
        const { React, createRoot, PublicAuthQueryProvider, useAuthOptions, focusManager, onlineManager } =
          await import('/test/public-query-fixture.tsx');
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const wait = async predicate => {
          for (let i = 0; i < 400 && !predicate(); i++) await sleep(10);
          if (!predicate()) throw new Error(document.body.textContent);
        };
        const calls = [];
        let release,
          fail = false,
          retry;
        window.fetch = async (url, init) => {
          calls.push({ path: new URL(url).pathname, credentials: init.credentials });
          if (calls.length === 1)
            await new Promise(resolve => {
              release = resolve;
            });
          return fail ? Response.json({}, { status: 503 }) : Response.json({ turnstileSiteKey: 'public-site-key' });
        };
        function Reader() {
          const read = useAuthOptions();
          retry = read.refetch;
          return React.createElement('output', null, read.data?.turnstileSiteKey ?? read.status);
        }
        const root = createRoot(document.body.appendChild(document.createElement('div')));
        const render = count =>
          root.render(
            React.createElement(
              PublicAuthQueryProvider,
              null,
              Array.from({ length: count }, (_, key) => React.createElement(Reader, { key })),
            ),
          );
        render(2);
        await wait(() => !!release && document.querySelectorAll('output').length === 2);
        const loading = [...document.querySelectorAll('output')].map(node => node.textContent);
        const concurrent = calls.length;
        release();
        await wait(() =>
          [...document.querySelectorAll('output')].every(node => node.textContent === 'public-site-key'),
        );
        render(0);
        await sleep(30);
        render(2);
        await sleep(30);
        const revisit = calls.length;
        const now = Date.now;
        Date.now = () => now() + 16 * 60_000;
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        window.dispatchEvent(new Event('focus'));
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
        await sleep(80);
        Date.now = now;
        const afterFocus = calls.length;
        const storage = {
          local: localStorage.length,
          session: sessionStorage.length,
          databases: (await indexedDB.databases()).length,
        };
        root.unmount();
        fail = true;
        const next = createRoot(document.body.appendChild(document.createElement('div')));
        next.render(React.createElement(PublicAuthQueryProvider, null, React.createElement(Reader)));
        await wait(() => document.querySelector('output')?.textContent === 'error');
        await sleep(1200);
        const failed = calls.length;
        fail = false;
        await retry();
        await wait(() => document.querySelector('output')?.textContent === 'public-site-key');
        next.unmount();
        return { loading, concurrent, revisit, afterFocus, storage, failed, calls };
      });
      assert.deepEqual(result.loading, ['pending', 'pending']);
      assert.equal(result.concurrent, 1);
      assert.equal(result.revisit, 1);
      assert.equal(result.afterFocus, 1, 'Even stale public options ignore focus and reconnect');
      assert.deepEqual(result.storage, { local: 0, session: 0, databases: 0 });
      assert.equal(result.failed, 2, 'A new provider has no persisted options and failure does not retry');
      assert.deepEqual(result.calls, Array(3).fill({ path: '/v1/auth/options', credentials: 'omit' }));
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
