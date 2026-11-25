import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';
import { base, tableId, tasksApi, until } from './tasks.fixture.mjs';

// Tasks never show as a table: its table pages open the Tasks board, and the Tables list leaves it out.
const server = await startBuiltApp();
const { origin } = server;
const api = tasksApi();

let browser;
let page;
try {
  browser = await chromium.launch(builderBrowserOptions());
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const lists = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === `${base}/tables`) lists.push(url.searchParams.get('excludeSystem'));
  });
  await api.route(page);

  for (const path of [`/acme/tables/${tableId}`, `/acme/tables/${tableId}/edit`]) {
    await page.goto(`${origin}${path}`);
    await page.waitForURL(`${origin}/acme/tasks`);
    await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  }

  await page.goto(`${origin}/acme/tables`);
  await page.getByText('Customers').first().waitFor();
  await until(() => lists.length > 0, 'The Tables list is read');
  assert.deepEqual([...new Set(lists)], ['tasks'], 'Every table list hides Tasks');
  assert.equal(await page.getByRole('link', { name: 'Tasks', exact: true }).count(), 1, 'Only the sidebar links Tasks');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Tasks table pages open the Tasks board, and table lists leave Tasks out.');
} catch (error) {
  console.error('Unmocked API requests:', api.unhandled);
  await captureBrowserFailure(page, 'tasks-table-redirect');
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
