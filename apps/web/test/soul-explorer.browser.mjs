import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test(
  'Soul settings explorer is read-only, permission gated and recovers across desktop and mobile states',
  { timeout: 120000 },
  async () => {
    const server = await createServer({
      root: new URL('..', import.meta.url).pathname,
      server: { host: '127.0.0.1', port: 0 },
      logLevel: 'error',
    });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const code = async () => (await page.locator('.sprout-file-explorer-line-text').allTextContents()).join('');
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      page.setDefaultTimeout(15000);
      const url = `${origin}/soul-explorer-mock/settings/soul`;
      await page.goto(`${origin}/soul-explorer-mock/settings`);
      await page.evaluate(() => {
        window.soulRequests = [];
        const fetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const path = new URL(input instanceof Request ? input.url : String(input), location.origin).pathname;
          if (path.includes('/soul/')) window.soulRequests.push(path);
          return fetch(input, init);
        };
      });
      await page.getByRole('link', { name: 'Open Soul', exact: true }).click();
      await page.getByRole('tree', { name: 'Soul', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.soulRequests), [
        '/v1/workspaces/61616161-6161-4161-8161-616161616161/soul/snapshot',
      ]);
      await page.getByRole('treeitem', { name: 'tables', exact: true }).click();
      const file = 'invoices.json';
      await page.getByRole('treeitem', { name: file, exact: true }).click();
      await page.getByRole('region', { name: `tables/${file}` }).waitFor();
      assert.match(await page.getByRole('region', { name: `tables/${file}` }).innerText(), /Invoices/);
      assert.equal(JSON.parse(await code()).id, 'invoices');
      assert.ok(await page.getByRole('tree').evaluate(tree => tree.scrollWidth === tree.clientWidth));
      assert.equal(await page.locator('textarea,[contenteditable="true"]').count(), 0);
      assert.equal(await page.getByRole('button', { name: /^(Save|Delete|Upload|Download)$/ }).count(), 0);
      const search = page.getByLabel('Search soul');
      await search.fill('skills-lock');
      await page
        .getByRole('button', { name: /skills-lock\.json/ })
        .first()
        .waitFor();
      assert.match(await page.getByRole('status').filter({ hasText: 'file name' }).innerText(), /^1 file name,/);
      await search.fill('missing-path');
      await page.getByText('No files or lines match “missing-path”.', { exact: true }).waitFor();
      await search.fill('');
      await page.getByRole('treeitem', { name: 'agents', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      await page.getByRole('treeitem', { name: '72727272-7272-4272-8272-727272727272.json' }).waitFor();
      await page.getByRole('treeitem', { name: 'agents', exact: true }).click();
      await page.getByRole('treeitem', { name: 'agents', exact: true }).click();
      await page.getByRole('treeitem', { name: '72727272-7272-4272-8272-727272727272.json' }).click();
      await page.getByRole('region', { name: 'agents/72727272-7272-4272-8272-727272727272.json' }).waitFor();
      assert.equal(
        await page.evaluate(() => window.soulRequests.length),
        1,
        'folders, files, search and reopening must only use the loaded snapshot',
      );
      let reads = 1;
      for (const width of [320, 375, 414, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await page.getByRole('treeitem', { name: 'soul.json', exact: true }).click();
        await page.getByRole('region', { name: 'soul.json', exact: true }).waitFor();
        assert.equal(
          await page.evaluate(() => window.soulRequests.length),
          ++reads,
          'Refresh loads exactly one new snapshot',
        );
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `page overflow at ${width}`,
        );
      }
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await page.getByRole('link', { name: 'Open Soul', exact: true }).click();
      await page.getByRole('tree', { name: 'Soul', exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => window.soulRequests.length),
        ++reads,
        'returning to the page does not reuse prior content',
      );
      await page.goto(`${url}?soulScenario=unicode`);
      await page.getByRole('treeitem', { name: 'tables', exact: true }).click();
      await page.getByRole('treeitem', { name: 'café_東京.json', exact: true }).click();
      await page.getByRole('region', { name: 'tables/café_東京.json', exact: true }).waitFor();
      assert.equal(JSON.parse(await code()).id, 'café_東京');
      await page.goto(`${url}?soulScenario=many`);
      await page.getByRole('tree', { name: 'Soul', exact: true }).waitFor();
      await page.evaluate(() => {
        const fetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          if (String(input).includes('/soul/')) throw new Error('Browsing must not fetch');
          return fetch(input, init);
        };
      });
      await page.getByRole('treeitem', { name: 'tables', exact: true }).click();
      await page.getByRole('treeitem', { name: 'page-119.json', exact: true }).click();
      await page.getByRole('region', { name: 'tables/page-119.json', exact: true }).waitFor();
      await page.getByLabel('Search soul').fill('page-119');
      await page
        .getByRole('button', { name: /page-119\.json/ })
        .first()
        .waitFor();
      assert.match(await page.getByRole('status').filter({ hasText: 'file name' }).innerText(), /^1 file name,/);
      await page.goto(`${url}?soulScenario=error`);
      await page.getByRole('button', { name: 'Retry read' }).click();
      await page.getByRole('treeitem', { name: 'soul.json', exact: true }).waitFor();
      await page.goto(`${url}?soulScenario=changed`);
      await page.getByRole('heading', { name: 'Soul changed', exact: true }).waitFor();
      assert.equal(await page.getByRole('region', { name: 'soul.json', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Refresh Soul', exact: true }).click();
      await page.getByRole('treeitem', { name: 'soul.json', exact: true }).click();
      await page.getByRole('region', { name: 'soul.json', exact: true }).waitFor();
      for (const scenario of ['binary', 'large']) {
        await page.goto(`${url}?soulScenario=${scenario}`);
        await page.getByRole('treeitem', { name: 'soul.json', exact: true }).click();
        await page.getByRole('heading', { name: 'File cannot be displayed', exact: true }).waitFor();
      }
      await page.goto(`${url}?soulScenario=empty`);
      await page.getByText('No files yet.', { exact: true }).waitFor();
      await page.goto(`${url}?soulScenario=slow`);
      await page.getByRole('heading', { name: 'Loading Soul', exact: true }).waitFor();
      await page.getByRole('treeitem', { name: 'soul.json', exact: true }).waitFor();
      await page.goto(`${url}?soulScenario=oversized`);
      await page.getByRole('heading', { name: 'Soul is too large to display', exact: true }).waitFor();
      assert.equal(await page.getByRole('tree').count(), 0);
      await page.goto(`${url}?soulScenario=refresh-denied`);
      await page.getByRole('treeitem', { name: 'soul.json', exact: true }).click();
      await page.getByRole('region', { name: 'soul.json', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByRole('heading', { name: 'Soul is unavailable', exact: true }).waitFor();
      assert.equal(
        await page.locator('[data-slot="file-explorer"]').count(),
        0,
        'refresh revocation discards the entire loaded snapshot',
      );
      await page.goto(`${url}?soulScenario=denied`);
      await page.getByRole('heading', { name: 'Soul is unavailable', exact: true }).waitFor();
      assert.equal(await page.getByRole('tree').count(), 0);
      await page.goto(`${url}?soulScenario=member`);
      await page.getByRole('heading', { name: 'Soul is unavailable', exact: true }).waitFor();
      assert.equal(await page.getByRole('tree').count(), 0);
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      assert.equal(await page.getByRole('link', { name: 'Open Soul', exact: true }).count(), 0);
      assert.equal(await page.getByRole('link', { name: 'Soul repository', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test('disabled Soul flag hides the explorer and settings navigation', { timeout: 60000 }, async () => {
  const server = await createServer({
    root: new URL('..', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Flags come from the API; the mock workspace leaves this read to the network.
    await page.route('**/v1/feature-flags*', route => route.fulfill({ json: { 'soul-repository-explorer': false } }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/soul-explorer-mock/settings/soul`);
    await page.getByRole('heading', { name: 'Soul is unavailable', exact: true }).waitFor();
    assert.equal(await page.getByRole('tree').count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Soul repository', exact: true }).count(), 0);
  } finally {
    await browser.close();
    await server.close();
  }
});
