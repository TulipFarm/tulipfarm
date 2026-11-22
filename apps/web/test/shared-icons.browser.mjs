import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test(
  'shared icons preserve labels, keyboard actions, disabled sorting and persisted dismissals',
  { timeout: 60000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        {
          name: 'shared-icons-fixture',
          configureServer(server) {
            server.middlewares.use('/shared-icons-proof', async (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(
                await server.transformIndexHtml(
                  '/shared-icons-proof',
                  '<html><body><div id="root"></div><script type="module" src="/test/shared-icons.fixture.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
    });
    let browser;
    try {
      await server.listen();
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.resolvedUrls.local[0]}shared-icons-proof`);
      await page.getByText('Restricted', { exact: true }).waitFor({ state: 'attached' });
      assert.equal(await page.getByText('general', { exact: true }).count(), 1);
      assert.equal(await page.getByText('finance', { exact: true }).count(), 1);
      assert.equal(await page.getByText('(private channel)', { exact: true }).count(), 1);
      assert.equal(await page.getByRole('img', { name: 'Pinned', exact: true }).count(), 1);
      const header = page.getByRole('table', { name: 'Customers', exact: true }).getByRole('columnheader');
      const sort = page.getByRole('button', { name: /^Sort by Name/ });
      for (const expected of ['ascending', 'descending', null]) {
        await sort.press('Enter');
        assert.equal(await header.getAttribute('aria-sort'), expected);
        assert.equal(await sort.evaluate(element => document.activeElement === element), true);
      }
      await page.getByRole('button', { name: 'Toggle sorting availability' }).click();
      assert.equal(await sort.isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: /Plan work/ }).isDisabled(), true);
      await page.getByRole('button', { name: 'Toggle sorting availability' }).click();
      const hint = page.getByRole('button', { name: 'About Access' });
      await page.keyboard.press('Tab');
      assert.equal(await hint.evaluate(element => document.activeElement === element), true);
      await page.getByRole('tooltip').getByText('Only permitted members can read this item.').waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('tooltip').waitFor({ state: 'hidden' });
      const selected = page.getByLabel('Selected action');
      await page.getByRole('button', { name: 'Create table', exact: true }).press('Enter');
      assert.equal(await selected.textContent(), 'Create table');
      await page.getByRole('button', { name: 'Dismiss create table' }).press('Enter');
      await page.getByRole('button', { name: 'Create table', exact: true }).waitFor({ state: 'hidden' });
      await page.reload();
      await sort.waitFor();
      assert.equal(await page.getByRole('button', { name: 'Dismiss create table' }).count(), 0);
      for (const [width, colorScheme] of [
        [1280, 'light'],
        [390, 'dark'],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        for (const action of ['Plan work', 'Track work']) {
          await page.getByRole('button', { name: new RegExp(action) }).press('Enter');
          assert.equal(await selected.textContent(), action);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(await page.locator('main svg:not([aria-hidden="true"])').count(), 0);
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
