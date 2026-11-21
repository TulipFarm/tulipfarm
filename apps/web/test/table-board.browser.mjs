import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test('table boards disable title rename without losing row actions or saved moves', { timeout: 90_000 }, async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    cacheDir: 'node_modules/.vite-table-board-browser',
    server: { port: 0 },
    plugins: [
      {
        name: 'table-board-test',
        configureServer(server) {
          server.middlewares.use('/table-board-test', async (_request, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end(
              await server.transformIndexHtml(
                '/table-board-test',
                '<html><head><link rel="stylesheet" href="/src/index.css"></head><body></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  await server.listen();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${server.resolvedUrls.local[0]}table-board-test`);
    await page.evaluate(async () => {
      const { React, createRoot, SessionQueryProvider, WorkspaceQueryProvider, BoardView, DropdownMenuItem } =
        await import('/test/table-query-fixture.tsx');
      const id = '11111111-1111-4111-8111-111111111111';
      const nameId = '22222222-2222-4222-8222-222222222222';
      const statusId = '33333333-3333-4333-8333-333333333333';
      const openId = '44444444-4444-4444-8444-444444444444';
      const doneId = '55555555-5555-4555-8555-555555555555';
      const record = {
        id,
        token: id,
        values: {
          [nameId]: { kind: 'text', value: 'Original subject' },
          [statusId]: { kind: 'single-select', optionId: openId },
        },
      };
      const table = {
        id,
        revision: 'a'.repeat(40),
        definition: {
          formatVersion: 2,
          id,
          owningTeamId: id,
          label: 'Tickets',
          fields: [
            { id: nameId, label: 'Subject', kind: 'text', required: true, maxLength: 100 },
            {
              id: statusId,
              label: 'Status',
              kind: 'single-select',
              required: false,
              options: [
                { id: openId, label: 'Open', retired: false },
                { id: doneId, label: 'Done', retired: false },
              ],
            },
          ],
          uniqueKeys: [],
        },
      };
      window.boardTest = { writes: [], opened: [], statusId, doneId };
      const open = row => window.boardTest.opened.push(row.id);
      const api = {
        async query(_table, request) {
          if (request.options.mode === 'summary')
            return { mode: 'summary', groups: [{ keys: [record.values[statusId].optionId], values: [1] }] };
          const label = record.values[statusId].optionId === openId ? 'Open' : 'Done';
          return { mode: 'rows', records: request.rsql.endsWith(`==${label}`) ? [record] : [] };
        },
        async mutate(input) {
          window.boardTest.writes.push(input);
          record.values = { ...record.values, ...input.values };
          return { kind: 'available', ...record };
        },
      };
      createRoot(document.body.appendChild(document.createElement('div'))).render(
        React.createElement(
          SessionQueryProvider,
          { identity: { userId: 'alice', sessionId: 'session' } },
          React.createElement(
            WorkspaceQueryProvider,
            {
              scope: { kind: 'workspace', userId: 'alice', workspaceId: id, membershipId: id },
              admitted: () => true,
              subscribe: () => () => {},
            },
            React.createElement(BoardView, {
              api,
              table,
              view: { where: '', sort: [], groupBy: [], metrics: [] },
              columns: table.definition.fields,
              fieldId: statusId,
              changeField: () => {},
              openColumn: () => {},
              workspace: { id, slug: 'tickets', sessionId: 'session' },
              canMove: true,
              open,
              menu: row =>
                React.createElement(
                  DropdownMenuItem,
                  {
                    onClick: event => {
                      event.stopPropagation();
                      open(row);
                    },
                  },
                  'Edit row',
                ),
            }),
          ),
        ),
      );
    });
    const board = page.locator('[data-slot="board"]');
    const card = board.locator('[aria-roledescription="draggable card"]').filter({ hasText: 'Original subject' });
    await card.waitFor();
    const cardTitle = await card.getAttribute('aria-label');
    assert.equal(await card.getAttribute('aria-roledescription'), 'draggable card');
    await card.press('F2');
    assert.equal(await board.getByRole('textbox', { name: 'Card title', exact: true }).count(), 0);
    await card.getByRole('button', { name: `Actions for ${cardTitle}`, exact: true }).click();
    assert.equal(await page.getByRole('menuitem', { name: 'Rename', exact: true }).count(), 0);
    await page.getByRole('menuitem', { name: 'Edit row', exact: true }).click();
    await card.press('Enter');
    assert.equal(await page.evaluate(() => window.boardTest.opened.length), 2);
    await card.press('Space');
    await page.getByText(`Card ${cardTitle} is in Open.`, { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await card.getAttribute('data-dragging'), 'true');
    await page.keyboard.press('Escape');
    await page.getByText('Move cancelled. The card went back.', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await page.evaluate(() => window.boardTest.writes.length), 0);
    const source = await card.boundingBox();
    const destination = await board
      .getByRole('list', { name: 'Done, 0 cards', exact: true })
      .locator('../..')
      .boundingBox();
    assert.ok(source && destination);
    await page.mouse.move(source.x + 10, source.y + 10);
    await page.mouse.down();
    await page.mouse.move(source.x + 20, source.y + 20, { steps: 3 });
    await page.getByText(`Card ${cardTitle} is in Open.`, { exact: true }).waitFor({ state: 'attached' });
    await page.mouse.move(destination.x + 30, destination.y + 30, { steps: 10 });
    await page.getByText(`Card ${cardTitle} is in Done.`, { exact: true }).waitFor({ state: 'attached' });
    await page.mouse.up();
    await page.waitForFunction(() => window.boardTest.writes.length === 1);
    assert.deepEqual(
      await page.evaluate(() => window.boardTest.writes[0].values),
      await page.evaluate(() => ({
        [window.boardTest.statusId]: { kind: 'single-select', optionId: window.boardTest.doneId },
      })),
      'Moving a card saves only the grouping choice, never its displayed title',
    );
    await board.getByRole('list', { name: 'Done, 1 cards', exact: true }).getByText('Original subject').waitFor();
  } finally {
    await browser?.close();
    await server.close();
  }
});
