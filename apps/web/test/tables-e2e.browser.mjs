// Run via TABLE_EXECUTION_BROWSER=1 node --test apps/worker/test/table-execution.integration.mjs.
// Shipped React components, real authenticated HTTP routes, PostgreSQL and Temporal.
// Full shipped entrypoint/router/shell. Soul uses the worker fixture's local S3 HTTP implementation.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';

export async function proveTableBrowser(input) {
  const { app, origin, cookie } = input;
  const api = app.server.listening
    ? `http://127.0.0.1:${app.server.address().port}`
    : await app.listen({ host: '127.0.0.1', port: 0 });
  const pageErrors = [];
  const statuses = [];
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify(origin) },
    server: {
      host: 'localhost',
      port: Number(new URL(origin).port),
      strictPort: true,
      proxy: { '/v1': { target: api, rewrite: path => path.replace(/^\/v1/, '') } },
    },
  });
  let browser;
  try {
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.addCookies(
      cookie.split('; ').map(part => ({
        name: part.slice(0, part.indexOf('=')),
        value: part.slice(part.indexOf('=') + 1),
        url: origin,
        httpOnly: true,
        sameSite: 'Lax',
      })),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => pageErrors.push(error.name));
    page.on('response', response => {
      if (new URL(response.url()).pathname.startsWith('/v1/')) {
        statuses.push(response.status());
        if (response.status() >= 400)
          process.stdout.write(
            `${JSON.stringify({ event: 'browser-http-failure', path: new URL(response.url()).pathname, status: response.status() })}\n`,
          );
      }
    });
    await page.goto(`${origin}/acceptance/chat/${input.chatId}`);
    await page.getByRole('button', { name: 'Workspace menu, Acceptance support' }).waitFor();
    const card = page.getByRole('region', { name: 'Table change proposal' }).last();
    await card.getByRole('heading', { name: 'Ready for your approval', exact: true }).waitFor();
    await card.getByRole('button', { name: /^Approve/ }).click();
    await card.locator('a').filter({ hasText: 'View table' }).waitFor({ timeout: 45000 });
    await page.getByRole('link', { name: 'Tables', exact: true }).click();
    await page.getByRole('heading', { name: 'Tables', exact: true, level: 1 }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page
      .getByRole('list', { name: /^Tables, \d+ rows?$/ })
      .getByRole('listitem', { name: 'Browser execution tickets', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Browser execution tickets', exact: true, level: 1 }).waitFor();
    const headers = { cookie, origin };
    const base = `/workspaces/${input.workspaceId}/tables/${input.tableId}`;
    const state = (await app.inject({ url: base, headers })).json();
    // Row actions are named after the row's values, so find the row by its current text.
    const rowAction = async (id, item) => {
      const rows = (await app.inject({ url: `${base}/rows?revision=${state.applied.revision}`, headers })).json();
      const text = Object.values(rows.find(row => row.id === id).values).find(value => value?.kind === 'text').value;
      await page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: text, exact: true }) })
        .first()
        .getByRole('button', { name: /^Actions for / })
        .click();
      await page.getByRole('menuitem', { name: item, exact: true }).click();
    };
    const openPanel = async name => {
      await page.getByRole('button', { name: 'More table options', exact: true }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
      await page.getByRole('dialog', { name, exact: true }).waitFor();
    };
    const closePanel = async () => {
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'detached' });
    };
    await rowAction(input.recordId, 'Edit row');
    await page.getByLabel('Title', { exact: true }).fill('Browser saved value');
    await page.getByRole('button', { name: 'Save row', exact: true }).click();
    await page.getByRole('cell', { name: 'Browser saved value', exact: true }).waitFor();
    await rowAction(input.recordId, 'History');
    const history = page.getByRole('region', { name: 'Row history', exact: true });
    await history.getByRole('button', { name: 'Review values before update', exact: true }).waitFor();
    await history.getByRole('button', { name: 'Close history', exact: true }).click();
    await openPanel('Schema history');
    await page.getByText('The latest saved definition is active.', { exact: true }).waitFor();
    const schemas = page.getByRole('region', { name: 'Schema history', exact: true });
    await schemas.getByRole('button', { name: 'Check schema history', exact: true }).click();
    await schemas.getByText('Migration completed', { exact: true }).first().waitFor();
    await closePanel();
    const records = (await app.inject({ url: `${base}/rows?revision=${state.applied.revision}`, headers })).json();
    const record = records.find(row => row.id === input.recordId);
    const transformed = records.find(row =>
      Object.values(row.values).some(value => value?.kind === 'text' && value.value === 'printer'),
    );
    assert.ok(transformed, 'Worker fixture supplies a transformed row');
    await rowAction(transformed.id, 'History');
    await history.getByRole('button', { name: 'Review values before transform', exact: true }).click();
    await history.getByRole('cell', { name: 'printer', exact: true }).first().waitFor();
    await history.getByRole('button', { name: 'Close history', exact: true }).click();
    const searchRows = page.getByRole('searchbox', { name: 'Search rows', exact: true });
    await page
      .getByRole('group', { name: 'Table tools', exact: true })
      .getByRole('button', { name: /^(Search|“.*”)$/ })
      .click();
    await searchRows.fill('PRINTER');
    await page.waitForURL(/[?&]q=PRINTER/);
    await page.keyboard.press('Escape');
    await searchRows.waitFor({ state: 'detached' });
    await page.getByRole('cell', { name: 'Browser saved value', exact: true }).waitFor({ state: 'detached' });
    await page.getByRole('cell', { name: 'printer', exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Sort by Title', exact: true }).click();
    await page.waitForURL(url => /^[0-9a-f-]{36}$/.test(url.searchParams.get('order') ?? ''));
    await page.getByRole('button', { name: 'Sort by Title, ascending. Select for descending', exact: true }).click();
    await page.waitForURL(url => /^-[0-9a-f-]{36}$/.test(url.searchParams.get('order') ?? ''));
    await page.getByRole('cell', { name: 'printer', exact: true }).first().waitFor();
    await page
      .getByRole('group', { name: 'Table tools', exact: true })
      .getByRole('button', { name: '“PRINTER”', exact: true })
      .click();
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await page.waitForURL(url => !url.searchParams.has('q'));
    await page.keyboard.press('Escape');
    await searchRows.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Sort by Title, descending. Select to clear', exact: true }).click();
    await page.waitForURL(url => !url.searchParams.has('order'));
    await page.getByRole('cell', { name: 'Browser saved value', exact: true }).waitFor();
    const deleted = await app.inject({
      method: 'POST',
      url: `${base}/rows`,
      headers,
      payload: {
        requestId: randomUUID(),
        kind: 'delete',
        tableId: input.tableId,
        recordId: input.recordId,
        revision: state.applied.revision,
        expectedToken: record.token,
      },
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    const retained = (await app.inject({ url: `${base}/rows/${input.recordId}/history`, headers })).json();
    const deletedEntry = retained.find(entry => entry.operation === 'delete' && entry.token === deleted.json().token);
    assert.ok(deletedEntry);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await openPanel('Deleted rows');
    const recovery = page.getByRole('region', { name: 'Deleted rows', exact: true });
    await recovery.getByRole('button', { name: 'Refresh deleted rows', exact: true }).click();
    await recovery
      .getByRole('button', { name: `Review deleted row ${input.recordId.slice(0, 8)}`, exact: true })
      .click();
    await history
      .locator(`#record-history-${deletedEntry.id}`)
      .getByRole('button', { name: 'Review values before delete', exact: true })
      .click();
    await history.getByText(/This row is deleted/).waitFor();
    await history.getByRole('cell', { name: 'Browser saved value', exact: true }).waitFor();
    await history.getByRole('button', { name: 'Restore reviewed values', exact: true }).click();
    await recovery.getByText('Row restored.', { exact: true }).waitFor();
    await recovery.getByText('No deleted rows on this page', { exact: true }).waitFor();
    await closePanel();
    await page.getByRole('cell', { name: 'Browser saved value', exact: true }).waitFor();
    const restored = (await app.inject({ url: `${base}/rows?revision=${state.applied.revision}`, headers }))
      .json()
      .find(row => row.id === input.recordId);
    assert.notEqual(restored.token, deleted.json().token);
    assert.deepEqual(restored.values, record.values);
    assert.deepEqual(pageErrors, []);
    assert.ok(statuses.length > 5);
    assert.ok(statuses.every(status => status >= 200 && status < 300));
    process.stdout.write(
      `${JSON.stringify({ event: 'tables-real-backend-browser', result: 'passed', httpResponses: statuses.length, scope: 'full Vite app entrypoint/router/shell; real session and workspace discovery services; composed HTTP, PostgreSQL, Temporal; local S3 test implementation' })}\n`,
    );
  } finally {
    await browser?.close();
    await vite.close();
  }
}
