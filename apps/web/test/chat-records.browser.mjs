import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { normalizeQueryRequest, queryCapabilities } from '@tulipfarm/tables/query';
import { toolReceiptSchema } from '../../../packages/conversations/dist/contracts.js';
import { rowViewForReceipt } from '../../../packages/conversations/dist/row-view.js';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const tableId = '22222222-2222-4222-8222-222222222222';
const subject = '33333333-3333-4333-8333-333333333333';
const priority = '44444444-4444-4444-8444-444444444444';
const medium = '55555555-5555-4555-8555-555555555555';
const description = '88888888-8888-4888-8888-888888888888';
const status = '99999999-9999-4999-8999-999999999999';
const assignee = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requester = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const due = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const pending = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const revision = 'a'.repeat(40);
const { workspace, session } = createWorkspaceFixture({ slug: 'records-qa', name: 'Records QA' });
const definition = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: id,
  label: 'Tickets',
  fields: [
    { id: subject, label: 'Title', kind: 'text', required: true, maxLength: 200 },
    { id: description, label: 'Description', kind: 'text', required: false, maxLength: 1000 },
    {
      id: status,
      label: 'Status',
      kind: 'single-select',
      required: false,
      options: [{ id: pending, label: 'Open', retired: false }],
    },
    {
      id: priority,
      label: 'Priority',
      kind: 'single-select',
      required: false,
      options: [{ id: medium, label: 'Medium', retired: false }],
    },
    { id: assignee, label: 'Assignee', kind: 'text', required: false, maxLength: 200 },
    { id: requester, label: 'Requester email', kind: 'text', required: false, maxLength: 200 },
    { id: due, label: 'Due date', kind: 'date', required: false },
  ],
  uniqueKeys: [],
};
const records = Array.from({ length: 9 }, (_, index) => ({
  id: `66666666-6666-4666-8666-${String(index + 1).padStart(12, '0')}`,
  token: `77777777-7777-4777-8777-${String(index + 1).padStart(12, '0')}`,
  values: {
    [subject]: { kind: 'text', value: `Sample ticket ${index + 1}` },
    [description]: { kind: 'text', value: `Synthetic request ${index + 1}` },
    [status]: { kind: 'single-select', optionId: pending },
    [priority]: { kind: 'single-select', optionId: medium },
    [assignee]: { kind: 'text', value: 'Sample agent' },
    [requester]: { kind: 'text', value: 'requester@example.test' },
    [due]: { kind: 'date', value: '2026-10-20' },
  },
}));
const options = { version: 2, mode: 'rows', where: null, sort: [], limit: 9 };
const result = { version: 2, mode: 'rows', query: options, rsql: '', records, total: '9', nextCursor: null };
const stored = {
  id,
  tool: 'rows.list',
  status: 'completed',
  call: { tool: 'rows.list', tableId, expectedAppliedRevision: revision, query: options },
  output: { result, sources: [{ kind: 'table-rows', tableId, revision }] },
};
const receipt = toolReceiptSchema.parse({ ...stored, rowView: rowViewForReceipt(stored) });

test(
  'saved and live row receipts open shared Records while legacy Markdown stays intact and bounded',
  { timeout: 120000 },
  async () => {
    const port = Number(process.env.CHAT_RECORDS_PORT ?? 5751);
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
      const cdp = process.env.CHAT_RECORDS_CDP_PORT;
      browser = await chromium.launch({
        headless: process.env.CHAT_BROWSER_HEADED !== '1',
        args: cdp ? [`--remote-debugging-port=${cdp}`] : [],
      });
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [],
        reads = [];
      let queryStatus = 200,
        detailStatus = 200,
        rowDelay = 600,
        pageSize = 9,
        changed = false,
        empty = false,
        appliedRevision = revision;
      const firstRows = Promise.withResolvers();
      let holdRows = true;
      let permissions = { create: false, update: false, delete: false };
      let currentReceipt = receipt;
      const chat = {
        id,
        title: 'Show all tickets',
        titleRevision: 1,
        archived: false,
        activityAt: workspace.createdAt,
        createdAt: workspace.createdAt,
      };
      const markdown = `I found nine tickets.\n\n| Ticket | Priority | Assignee | Description |\n| --- | --- | --- | --- |\n${records.map((_, index) => `| Sample ticket ${index + 1} | Medium | Sample agent | Synthetic request ${index + 1} |`).join('\n')}\n\nA separate comparison:\n\n| Measure | Value |\n| --- | --- |\n| Total | 9 |\n\nAnalysis with matching field labels:\n\n| Title | Priority |\n| --- | --- |\n| Analysis only | Escalate |`;
      page.on('pageerror', error => errors.push(String(error)));
      await context.route('**/v1/**', async route => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
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
                parts: [{ kind: 'text', text: 'Show all tickets' }],
                turn: { id, status: 'completed', generation: 0 },
                tools: [currentReceipt],
              },
              {
                id: tableId,
                sequence: 2,
                author: 'assistant',
                createdAt: workspace.createdAt,
                parts: [{ kind: 'text', text: markdown }],
                turn: null,
                tools: [],
              },
            ],
            nextBefore: null,
            hasGitHubProposals: false,
          };
        else if (/\/conversations\/[\w-]+$/.test(path)) json = chat;
        else if (path.endsWith(`/tables/${tableId}`)) {
          if (detailStatus !== 200) return route.fulfill({ status: detailStatus, json: { error: 'access-denied' } });
          json = {
            id: tableId,
            saved: null,
            applied: { revision: appliedRevision, definition, appliedAt: workspace.createdAt },
            rowPermissions: permissions,
          };
        } else if (path.endsWith(`/tables/${tableId}/query-capabilities`)) json = queryCapabilities(definition);
        else if (path.endsWith(`/tables/${tableId}/query/validate`))
          json = { ...normalizeQueryRequest(definition, request.postDataJSON().request), references: {} };
        else if (path.endsWith(`/tables/${tableId}/query`)) {
          const body = request.postDataJSON();
          assert.equal(body.revision, revision);
          const { query, rsql } = normalizeQueryRequest(definition, body.request);
          reads.push({ ...query, rsql });
          if (holdRows) await firstRows.promise;
          await delay(rowDelay);
          if (queryStatus !== 200) return route.fulfill({ status: queryStatus, json: { error: 'query-unavailable' } });
          let rows = empty
            ? []
            : records.filter(record => !query.search || record.values[subject].value.includes(query.search));
          if (query.where) rows = rows.filter(record => record.values[subject].value === query.where.values[0]);
          if (query.sort[0]?.direction === 'desc') rows.reverse();
          const offset = Number(query.after ?? 0),
            limit = Math.min(pageSize, query.limit);
          rows = rows.map(record =>
            changed && record.id === records[0].id
              ? {
                  ...record,
                  token: medium,
                  values: { ...record.values, [subject]: { kind: 'text', value: 'Updated in the database' } },
                }
              : record,
          );
          json = {
            mode: 'rows',
            query,
            rsql,
            references: {},
            records: rows.slice(offset, offset + limit),
            total: query.after ? null : String(rows.length),
            nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
          };
        } else return route.fulfill({ status: 404, json: { error: 'not-found' } });
        return route.fulfill({ json });
      });
      const load = async () => {
        await page.goto(`${origin}/${workspace.slug}/chat/${id}`);
        assert.equal(await page.getByRole('region', { name: 'Canvas', exact: true }).count(), 0);
        await open();
      };
      const canvas = () => page.getByRole('region', { name: 'Canvas', exact: true });
      const close = () => canvas().getByRole('button', { name: 'Close canvas', exact: true }).click();
      const open = async () => {
        await page
          .getByRole('region', { name: 'Conversation', exact: true })
          .getByRole('button', { name: /Open Tickets|Open Table rows/, exact: true })
          .click();
      };
      const broadcast = async keys =>
        page.evaluate(
          ({ keys, workspaceId, membershipId, sessionId }) => {
            const channel = new BroadcastChannel('tulipfarm:query:v1');
            channel.postMessage({
              version: 1,
              id: crypto.randomUUID(),
              sessionId,
              scope: { kind: 'workspace', userId: 'ada', workspaceId, membershipId },
              kind: 'change',
              keys,
            });
            channel.close();
          },
          { keys, workspaceId: workspace.id, membershipId: id, sessionId: session.session.id },
        );
      await load();
      await canvas().locator('table[aria-busy="true"]').waitFor();
      assert.equal(await canvas().getByRole('heading', { name: 'No rows yet' }).count(), 0);
      holdRows = false;
      firstRows.resolve();
      await canvas().getByText('Sample ticket 9', { exact: true }).filter({ visible: true }).waitFor();
      rowDelay = 0;
      assert.equal(await canvas().locator('tbody tr').count(), 9);
      assert.equal(await canvas().getByText('Medium', { exact: true }).count(), 9);
      const transcript = page.getByRole('region', { name: 'Conversation', exact: true });
      assert.equal(await transcript.locator('table').count(), 3, 'no table is guessed to be a tool result or removed');
      assert.deepEqual(await canvas().locator('thead th').allTextContents(), [
        '',
        'Title',
        'Description',
        'Status',
        'Priority',
        'Assignee',
        'Requester email',
        'Due date',
        'Actions',
      ]);
      assert.equal(
        await canvas().getByRole('checkbox', { name: 'Select all rows on this page', exact: true }).count(),
        1,
      );
      assert.deepEqual(await transcript.locator('table').first().locator('th').allTextContents(), [
        'Ticket',
        'Priority',
        'Assignee',
        'Description',
      ]);
      assert.equal(
        await transcript.locator('table').first().locator('tbody tr').count(),
        9,
        'legacy rows remain intact',
      );
      const bounds = await transcript
        .getByRole('region', { name: 'Response table', exact: true })
        .first()
        .evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight }));
      assert.ok(
        bounds.height <= 192 && bounds.content > bounds.height,
        'the original nine-row Markdown listing cannot expand the chat',
      );
      assert.equal(
        await transcript.getByText('Escalate', { exact: true }).count(),
        1,
        'unrelated analysis with matching field names remains intact',
      );
      assert.equal(
        await canvas().getByRole('button', { name: 'Add row', exact: true }).count(),
        0,
        'read-only permissions apply',
      );
      assert.equal(reads[0].limit, 9);
      assert.equal('records' in receipt.rowView, false);
      const screenshots = process.env.CHAT_RECORDS_SCREENSHOTS;
      const capture = async name => {
        if (!screenshots) return;
        await mkdir(screenshots, { recursive: true });
        assert.ok(cdp, 'agent-browser capture requires CDP');
        await promisify(execFile)('agent-browser', ['--cdp', cdp, 'screenshot', `${screenshots}/${name}.png`]);
      };
      await capture('desktop');
      await close();
      await broadcast([['conversations']]);
      await delay(300);
      assert.equal(await canvas().count(), 0, 'history refresh must not reopen a manually closed canvas');
      currentReceipt = { ...receipt, id: subject, rowView: { ...receipt.rowView, callId: subject } };
      await broadcast([['conversations']]);
      await delay(300);
      assert.equal(await canvas().count(), 0, 'new results also wait for an explicit open');
      await open();
      await canvas().getByText('Sample ticket 9', { exact: true }).filter({ visible: true }).waitFor();
      await canvas().getByRole('tab').nth(1).waitFor();
      assert.equal(await canvas().getByRole('tab').count(), 2, 'each explicitly opened call keeps its own tab');
      await canvas().getByRole('button', { name: 'Close Tickets', exact: true }).first().click();
      await close();
      await broadcast([['conversations']]);
      await delay(300);
      assert.equal(await canvas().count(), 0);
      await open();
      changed = true;
      await broadcast([['tables', 'detail', tableId, 'records']]);
      await canvas().getByText('Updated in the database', { exact: true }).waitFor();
      assert.equal(await canvas().getByText('Sample ticket 1', { exact: true }).count(), 0);
      queryStatus = 503;
      await broadcast([['tables', 'detail', tableId, 'records']]);
      await canvas()
        .getByRole('button', { name: /Retry refresh|Try again/ })
        .waitFor();
      await canvas().getByText('Updated in the database', { exact: true }).waitFor();
      queryStatus = 200;
      await canvas()
        .getByRole('button', { name: /Retry refresh|Try again/ })
        .click();
      await close();
      await page.setViewportSize({ width: 375, height: 812 });
      await open();
      const sheet = page.getByRole('dialog', { name: 'Canvas', exact: true });
      await sheet.getByText('Updated in the database', { exact: true }).waitFor();
      await capture('mobile');
      await sheet.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 1000 });

      changed = false;
      pageSize = 3;
      await load();
      await canvas().getByText('Sample ticket 3', { exact: true }).waitFor();
      await canvas().getByRole('button', { name: 'Next rows', exact: true }).click();
      await canvas().getByText('Sample ticket 6', { exact: true }).waitFor();
      assert.equal(reads.at(-1).after, '3');
      await canvas().getByRole('button', { name: 'Previous rows', exact: true }).click();
      await canvas().getByText('Sample ticket 1', { exact: true }).waitFor();

      currentReceipt = {
        ...receipt,
        rowView: {
          ...receipt.rowView,
          query: { rsql: '', options: { ...receipt.rowView.query.options, after: '3', select: [subject] } },
        },
      };
      await load();
      await canvas().getByText('Sample ticket 4', { exact: true }).waitFor();
      assert.equal(reads.at(-1).after, '3', 'the original requested page is retained');
      assert.equal(
        await canvas().getByText('3 rows on this page', { exact: true }).count(),
        1,
        'An arbitrary cursor never invents an absolute row range',
      );
      assert.equal(await canvas().getByText('Medium', { exact: true }).count(), 0, 'selected columns are retained');
      await canvas().getByRole('button', { name: 'Previous rows', exact: true }).click();
      await canvas().getByText('Sample ticket 1', { exact: true }).waitFor();

      currentReceipt = {
        ...receipt,
        rowView: {
          ...receipt.rowView,
          query: {
            rsql: 'title=="Sample ticket 2"',
            options: { version: 2, mode: 'rows', sort: [{ fieldId: subject, direction: 'desc' }], limit: 9 },
          },
        },
      };
      await load();
      await canvas().getByText('Sample ticket 2', { exact: true }).waitFor();
      assert.equal(await canvas().locator('tbody tr').count(), 1);
      assert.equal(reads.at(-1).where.values[0], 'Sample ticket 2');
      assert.equal(reads.at(-1).sort[0].direction, 'desc');
      currentReceipt = {
        ...receipt,
        rowView: {
          ...receipt.rowView,
          query: { rsql: '', options: { ...receipt.rowView.query.options, search: 'missing' } },
        },
      };
      await load();
      await canvas().getByRole('heading', { name: 'No rows match', exact: true }).waitFor();
      await canvas().getByRole('button', { name: 'Clear filters', exact: true }).click();
      await canvas().getByText('Sample ticket 1', { exact: true }).waitFor();

      currentReceipt = receipt;
      empty = true;
      await load();
      await canvas().getByRole('heading', { name: 'No rows yet', exact: true }).waitFor();
      empty = false;
      queryStatus = 503;
      rowDelay = 300;
      await load();
      await canvas()
        .getByRole('button', { name: /Try again|Retry refresh/ })
        .waitFor();
      await Promise.all([
        page.waitForResponse(
          response => response.url().endsWith(`/tables/${tableId}/query`) && response.status() === 503,
        ),
        canvas()
          .getByRole('button', { name: /Try again|Retry refresh/ })
          .waitFor({ state: 'hidden' }),
        canvas()
          .getByRole('button', { name: /Try again|Retry refresh/ })
          .click(),
      ]);
      await canvas()
        .getByRole('button', { name: /Try again|Retry refresh/ })
        .waitFor();
      queryStatus = 200;
      rowDelay = 600;
      await canvas()
        .getByRole('button', { name: /Try again|Retry refresh/ })
        .click();
      await canvas().getByText('Sample ticket 1', { exact: true }).waitFor();
      rowDelay = 0;
      appliedRevision = 'b'.repeat(40);
      await load();
      await canvas().getByRole('heading', { name: 'These fields have changed' }).waitFor();
      appliedRevision = revision;
      detailStatus = 403;
      await load();
      await canvas().getByRole('heading', { name: 'Table unavailable', exact: true }).waitFor();
      assert.equal(await canvas().locator('tbody tr').count(), 0);
      detailStatus = 200;
      permissions = { create: true, update: true, delete: true };
      await canvas().getByRole('button', { name: 'Check access again', exact: true }).click();
      await canvas().getByRole('button', { name: 'Add row', exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      server.kill('SIGTERM');
    }
  },
);
