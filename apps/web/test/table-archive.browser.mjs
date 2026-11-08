import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { normalizeQueryRequest } from '@tulipfarm/tables/query';
import { membership, credits } from './chat-query.fixture.mjs';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';

// The table page names the workflows that block archiving, and opens an archived table read-only.
const server = await startBuiltApp();
const { origin } = server;
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-10-01T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const base = `/v1/workspaces/${workspace.id}`;
const tableId = '55555555-5555-4555-8555-555555555555';
const revision = 'a'.repeat(40);
const definition = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: '33333333-3333-4333-8333-333333333333',
  label: 'Support tickets',
  fields: [
    { id: '66666666-6666-4666-8666-666666666666', label: 'Subject', kind: 'text', required: true, maxLength: 200 },
  ],
  uniqueKeys: [],
};
const workflows = [
  { id: '77777777-7777-4777-8777-777777777777', name: 'Weekly summary' },
  { id: '88888888-8888-4888-8888-888888888888', name: 'Ticket triage' },
];
let archived = false,
  blocking = [];

async function routeApi(page) {
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (path === '/v1/auth/get-session')
      return json({
        session: { id: 'fixture-session', userId: 'ada' },
        user: { id: 'ada', name: 'Ada', email: 'ada@example.com', lastModelFamilyId: null },
      });
    if (path === '/v1/workspaces') return json([workspace]);
    if (path === '/v1/workspaces/acme') return json(workspace);
    if (path === `${base}/governance/me`) return json(membership);
    if (path === `${base}/credits`) return json(credits);
    if (path === `${base}/tables/${tableId}`)
      return json({
        id: tableId,
        saved: null,
        applied: { revision, definition, appliedAt: workspace.createdAt },
        rowPermissions: { create: true, update: true, delete: true },
        canArchive: !archived,
        archived,
      });
    if (path === `${base}/workflows/using-table/${tableId}`) return json(blocking);
    if (path.startsWith(`${base}/tables/${tableId}/archive/`)) return json({ error: 'workflow-active' }, 409);
    if (request.method() === 'POST' && path === `${base}/tables/${tableId}/query`)
      return json({
        mode: 'rows',
        ...normalizeQueryRequest(definition, request.postDataJSON().request),
        references: {},
        records: [],
        total: '0',
        nextCursor: null,
      });
    if (path === `${base}/tables/${tableId}/rows/page`) return json({ records: [], total: '0', nextCursor: null });
    if (path === `${base}/tables`) return json({ tables: [], nextCursor: null });
    return json({ error: 'unavailable' }, 404);
  });
}

let browser;
let page;
try {
  browser = await chromium.launch(builderBrowserOptions());
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await routeApi(page);

  await page.goto(`${origin}/acme/tables/${tableId}`);
  await page.getByText('No rows yet', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'More table options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive table', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: /^Archive .+\?$/ });
  const archive = () => dialog.getByRole('button', { name: 'Archive table', exact: true }).click();
  // Without a workflow the person can read, the generic reason stays.
  await archive();
  await dialog
    .getByText('An enabled workflow uses this table. Disable or archive that workflow, then try again.', {
      exact: true,
    })
    .waitFor();
  const list = dialog.getByRole('list', { name: 'Workflows that use this table', exact: true });
  for (const [count, message] of [
    [1, 'This active workflow uses this table. Disable or archive it, then try again.'],
    [2, 'These active workflows use this table. Disable or archive them, then try again.'],
  ]) {
    blocking = workflows.slice(0, count);
    await archive();
    await dialog.getByText(message, { exact: true }).waitFor();
    assert.deepEqual(
      await list.getByRole('link').allInnerTexts(),
      blocking.map(workflow => workflow.name),
    );
    for (const workflow of blocking)
      assert.equal(
        await list.getByRole('link', { name: workflow.name, exact: true }).getAttribute('href'),
        `/acme/workflows/${workflow.id}`,
      );
  }
  await dialog.getByRole('button', { name: 'Keep table', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });

  archived = true;
  await page.goto(`${origin}/acme/tables/${tableId}`);
  await page.getByText('This table is archived', { exact: true }).waitFor();
  await page
    .getByText("Its rows are kept but can't be changed. To restore it, ask in chat.", { exact: true })
    .waitFor();
  await page.getByText('Support tickets has no rows.', { exact: true }).waitFor();
  assert.equal(await page.getByText('No rows yet', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Change fields in chat', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /^Add row/ }).count(), 0);
  await page.getByRole('button', { name: 'More table options', exact: true }).click();
  await page.getByRole('menu').waitFor();
  assert.equal(await page.getByRole('menuitem', { name: 'Archive table', exact: true }).count(), 0);
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Archive blocked by named workflows; archived table opens read-only.');
} catch (error) {
  await captureBrowserFailure(page, 'table-archive');
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
