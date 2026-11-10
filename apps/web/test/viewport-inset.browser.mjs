import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { assertUncovered } from './browser-controls.mjs';

test('shared edge reservations follow size, visibility and consent without repeated layout writes', async t => {
  const server = await createServer({
    root: new URL('..', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = server.resolvedUrls.local[0];
  await page.route(origin, route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto(origin);
  await page.evaluate(async () => {
    const { mountInsets } = await import('/test/viewport-inset.fixture.mjs');
    window.insets = mountInsets();
  });
  const inset = (property, value) =>
    page.waitForFunction(({ property, value }) => document.documentElement.style.getPropertyValue(property) === value, {
      property,
      value,
    });
  await inset('--floating-bottom-inset', '80px');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await page.locator('[data-viewport-content]').evaluate(node => (node.scrollTop = 1000));
  await assertUncovered(save);
  assert.equal(await save.evaluate(node => getComputedStyle(node.parentElement).bottom), '80px');
  await page.evaluate(() => window.insets.update({ height: 200 }));
  await inset('--floating-bottom-inset', '232px');
  await assertUncovered(save);
  await page.evaluate(() => {
    window.insetWrites = 0;
    window.observer = new MutationObserver(() => window.insetWrites++);
    window.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    window.insets.update({ renders: 1 });
  });
  await page.getByText('Page content 1', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.insetWrites), 0);
  await page.evaluate(() => window.insets.update({ floating: false }));
  await inset('--floating-bottom-inset', '');
  await page.evaluate(() => window.insets.update({ floating: true, height: 48, consent: true }));
  await inset('--floating-bottom-inset', '80px');
  await inset('--consent-inset', '160px');
  await assertUncovered(save);
  const positions = await page.evaluate(() => ({
    content: document.querySelector('[data-viewport-content]').getBoundingClientRect().bottom,
    floating: document.querySelector('[aria-label="Floating control"]').getBoundingClientRect().bottom,
  }));
  assert.equal(positions.content, 652);
  assert.equal(positions.floating, 636);
  await page.getByRole('button', { name: 'Dismiss consent', exact: true }).click();
  await inset('--consent-inset', '');
  await assertUncovered(save);
  await save.click();
  await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  await page.evaluate(() => {
    window.observer.disconnect();
    window.insets.close();
  });
  await inset('--floating-bottom-inset', '');
  await inset('--consent-inset', '');
  assert.deepEqual(errors, []);
});
