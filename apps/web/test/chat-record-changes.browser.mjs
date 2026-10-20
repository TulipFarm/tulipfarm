import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { toolReceiptSchema } from '../../../packages/conversations/dist/contracts.js';
import { rowChangeForReceipt } from '../../../packages/conversations/dist/row-view.js';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const tableId = '22222222-2222-4222-8222-222222222222';
const name = '33333333-3333-4333-8333-333333333333';
const email = '44444444-4444-4444-8444-444444444444';
const updateCall = '55555555-5555-4555-8555-555555555555';
const revision = 'a'.repeat(40);
const { workspace, session } = createWorkspaceFixture({ slug: 'changes-qa', name: 'Changes QA' });
const definition = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: id,
  label: 'Customers',
  fields: [
    { id: name, label: 'Name', kind: 'text', required: true, maxLength: 200 },
    { id: email, label: 'Email', kind: 'text', required: false, maxLength: 200 },
  ],
  uniqueKeys: [],
};
const customer = (index, label) => ({
  id: `66666666-6666-4666-8666-${String(index).padStart(12, '0')}`,
  token: `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`,
  values: {
    [name]: { kind: 'text', value: label },
    [email]: { kind: 'text', value: `${label.toLowerCase().split(' ')[0]}@example.test` },
  },
  unavailableFileIds: [],
});
const added = [customer(1, 'Ada Lovelace'), customer(2, 'Grace Hopper'), customer(3, 'Alan Turing')];
const existing = customer(4, 'Edsger Dijkstra');
const write = { tableId, expectedAppliedRevision: revision, values: {} };
const sources = [{ kind: 'table-rows', tableId, revision }];
const receipt = row => toolReceiptSchema.parse({ ...row, rowChange: rowChangeForReceipt(row) });
const batch = receipt({
  id,
  tool: 'rows.create.batch',
  status: 'completed',
  call: { tool: 'rows.create.batch', tableId, expectedAppliedRevision: revision, rows: [] },
  output: { result: { records: added, total: '3', nextCursor: null }, sources },
});
const update = receipt({
  id: updateCall,
  tool: 'rows.update',
  status: 'completed',
  call: { tool: 'rows.update', ...write, recordId: existing.id, expectedToken: existing.token },
  output: { result: existing, sources },
});

test('rows written in chat open in the Canvas with added and updated markers', { timeout: 120000 }, async () => {
  const port = Number(process.env.CHAT_RECORD_CHANGES_PORT ?? 5752);
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  let browser;
  try {
    for (
      let attempt = 0;
      !(await fetch(origin).then(
        response => response.ok,
        () => false,
      ));
      attempt++
    ) {
      assert.ok(attempt < 150 && server.exitCode === null, 'Vite starts');
      await delay(100);
    }
    browser = await chromium.launch({ headless: process.env.CHAT_BROWSER_HEADED !== '1' });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [],
      reads = [];
    let rowsStatus = 200,
      rowDelay = 0,
      appliedRevision = revision,
      live = [...added, existing];
    const chat = {
      id,
      title: 'Add customers',
      titleRevision: 1,
      archived: false,
      activityAt: workspace.createdAt,
      createdAt: workspace.createdAt,
    };
    page.on('pageerror', error => errors.push(String(error)));
    await context.route('**/v1/**', async route => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      let json;
      if (path === '/v1/user/visit') json = { firstSession: false };
      else if (path === '/v1/auth/get-session') json = session;
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: id,
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        };
      else if (path.endsWith('/model-catalog')) json = chatCatalog;
      else if (path.endsWith('/messages'))
        json = {
          messages: [
            {
              id,
              sequence: 1,
              author: 'human',
              createdAt: workspace.createdAt,
              parts: [{ kind: 'text', text: 'Add these customers and fix Edsger’s email' }],
              turn: { id, status: 'completed', generation: 0 },
              tools: [batch, update],
            },
            {
              id: tableId,
              sequence: 2,
              author: 'assistant',
              createdAt: workspace.createdAt,
              parts: [{ kind: 'text', text: 'Added three customers and updated one.' }],
              turn: null,
              tools: [],
            },
          ],
          nextBefore: null,
          hasGitHubProposals: false,
        };
      else if (/\/conversations\/[\w-]+$/.test(path)) json = chat;
      else if (path.endsWith(`/tables/${tableId}`))
        json = {
          id: tableId,
          saved: null,
          applied: { revision: appliedRevision, definition, appliedAt: workspace.createdAt },
          rowPermissions: { create: true, update: true, delete: true },
        };
      else if (path.endsWith(`/tables/${tableId}/rows`) && request.method() === 'GET') {
        assert.equal(url.searchParams.get('revision'), revision);
        const ids = url.searchParams.get('ids').split(',');
        reads.push(ids);
        await delay(rowDelay);
        if (rowsStatus !== 200) return route.fulfill({ status: rowsStatus, json: { error: 'unavailable' } });
        json = live.filter(record => ids.includes(record.id));
      } else return route.fulfill({ status: 404, json: { error: 'not-found' } });
      return route.fulfill({ json });
    });
    const load = async () => {
      await page.goto(`${origin}/${workspace.slug}/chat/${id}`);
      assert.equal(await page.getByRole('region', { name: 'Canvas', exact: true }).count(), 0);
      await page
        .getByRole('button', { name: 'View changed rows', exact: true })
        .click()
        .catch(async error => {
          console.error('Rows failure:', errors, await page.locator('body').innerText());
          await page.screenshot({ path: '/tmp/chat-row-changes-failure.png' });
          throw error;
        });
    };
    const canvas = () => page.getByRole('region', { name: 'Canvas', exact: true });
    const screenshots = process.env.CHAT_RECORD_CHANGES_SCREENSHOTS;
    const capture = async label => {
      if (screenshots) {
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: `${screenshots}/${label}.png` });
      }
    };

    rowDelay = 500;
    await load();
    await canvas().getByRole('status', { name: 'Loading tables' }).waitFor();
    await canvas().getByText('Ada Lovelace', { exact: true }).waitFor();
    rowDelay = 0;
    assert.deepEqual(
      reads[0],
      [...added, existing].map(record => record.id),
      'one read requests exactly the written rows',
    );
    assert.equal(await canvas().getByRole('heading', { name: 'Customers', exact: true }).count(), 1);
    assert.equal(await canvas().locator('tbody tr').count(), 4);
    assert.deepEqual(await canvas().locator('tbody tr td:first-child').allTextContents(), [
      'Added',
      'Added',
      'Added',
      'Updated',
    ]);
    const changes = canvas().getByRole('list', { name: 'Changes', exact: true });
    assert.deepEqual(await changes.locator('li').allTextContents(), ['3 added', '1 updated']);
    assert.equal(await canvas().getByText(added[0].id).isVisible(), false, 'IDs stay inside the collapsed Details');
    const transcript = page.getByRole('region', { name: 'Conversation', exact: true });
    await transcript.getByText('3 rows added · 1 row updated in Customers.', { exact: true }).waitFor();
    assert.equal(await transcript.getByRole('region', { name: 'Changed rows', exact: true }).count(), 1);
    assert.equal(await canvas().getByRole('tab').count(), 1, 'one tab per table per reply');
    assert.equal(
      await canvas().locator('a[aria-label="Open row"]').first().getAttribute('href'),
      `/${workspace.slug}/tables/${tableId}?row=${added[0].id}`,
    );
    await capture('desktop');

    await canvas().getByRole('button', { name: 'Close canvas', exact: true }).click();
    await page.getByRole('button', { name: /Show canvas/ }).click();
    await canvas().getByText('Grace Hopper', { exact: true }).waitFor();

    live = [added[0], existing];
    await canvas().getByRole('button', { name: 'Refresh rows', exact: true }).click();
    await canvas().getByText('2 rows were deleted or are no longer visible.', { exact: true }).waitFor();
    assert.equal(await canvas().locator('tbody tr').count(), 2);

    live = [];
    await load();
    await canvas().getByRole('heading', { name: 'Rows unavailable', exact: true }).waitFor();

    live = [...added, existing];
    rowsStatus = 503;
    await load();
    await canvas()
      .getByRole('button', { name: /Try again/ })
      .waitFor();
    rowsStatus = 200;
    await canvas()
      .getByRole('button', { name: /Try again/ })
      .click();
    await canvas().getByText('Alan Turing', { exact: true }).waitFor();

    appliedRevision = 'b'.repeat(40);
    await load();
    await canvas().getByRole('heading', { name: 'These fields have changed' }).waitFor();
    appliedRevision = revision;
    await load();
    await canvas().getByText('Ada Lovelace', { exact: true }).waitFor();
    await canvas().getByRole('button', { name: 'Close canvas', exact: true }).click();

    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: /Show canvas/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Canvas', exact: true });
    await sheet.getByText('Ada Lovelace', { exact: true }).waitFor();
    await capture('mobile');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
});
