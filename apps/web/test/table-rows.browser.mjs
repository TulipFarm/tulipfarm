import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { z } from 'zod';
import { mutationSchema } from '@tulipfarm/tables/service';
import { normalizeQueryRequest, printRsql, TableQueryError } from '@tulipfarm/tables/query';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = Number(process.env.TABLE_ROWS_PORT ?? 5399);
const origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
const workspace = {
  id: randomUUID(),
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-10-02T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const memberId = randomUUID(),
  teamId = randomUUID(),
  tableId = randomUUID(),
  subjectId = randomUUID(),
  notesId = randomUUID(),
  priorityId = randomUUID(),
  reverseFieldId = randomUUID();
let revision = 'a'.repeat(40);
const definition = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: teamId,
  label: 'Support tickets',
  fields: [
    { id: subjectId, label: 'Subject', kind: 'text', required: true, maxLength: 200 },
    { id: notesId, label: 'Notes', kind: 'text', required: false, maxLength: 200 },
    { id: priorityId, label: 'Priority', kind: 'numeric', required: false, precision: 5, scale: 0 },
  ],
  uniqueKeys: [],
};
const records = new Map(),
  tombstones = new Map(),
  receipts = new Map(),
  writes = [];
let permissions = { create: true, update: true, delete: true };
let rowsDelay = 0,
  rowsStatus = 200,
  writeDelay = 0,
  dropWrite = false,
  dropBeforeWrite = false,
  linkedIds = new Set(),
  deniedIds = new Set(),
  rowReads = 0,
  pageSize = 50,
  staleCursors = false;
let rowsGate = null,
  releaseRows;
const pageReads = [],
  issuedCursors = [];
const valueOf = (row, fieldId) => row.values[fieldId]?.value;
const compare = (fieldId, a, b) => (fieldId === priorityId ? Number(a) - Number(b) : a.localeCompare(b));
const matches = (row, node) => {
  if (node.kind !== 'rule')
    return node.kind === 'all'
      ? node.nodes.every(item => matches(row, item))
      : node.nodes.some(item => matches(row, item));
  const current = valueOf(row, node.fieldId);
  if (node.op === 'empty') return current === undefined;
  if (node.op === 'not-empty') return current !== undefined;
  if (current === undefined) return false;
  if (node.op === 'contains') return current.toLowerCase().includes(node.values[0].toLowerCase());
  if (node.op === 'in' || node.op === 'out')
    return node.values.some(value => compare(node.fieldId, current, value) === 0) === (node.op === 'in');
  const order = compare(node.fieldId, current, node.values[0]);
  return { eq: order === 0, ne: order !== 0, lt: order < 0, lte: order <= 0, gt: order > 0, gte: order >= 0 }[node.op];
};
// Mirrors the server: typed RSQL is normalized against the definition, rows sort with NULLS LAST then by ID, and a cursor belongs to one query.
function rowPage(body) {
  let normalized;
  try {
    normalized = normalizeQueryRequest(definition, body.request);
  } catch (error) {
    if (error instanceof TableQueryError)
      return { status: 400, json: { error: 'invalid-query', issues: error.issues } };
    throw error;
  }
  const { query, rsql } = normalized;
  assert.equal(query.mode, 'rows');
  assert.ok([10, 25, 50, 100].includes(query.limit));
  pageReads.push({
    search: query.search,
    sort: query.sort,
    where: query.where,
    rsql,
    after: query.after,
    limit: query.limit,
  });
  const search = query.search?.toLowerCase(),
    key = JSON.stringify([search, query.sort, query.where, query.limit]);
  const list = [...records.values()]
    .filter(
      row =>
        (!search || [subjectId, notesId].some(id => valueOf(row, id)?.toLowerCase().includes(search))) &&
        (!query.where || matches(row, query.where)),
    )
    .sort((a, b) => {
      for (const { fieldId, direction } of query.sort) {
        const x = valueOf(a, fieldId),
          y = valueOf(b, fieldId);
        if (x === undefined || y === undefined) {
          if (x !== y) return x === undefined ? 1 : -1;
          continue;
        }
        const order = compare(fieldId, x, y) * (direction === 'desc' ? -1 : 1);
        if (order) return order;
      }
      return a.id.localeCompare(b.id);
    });
  let start = 0;
  if (query.after) {
    const cursor = JSON.parse(Buffer.from(query.after, 'base64url').toString());
    if (staleCursors || cursor.key !== key) return { status: 400, json: { error: 'invalid-table-values' } };
    start = cursor.offset;
  }
  const size = Math.min(query.limit, pageSize);
  const nextCursor =
    start + size < list.length
      ? Buffer.from(JSON.stringify({ key, offset: start + size })).toString('base64url')
      : null;
  if (nextCursor) issuedCursors.push(nextCursor);
  return {
    json: {
      mode: 'rows',
      query,
      rsql,
      references: {},
      records: list.slice(start, start + size),
      total: query.after ? null : String(list.length),
      nextCursor,
    },
  };
}
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    if (
      await fetch(origin).then(
        response => response.ok,
        () => false,
      )
    )
      break;
    assert.ok(attempt < 100, 'Vite starts');
    await delay(100);
  }
  browser = await chromium.launch({
    headless: true,
    args: process.env.TABLE_ROWS_CDP_PORT ? [`--remote-debugging-port=${process.env.TABLE_ROWS_CDP_PORT}`] : [],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const capture = async name => {
    if (!process.env.TABLE_ROWS_SCREENSHOTS) return;
    const path = `${process.env.TABLE_ROWS_SCREENSHOTS}/${name}.png`;
    if (process.env.TABLE_ROWS_CDP_PORT)
      execFileSync(
        'agent-browser',
        ['--session', 'table-row-regression', '--cdp', process.env.TABLE_ROWS_CDP_PORT, 'screenshot', path],
        { stdio: 'pipe', timeout: 15000 },
      );
    else await page.screenshot({ path });
  };
  const changeRows = (definition = false) =>
    page.evaluate(
      ({ workspaceId, membershipId, tableId, definition }) => {
        const channel = new BroadcastChannel('tulipfarm:query:v1');
        channel.postMessage({
          version: 1,
          id: crypto.randomUUID(),
          sessionId: 'session-ada',
          scope: { kind: 'workspace', userId: 'ada', workspaceId, membershipId },
          kind: 'change',
          keys: [['tables', 'detail', tableId, definition ? 'definition' : 'records']],
        });
        channel.close();
      },
      { workspaceId: workspace.id, membershipId: memberId, tableId, definition },
    );
  const renameTable = async label => {
    revision = randomUUID().replaceAll('-', '').padEnd(40, 'a');
    definition.label = label;
    await changeRows(true);
    await page.getByRole('heading', { name: label, exact: true, includeHidden: true }).waitFor({ state: 'attached' });
  };
  await page.route('**/v1/**', async route => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const teams = [{ id: teamId, name: 'Support', description: '', membershipIds: [memberId] }];
    let json;
    if (path === '/v1/auth/get-session')
      json = {
        session: { id: 'session-ada', userId: 'ada' },
        user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
      };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === '/v1/workspaces/acme') json = workspace;
    else if (path.endsWith('/model-catalog')) json = chatCatalog;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: memberId,
        role: 'member',
        teams,
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith(`/tables/${tableId}`))
      json = {
        id: tableId,
        saved: null,
        applied: { revision, definition, appliedAt: workspace.createdAt },
        rowPermissions: permissions,
      };
    else if (path.endsWith(`/tables/${tableId}/schema-history`)) json = { entries: [], nextCursor: null };
    else if (path.endsWith(`/tables/${tableId}/deleted-rows`))
      json = {
        records: [...tombstones.values()].map(row => ({
          id: row.id,
          token: row.token,
          deletedAt: workspace.createdAt,
          recoverableUntil: '2099-10-02T12:00:00.000Z',
        })),
        nextCursor: null,
      };
    else if (/\/rows\/[^/]+\/reverse-fields$/.test(path))
      json = {
        fields: [{ fieldId: reverseFieldId, tableId, label: 'Related tickets', cardinality: 'many' }],
        nextCursor: null,
      };
    else if (/\/rows\/[^/]+\/reverse\/[^/]+$/.test(path))
      json = {
        kind: 'relationship',
        tableId,
        cardinality: 'many',
        recordIds: linkedIds.size ? [...linkedIds] : [],
        nextCursor: null,
      };
    else if (/\/rows\/[^/]+\/history$/.test(path)) {
      const rowId = path.split('/').at(-2),
        entry = {
          id: randomUUID(),
          token: randomUUID(),
          actor: { kind: 'human', userId: 'ada' },
          field_ids: [subjectId],
          outcome: 'applied',
          created_at: workspace.createdAt,
          recoverable_until: '2099-10-02T12:00:00.000Z',
        };
      json = [
        tombstones.has(rowId)
          ? {
              ...entry,
              operation: 'delete',
              before_values: { [subjectId]: { kind: 'text', value: 'Deleted subject' } },
              values: null,
            }
          : {
              ...entry,
              operation: 'update',
              before_values: { [subjectId]: { kind: 'text', value: 'Older subject' } },
              values: records.get(rowId)?.values ?? null,
            },
      ];
    } else if (path.includes(`/tables/${tableId}/requests/`)) {
      const result = receipts.get(path.split('/').at(-1));
      json = result ? { status: 'applied', result } : { status: 'unknown' };
    } else if (path.endsWith(`/tables/${tableId}/rows`) && request.method() === 'POST') {
      const { requestId, ...input } = request.postDataJSON();
      z.uuid().parse(requestId);
      const body = mutationSchema.parse(input);
      writes.push({ requestId, ...body });
      assert.equal(body.tableId, tableId);
      const prior = receipts.get(requestId);
      if (prior) return route.fulfill({ json: prior });
      if (body.revision !== revision) return route.fulfill({ status: 409, json: { error: 'stale-generation' } });
      await delay(writeDelay);
      if (dropBeforeWrite) {
        dropBeforeWrite = false;
        return route.abort('failed');
      }
      if (body.kind === 'create') {
        if (records.has(body.recordId)) return route.fulfill({ status: 409, json: { error: 'stale-record' } });
        records.set(body.recordId, { id: body.recordId, token: randomUUID(), values: body.values });
        json = { kind: 'available', ...records.get(body.recordId) };
      } else if (body.kind === 'update') {
        const current = records.get(body.recordId);
        if (current?.token !== body.expectedToken)
          return route.fulfill({ status: 409, json: { error: 'stale-record' } });
        records.set(body.recordId, { ...current, token: randomUUID(), values: { ...current.values, ...body.values } });
        json = { kind: 'available', ...records.get(body.recordId) };
      } else if (body.kind === 'delete') {
        const current = records.get(body.recordId);
        if (current?.token !== body.expectedToken)
          return route.fulfill({ status: 409, json: { error: 'stale-record' } });
        if (deniedIds.has(body.recordId))
          return route.fulfill({ status: 403, json: { error: 'table-operation-failed' } });
        if (linkedIds.has(body.recordId)) return route.fulfill({ status: 409, json: { error: 'linked-record' } });
        records.delete(body.recordId);
        const token = randomUUID();
        tombstones.set(body.recordId, { id: body.recordId, token });
        json = { kind: 'available', id: body.recordId, token, values: null };
      } else return route.fulfill({ status: 400, json: { error: 'invalid-request' } });
      receipts.set(requestId, structuredClone(json));
      if (dropWrite) {
        dropWrite = false;
        return route.abort('failed');
      }
    } else if (path.endsWith(`/tables/${tableId}/query`) && request.method() === 'POST') {
      const body = request.postDataJSON();
      if (body.revision !== revision) return route.fulfill({ status: 409, json: { error: 'stale-generation' } });
      rowReads++;
      if (rowsGate) await rowsGate;
      await delay(rowsDelay);
      if (rowsStatus !== 200) return route.fulfill({ status: rowsStatus, json: { error: 'table-operation-failed' } });
      return route.fulfill(rowPage(body));
    } else if (path.endsWith(`/tables/${tableId}/rows`) && request.method() === 'GET') {
      await delay(rowsDelay);
      if (rowsStatus !== 200) return route.fulfill({ status: rowsStatus, json: { error: 'table-operation-failed' } });
      const ids = new Set((url.searchParams.get('ids') ?? '').split(','));
      json = [...records.values()].filter(row => ids.has(row.id));
    } else return route.fulfill({ status: 404, json: { error: 'unavailable' } });
    return route.fulfill({ json });
  });

  const rows = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Rows', exact: true, includeHidden: true }) })
    .last();
  const loadingRows = async size => {
    const table = rows.locator('table[aria-busy="true"]');
    await table.waitFor();
    assert.equal(
      await table.locator('tbody tr[data-loading-row]').count(),
      size,
      `${size} requested rows have ${size} placeholders`,
    );
    assert.equal(
      await table.locator('thead th').count(),
      definition.fields.length + 2,
      'Loading keeps selection, fields, and actions headers',
    );
    const actionsHeading = table.getByRole('columnheader', { name: 'Actions', exact: true });
    assert.ok(
      await actionsHeading.evaluate(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect().width > 20;
      }),
      'Actions is visibly labeled while loading',
    );
    assert.equal(
      await table.locator('tbody tr').first().locator('td').count(),
      definition.fields.length + 2,
      'Skeleton cells match the headers',
    );
    assert.equal(await table.getByRole('checkbox', { name: 'Select all rows on this page' }).isDisabled(), true);
    const footer = rows.getByRole('navigation', { name: 'Row pages' });
    await footer.getByText('Loading rows…', { exact: true }).waitFor();
    assert.equal(await footer.getByRole('combobox', { name: 'Rows per page' }).isDisabled(), true);
    for (const button of await footer.getByRole('button').all())
      assert.equal(await button.isDisabled(), true, 'Loading locks pagination');
    assert.equal(await footer.getByText(/\d+-\d+.*rows/).count(), 0, 'Loading never invents a range');
  };
  const addRow = rows.getByRole('button', { name: 'Add row', exact: true });
  const dialog = page.getByRole('alertdialog');
  const rowActions = id => rows.getByRole('button', { name: `Actions for row ${id.slice(0, 8)}`, exact: true });
  const rowAction = async (id, item) => {
    await rowActions(id).click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  };
  const rowMenu = async id => {
    await rowActions(id).click();
    await page.getByRole('menuitem').first().waitFor();
    const items = await page.getByRole('menuitem').allTextContents();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'detached' });
    return items;
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

  rowsGate = new Promise(resolve => {
    releaseRows = resolve;
  });
  await page.goto(`${origin}/acme/tables/${tableId}`);
  await page.getByRole('heading', { name: 'Support tickets', exact: true }).waitFor();
  await loadingRows(50);
  await capture('table-rows-initial-loading-50');
  assert.equal(
    await rows.getByText('No rows yet', { exact: true }).count(),
    0,
    'Empty state never flashes while rows load',
  );
  assert.equal(await addRow.count(), 0, 'Add row waits for a successful read');
  releaseRows();
  rowsGate = null;
  await rows.getByText('No rows yet', { exact: true }).waitFor();
  await rows.getByText(/Add one here, or ask the assistant/).waitFor();
  assert.equal(await addRow.count(), 1, 'Empty table offers one Add row action');

  await addRow.click();
  const editor = page.getByRole('form', { name: 'Add row', exact: true });
  await editor.waitFor();
  assert.equal(
    await rows.getByRole('button', { name: 'Add row', exact: true, includeHidden: true }).isDisabled(),
    true,
    'Add row is locked while a row form is open',
  );
  await editor.getByRole('button', { name: 'Save new row', exact: true }).click();
  await editor.getByText('Enter subject.', { exact: true }).waitFor();
  assert.equal(await editor.getByLabel('Subject', { exact: true }).getAttribute('aria-invalid'), 'true');
  assert.equal(
    await editor.getByLabel('Subject', { exact: true }).evaluate(element => element === document.activeElement),
    true,
  );
  assert.equal(writes.length, 0, 'Client validation sends nothing');
  await editor.getByLabel('Subject', { exact: true }).fill('Printer offline');
  await editor.getByLabel('Notes', { exact: true }).fill('temporary');
  await editor.getByLabel('Notes', { exact: true }).fill('');
  const draftInput = await editor.getByLabel('Subject', { exact: true }).elementHandle();
  await renameTable('Support tickets renamed');
  assert.equal(
    await draftInput.evaluate(element => element.isConnected),
    true,
    'An applied label-only revision must not remount the new-row editor',
  );
  assert.equal(await editor.getByLabel('Subject', { exact: true }).inputValue(), 'Printer offline');
  assert.equal(writes.length, 0, 'A schema refresh never saves a draft');
  writeDelay = 300;
  await editor.getByRole('button', { name: 'Save new row', exact: true }).dblclick();
  await editor.getByRole('button', { name: 'Saving new row…', exact: true }).waitFor();
  assert.equal(
    await editor.getByRole('button', { name: 'Saving new row…', exact: true }).getAttribute('aria-busy'),
    'true',
  );
  await rows.getByText(/^Row added\./).waitFor();
  await rows.getByRole('cell', { name: 'Printer offline', exact: true }).waitFor();
  assert.equal(writes.length, 1, 'Double click creates one row');
  const created = writes[0];
  assert.equal(created.kind, 'create');
  assert.equal(Object.hasOwn(created, 'expectedToken'), false);
  assert.deepEqual(
    created.values,
    { [subjectId]: { kind: 'text', value: 'Printer offline' } },
    'Cleared optional fields are omitted from a new row',
  );
  assert.equal(await editor.count(), 0);

  await addRow.click();
  await editor.getByLabel('Subject', { exact: true }).fill('Badge reader broken');
  writeDelay = 0;
  dropWrite = true;
  await editor.getByRole('button', { name: 'Save new row', exact: true }).click();
  await editor.getByRole('button', { name: 'Check row request', exact: true }).waitFor();
  assert.equal(
    await editor.getByLabel('Subject', { exact: true }).inputValue(),
    'Badge reader broken',
    'Unconfirmed create keeps input',
  );
  const unconfirmed = structuredClone(writes.at(-1));
  await renameTable('Support tickets renamed again');
  assert.equal(
    await editor.getByLabel('Subject', { exact: true }).inputValue(),
    'Badge reader broken',
    'A new applied revision preserves uncertain input',
  );
  assert.deepEqual(writes.at(-1), unconfirmed, 'Refreshing never rewrites the uncertain command');
  assert.equal(await editor.getByLabel('Subject', { exact: true }).isDisabled(), true);
  await editor.getByRole('button', { name: 'Check row request', exact: true }).click();
  await rows.getByText(/^Row added\./).waitFor();
  await rows.getByRole('cell', { name: 'Badge reader broken', exact: true }).waitFor();
  assert.equal(writes.length, 2, 'Receipt check confirms the create without a second write');

  await addRow.click();
  await editor.getByLabel('Subject', { exact: true }).fill('Draft survives refresh');
  rowsStatus = 503;
  await changeRows();
  await editor.getByRole('button', { name: 'Reload table', exact: true }).waitFor();
  assert.equal(
    await rows.getByRole('cell', { name: 'Printer offline', exact: true, includeHidden: true }).count(),
    1,
    'Failed background refresh keeps the loaded rows',
  );
  assert.equal(
    await editor.getByLabel('Subject', { exact: true }).inputValue(),
    'Draft survives refresh',
    'Failed background refresh keeps the draft',
  );
  rowsStatus = 200;
  await editor.getByRole('button', { name: 'Reload table', exact: true }).click();
  await editor.getByRole('button', { name: 'Reload table', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await editor.getByLabel('Subject', { exact: true }).inputValue(), 'Draft survives refresh');
  await editor.getByRole('button', { name: 'Discard new row', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(writes.length, 2, 'Discarding a draft sends nothing');

  await addRow.click();
  await editor.getByLabel('Subject', { exact: true }).fill('Keep compatible text');
  await editor.getByLabel('Notes', { exact: true }).fill('Keep removed text until I agree');
  const originalFields = structuredClone(definition.fields);
  definition.fields = [definition.fields[0], definition.fields[2]];
  await renameTable('Support tickets changed fields');
  await page.getByRole('button', { name: 'Review field changes', exact: true }).waitFor();
  assert.equal(
    await editor.getByLabel('Notes', { exact: true }).inputValue(),
    'Keep removed text until I agree',
    'Removed-field input stays visible before review',
  );
  assert.equal(
    await editor.getByRole('button', { name: 'Save new row', exact: true }).getAttribute('aria-disabled'),
    'true',
  );
  for (const [width, theme] of [
    [320, 'light'],
    [375, 'dark'],
    [768, 'light'],
    [1440, 'light'],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await capture(`retained-fields-${width}-${theme}`);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('button', { name: 'Review field changes', exact: true }).click();
  await dialog.getByText(/cleared only if you continue: Notes/).waitFor();
  assert.equal(
    await dialog.evaluate(element => element.scrollWidth <= element.clientWidth),
    true,
    'Field review fits a narrow screen',
  );
  await capture('review-removed-field-320-dark');
  await dialog.getByRole('button', { name: 'Keep old input', exact: true }).click();
  assert.equal(await editor.getByLabel('Notes', { exact: true }).inputValue(), 'Keep removed text until I agree');
  await page.getByRole('button', { name: 'Review field changes', exact: true }).click();
  await renameTable('Support tickets another change');
  await dialog.getByText('The fields changed again. Cancel and review the latest change.', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Clear listed input', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Keep old input', exact: true }).click();
  await page.getByRole('button', { name: 'Review field changes', exact: true }).click();
  await dialog.getByRole('button', { name: 'Clear listed input', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await editor.getByLabel('Notes', { exact: true }).count(), 0);
  assert.equal(await editor.getByLabel('Subject', { exact: true }).inputValue(), 'Keep compatible text');
  definition.fields[0] = { ...definition.fields[0], maxLength: 5 };
  await renameTable('Support tickets shorter subject');
  await page.getByRole('button', { name: 'Review field changes', exact: true }).click();
  await dialog.getByRole('button', { name: 'Use current fields', exact: true }).click();
  assert.equal(
    await editor.getByLabel('Subject', { exact: true }).inputValue(),
    'Keep compatible text',
    'New limits never truncate input',
  );
  await editor.getByRole('button', { name: 'Save new row', exact: true }).click();
  await editor.getByText('Enter valid text, up to 5 characters.', { exact: true }).waitFor();
  assert.equal(writes.length, 2, 'Review and invalid current fields never write');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await editor.getByRole('button', { name: 'Discard new row', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  definition.fields = originalFields;
  await renameTable('Support tickets restored fields');

  await addRow.click();
  await editor.getByLabel('Subject', { exact: true }).fill('Keep while new rows fail');
  rowsStatus = 503;
  await renameTable('Support tickets failed new read');
  await editor.getByRole('button', { name: 'Reload table', exact: true }).waitFor();
  assert.equal(await editor.getByLabel('Subject', { exact: true }).inputValue(), 'Keep while new rows fail');
  assert.equal(
    await rows.getByRole('cell', { name: 'Printer offline', exact: true, includeHidden: true }).count(),
    0,
    'Old-revision rows never render under new fields after a failed read',
  );
  rowsStatus = 200;
  await editor.getByRole('button', { name: 'Reload table', exact: true }).click();
  await editor.getByRole('button', { name: 'Reload table', exact: true }).waitFor({ state: 'detached' });
  permissions = { create: false, update: true, delete: true };
  await renameTable('Support tickets create permission removed');
  assert.equal(await editor.getByLabel('Subject', { exact: true }).inputValue(), 'Keep while new rows fail');
  assert.equal(
    await editor.getByRole('button', { name: 'Save new row', exact: true }).getAttribute('aria-disabled'),
    'true',
    'Retained input grants no write authority',
  );
  rowsStatus = 403;
  await changeRows();
  await editor.waitFor({ state: 'detached' });
  assert.equal(
    await page.getByText('Keep while new rows fail', { exact: true }).count(),
    0,
    'Read revocation conceals the editor',
  );
  rowsStatus = 200;
  permissions = { create: true, update: true, delete: true };
  await changeRows();
  await renameTable('Support tickets access restored');
  assert.equal(await editor.count(), 0, 'A denied draft does not reopen after access returns');
  await addRow.click();
  assert.equal(await editor.getByLabel('Subject', { exact: true }).inputValue(), '', 'Revoked drafts are not restored');
  await editor.getByRole('button', { name: 'Discard new row', exact: true }).click();
  await editor.waitFor({ state: 'detached' });

  const target = [...records.values()].find(row => row.values[subjectId].value === 'Printer offline');
  const short = target.id.slice(0, 8);
  await rowAction(target.id, 'Edit row');
  const editRow = page.getByRole('form', { name: 'Edit row', exact: true });
  await editRow.getByLabel('Subject', { exact: true }).fill('Keep existing-row edits');
  await renameTable('Support tickets edit refresh');
  assert.equal(await editRow.getByLabel('Subject', { exact: true }).inputValue(), 'Keep existing-row edits');
  await editRow.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await editRow.waitFor({ state: 'detached' });
  assert.equal(target.values[subjectId].value, 'Printer offline');
  assert.equal(writes.length, 2);
  await rowAction(target.id, 'Delete row');
  await dialog.getByText(`Delete row ${short}?`, { exact: true }).waitFor();
  await dialog.getByText(/Its values stay recoverable for 30 days from Deleted rows in the ⋯ menu\./).waitFor();
  await dialog.getByRole('button', { name: 'Keep row', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(writes.length, 2, 'Keeping the row sends nothing');
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    `Actions for row ${short}`,
    'Focus returns to the row menu that opened the dialog',
  );

  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 390, height: 844 });
    await rowAction(target.id, 'Delete row');
    await dialog.getByText(`Delete row ${short}?`, { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'Delete confirmation does not overflow',
    );
    if (process.env.TABLE_ROWS_SCREENSHOTS)
      await page.screenshot({ path: `${process.env.TABLE_ROWS_SCREENSHOTS}/table-row-delete-mobile-${theme}.png` });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(writes.length, 2, 'Escape dismisses without deleting');

  await rowAction(target.id, 'Delete row');
  writeDelay = 300;
  await dialog.getByRole('button', { name: 'Delete row', exact: true }).dblclick();
  await dialog.getByRole('button', { name: 'Deleting row…', exact: true }).waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: 'Keep row', exact: true }).isDisabled(),
    true,
    'Pending delete cannot be dismissed',
  );
  await rows
    .getByText('Row deleted. Restore it from Deleted rows in the ⋯ menu within 30 days.', { exact: true })
    .waitFor();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await rows.getByRole('cell', { name: 'Printer offline', exact: true }).count(), 0);
  assert.equal(writes.length, 3, 'Double click deletes once');
  assert.deepEqual(
    { kind: writes[2].kind, recordId: writes[2].recordId, expectedToken: writes[2].expectedToken },
    { kind: 'delete', recordId: target.id, expectedToken: target.token },
    'Delete uses the row token',
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    'Rows',
    'Focus moves to the rows heading after the deleted row disappears',
  );
  await openPanel('Deleted rows');
  await page
    .getByRole('region', { name: 'Deleted rows', exact: true })
    .getByRole('button', { name: `Review deleted row ${short}`, exact: true })
    .waitFor();
  await closePanel();

  const changed = [...records.values()][0],
    staleToken = changed.token;
  await rowAction(changed.id, 'Delete row');
  changed.token = randomUUID();
  await dialog.getByRole('button', { name: 'Delete row', exact: true }).click();
  await dialog
    .getByText(
      'This row changed since you opened it. Close this dialog and review the current row before deleting it.',
      { exact: true },
    )
    .waitFor();
  assert.equal(writes.at(-1).expectedToken, staleToken);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });

  const linked = [...records.values()][0];
  deniedIds = new Set([linked.id]);
  writeDelay = 0;
  await rowAction(linked.id, 'Delete row');
  await dialog.getByRole('button', { name: 'Delete row', exact: true }).click();
  await dialog
    .getByText(
      'This table or a referenced file is missing, or your permission changed. A workspace admin can review your access.',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: 'Delete row', exact: true }).count(),
    0,
    'A denied delete offers no blind retry',
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await rows.getByRole('cell', { name: 'Badge reader broken', exact: true }).waitFor();
  deniedIds = new Set();
  linkedIds = new Set([linked.id]);
  await rowAction(linked.id, 'Delete row');
  await dialog.getByRole('button', { name: 'Delete row', exact: true }).click();
  await dialog
    .getByText(
      'Linked deletion is blocked. Another row still links to this row. Remove those links, then delete it again.',
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await dialog.getByRole('button', { name: 'Delete row', exact: true }).count(),
    0,
    'A confirmed rejection offers no blind retry',
  );
  await dialog.getByRole('link', { name: 'View incoming linked rows', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('region', { name: 'Incoming linked rows', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Related tickets', exact: true }).waitFor();
  await page.getByRole('link', { name: `Row ${linked.id.slice(0, 8)}`, exact: true }).waitFor();
  const linkedToken = records.get(linked.id).token;
  await page.getByRole('button', { name: 'Edit row', exact: true }).click();
  const linkedEditor = page.getByRole('form', { name: 'Edit row', exact: true });
  await linkedEditor.getByLabel('Notes', { exact: true }).fill('Edited from linked row');
  rowsDelay = 500;
  await renameTable('Support tickets linked-row refresh');
  assert.equal(
    await linkedEditor.getByLabel('Notes', { exact: true }).inputValue(),
    'Edited from linked row',
    'Direct linked-row drafts survive a new revision loading',
  );
  rowsDelay = 0;
  await linkedEditor.getByRole('button', { name: 'Reload table', exact: true }).waitFor({ state: 'detached' });
  await linkedEditor.getByRole('button', { name: 'Save row', exact: true }).click();
  await page.getByText('Row saved.', { exact: true }).waitFor();
  assert.deepEqual(writes.at(-1).values, { [notesId]: { kind: 'text', value: 'Edited from linked row' } });
  assert.equal(writes.at(-1).expectedToken, linkedToken, 'Linked-row editing preserves the original version token');
  await page.getByRole('button', { name: 'Delete row', exact: true }).click();
  await dialog.getByRole('button', { name: 'Keep row', exact: true }).click();
  await page.goto(`${origin}/acme/tables/${tableId}`);
  await rows.getByRole('cell', { name: 'Badge reader broken', exact: true }).waitFor();

  permissions = { create: false, update: false, delete: false };
  await page.reload();
  await rows.getByRole('cell', { name: 'Badge reader broken', exact: true }).waitFor();
  assert.equal(await addRow.count(), 0, 'Read-only members cannot add rows');
  assert.deepEqual(await rowMenu(linked.id), ['History'], 'Read-only members cannot edit or delete rows');
  const history = page.getByRole('region', { name: 'Row history', exact: true });
  const deletedPanel = page.getByRole('region', { name: 'Deleted rows', exact: true });
  const restore = history.getByRole('button', { name: 'Restore reviewed values', exact: true });
  const reviewLive = async () => {
    await rowAction(linked.id, 'History');
    await history.getByRole('button', { name: 'Review values before update', exact: true }).click();
    await history.getByRole('cell', { name: 'Older subject', exact: true }).waitFor();
  };
  const reviewDeleted = async () => {
    await openPanel('Deleted rows');
    await deletedPanel.getByRole('button', { name: `Review deleted row ${short}`, exact: true }).click();
    await history.getByRole('button', { name: 'Review values before delete', exact: true }).click();
    await history.getByRole('cell', { name: 'Deleted subject', exact: true }).waitFor();
  };
  const closeHistory = async () => {
    await history.getByRole('button', { name: 'Close history', exact: true }).click();
    await history.waitFor({ state: 'detached' });
    if (await page.getByRole('dialog').count()) await closePanel();
  };
  await reviewLive();
  assert.equal(await restore.count(), 0, 'Read-only members cannot restore a live row');
  await history.getByText(/restoring them needs permission to update rows/).waitFor();
  await closeHistory();
  await reviewDeleted();
  assert.equal(await restore.count(), 0, 'Read-only members cannot restore a deleted row');
  await history.getByText(/restoring a deleted row needs permission to create rows/).waitFor();
  await closeHistory();

  permissions = { create: false, update: true, delete: false };
  await page.reload();
  await reviewLive();
  await restore.waitFor();
  await closeHistory();
  await reviewDeleted();
  assert.equal(await restore.count(), 0, 'Update permission does not restore a deleted row');
  await closeHistory();

  permissions = { create: true, update: false, delete: false };
  await page.reload();
  await reviewDeleted();
  await restore.waitFor();
  await closeHistory();
  await reviewLive();
  assert.equal(await restore.count(), 0, 'Create permission does not restore a live row');
  await closeHistory();

  permissions = { create: false, update: false, delete: true };
  await page.reload();
  await rowActions(linked.id).waitFor();
  assert.equal(await addRow.count(), 0);
  assert.deepEqual(
    await rowMenu(linked.id),
    ['History', 'Delete row'],
    'Delete permission alone offers delete, not edit',
  );

  records.clear();
  permissions = { create: false, update: false, delete: false };
  await page.reload();
  await rows.getByText('No rows yet', { exact: true }).waitFor();
  assert.equal(await addRow.count(), 0, 'Read-only empty state offers chat only');
  await rows.getByText('Add rows in chat', { exact: true }).waitFor();

  permissions = { create: true, update: true, delete: true };
  rowsStatus = 503;
  await page.reload();
  await rows.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  assert.equal(await addRow.count(), 0, 'A failed read offers retry, not Add row');
  const readsBeforeRetry = rowReads;
  rowsDelay = 400;
  await rows.getByRole('button', { name: 'Try again', exact: true }).click();
  await rows.locator('table[aria-busy="true"]').waitFor();
  await rows.locator('table[aria-busy="true"]').waitFor({ state: 'detached' });
  assert.ok(rowReads > readsBeforeRetry, 'Try again sends a read');
  await rows.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  await rows.getByText('Could not load tables', { exact: true }).waitFor();
  assert.equal(await addRow.count(), 0, 'A failed retry returns to an actionable error');
  rowsStatus = 200;
  rowsDelay = 0;
  await rows.getByRole('button', { name: 'Try again', exact: true }).click();
  await rows.getByText('No rows yet', { exact: true }).waitFor();
  await addRow.waitFor();

  const urlState = () => Object.fromEntries(new URL(page.url()).searchParams);
  const subjects = () =>
    rows
      .locator('table[data-slot=table] tbody tr')
      .evaluateAll(trs => trs.map(tr => tr.querySelectorAll('td')[1]?.textContent));
  const settled = async (expected, message, read = () => true) => {
    for (
      let i = 0;
      i < 100 && (JSON.stringify(await subjects()) !== JSON.stringify(expected) || !read(pageReads.at(-1)));
      i++
    )
      await delay(50);
    assert.deepEqual(await subjects(), expected, message ?? 'Rows match');
  };
  const lastRead = () => pageReads.at(-1);
  const tools = rows.getByRole('group', { name: 'Table tools', exact: true }),
    filters = rows.getByRole('group', { name: 'Filters', exact: true });
  const searchButton = tools.getByRole('button', { name: /^(Search|“.*”)$/ });
  const searchRows = page.getByRole('searchbox', { name: 'Search rows', exact: true });
  const openSearch = async () => {
    await searchButton.click();
    await searchRows.waitFor();
  };
  const closeSearch = async () => {
    await page.keyboard.press('Escape');
    await searchRows.waitFor({ state: 'detached' });
  };
  const sortHeader = label => rows.getByRole('button', { name: new RegExp(`^Sort by ${label}`) });
  const ariaSort = label =>
    rows
      .getByRole('columnheader')
      .filter({ has: page.getByRole('button', { name: new RegExp(`^Sort by ${label}`) }) })
      .getAttribute('aria-sort');
  const filterPopover = page.getByRole('dialog').filter({ has: page.getByLabel('Field', { exact: true }) });
  const filterField = filterPopover.getByLabel('Field', { exact: true }),
    condition = filterPopover.getByLabel('Condition', { exact: true }),
    filterValue = filterPopover.getByLabel('Value', { exact: true });
  const choose = async (control, label) => {
    await control.click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await page.getByRole('option').first().waitFor({ state: 'detached' });
  };
  const optionsOf = async control => {
    await control.click();
    await page.getByRole('option').first().waitFor();
    const options = await page.getByRole('option').allTextContents();
    await page.keyboard.press('Escape');
    await page.getByRole('option').first().waitFor({ state: 'detached' });
    return options;
  };
  const rule = (fieldId, op, values) => ({ kind: 'rule', fieldId, op, values });
  for (const [subject, priority] of [
    ['Alpha printer', '3'],
    ['Bravo badge', '1'],
    ['Charlie printer', '2'],
    ['Delta desk', null],
    ['Echo email', '5'],
  ]) {
    const id = randomUUID();
    records.set(id, {
      id,
      token: randomUUID(),
      values: {
        [subjectId]: { kind: 'text', value: subject },
        ...(priority ? { [priorityId]: { kind: 'numeric', value: priority } } : {}),
      },
    });
  }
  await page.reload();
  await rows.getByText('5 rows', { exact: true }).waitFor();
  for (const label of ['Subject', 'Notes', 'Priority'])
    assert.equal(await sortHeader(label).count(), 1, `${label} sorts from its column header`);
  assert.equal(await ariaSort('Priority'), null, 'No column is sorted before a choice');

  await openSearch();
  await searchRows.fill('PRINTER');
  await page.waitForURL(url => url.searchParams.get('q') === 'PRINTER');
  await rows.getByRole('status').filter({ hasText: '2 matching rows' }).waitFor();
  assert.equal(lastRead().search, 'PRINTER', 'Search runs on the server');
  assert.equal(lastRead().after, undefined);
  assert.deepEqual((await subjects()).sort(), ['Alpha printer', 'Charlie printer'], 'Search narrows the rows');
  await closeSearch();

  await sortHeader('Priority').click();
  await page.waitForURL(url => url.searchParams.has('order'));
  await settled(
    ['Charlie printer', 'Alpha printer'],
    'Rows sort by priority ascending',
    read => read.sort[0]?.direction === 'asc',
  );
  assert.deepEqual(lastRead().sort, [{ fieldId: priorityId, direction: 'asc' }]);
  assert.equal(await ariaSort('Priority'), 'ascending');
  await sortHeader('Priority').click();
  await settled(
    ['Alpha printer', 'Charlie printer'],
    'Rows sort by priority descending',
    read => read.sort[0]?.direction === 'desc',
  );
  assert.deepEqual(lastRead().sort, [{ fieldId: priorityId, direction: 'desc' }]);
  assert.equal(await ariaSort('Priority'), 'descending');

  const readsBeforeFilter = pageReads.length;
  await filters.getByRole('button', { name: 'Add filter', exact: true }).click();
  await choose(filterField, 'Priority');
  assert.deepEqual(await optionsOf(condition), [
    'is',
    'is not',
    'is less than',
    'is at most',
    'is greater than',
    'is at least',
    'is any of',
    'is none of',
    'is empty',
    'is not empty',
  ]);
  await choose(condition, 'is at least');
  assert.equal(await filterValue.getAttribute('inputmode'), 'decimal');
  await filterValue.fill('high');
  await filterPopover.getByRole('button', { name: 'Add filter', exact: true }).click();
  assert.equal(
    await filterValue.getAttribute('aria-invalid'),
    'true',
    'A value that does not fit its field is refused before any request',
  );
  assert.equal(pageReads.length, readsBeforeFilter);
  assert.equal(new URL(page.url()).searchParams.has('where'), false);
  await filterValue.fill('3');
  await filterPopover.getByRole('button', { name: 'Add filter', exact: true }).click();
  await filterPopover.waitFor({ state: 'detached' });
  await settled(['Alpha printer'], 'Filter narrows the rows', read => !!read.where);
  assert.deepEqual(lastRead().where, rule(priorityId, 'gte', ['3']));
  await filters.getByRole('button', { name: 'Edit filter: Priority is at least 3', exact: true }).waitFor();
  const where = printRsql(definition, rule(priorityId, 'gte', ['3']));
  assert.deepEqual(
    urlState(),
    { q: 'PRINTER', order: `-${priorityId}`, where },
    'Search, sort, and filter live in the URL',
  );

  const readsBeforeReload = pageReads.length;
  await page.reload();
  await settled(['Alpha printer'], 'Reload restores the same rows');
  assert.deepEqual(
    pageReads.slice(readsBeforeReload).map(read => [read.search, read.sort, read.where]),
    [['PRINTER', [{ fieldId: priorityId, direction: 'desc' }], rule(priorityId, 'gte', ['3'])]],
    'Reload sends the URL query once',
  );
  await filters.getByRole('button', { name: 'Edit filter: Priority is at least 3', exact: true }).waitFor();
  assert.equal(await ariaSort('Priority'), 'descending');
  assert.equal(await searchButton.innerText(), '“PRINTER”');
  await openSearch();
  assert.equal(await searchRows.inputValue(), 'PRINTER', 'Reload restores the controls');
  await closeSearch();

  const rejected = printRsql(definition, rule(priorityId, 'gte', ['high']));
  const readsBeforeRejected = pageReads.length;
  await page.goto(
    `${origin}/acme/tables/${tableId}?q=PRINTER&order=-${priorityId}&where=${encodeURIComponent(rejected)}`,
  );
  await rows.getByText(/This search can’t run\./).waitFor();
  assert.equal(pageReads.length, readsBeforeRejected, 'The server refuses the query before reading rows');
  assert.equal(
    await rows.getByRole('button', { name: 'Try again', exact: true }).count(),
    0,
    'A rejected filter offers no retry that repeats it',
  );
  assert.equal(await searchButton.isEnabled(), true, 'The toolbar stays usable after a rejected filter');
  await rows.getByRole('button', { name: 'Clear filters', exact: true }).last().click();
  await settled(
    ['Echo email', 'Alpha printer', 'Charlie printer', 'Bravo badge', 'Delta desk'],
    'Clear filters keeps the sort',
  );
  assert.deepEqual(urlState(), { order: `-${priorityId}` });
  assert.equal(await filters.getByRole('button', { name: /^Edit filter/ }).count(), 0);
  await rows.getByText('5 rows', { exact: true }).waitFor();

  await openSearch();
  await searchRows.fill('nobody');
  await rows.getByText('No rows match', { exact: true }).waitFor();
  assert.equal(await searchRows.isVisible(), true, 'No results keeps the search field');
  await closeSearch();
  assert.equal(await addRow.count(), 1, 'No results keeps Add row in the header');
  await rows.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await settled(['Echo email', 'Alpha printer', 'Charlie printer', 'Bravo badge', 'Delta desk']);
  await openSearch();
  assert.equal(await searchRows.inputValue(), '');
  await closeSearch();

  await filters.getByRole('button', { name: 'Add filter', exact: true }).click();
  await choose(filterField, 'Subject');
  assert.deepEqual(await optionsOf(condition), [
    'is',
    'is not',
    'is any of',
    'is none of',
    'contains',
    'is empty',
    'is not empty',
  ]);
  await choose(condition, 'is not empty');
  await filterValue.waitFor({ state: 'detached' });
  await filterPopover.getByRole('button', { name: 'Add filter', exact: true }).click();
  await filterPopover.waitFor({ state: 'detached' });
  await settled(
    ['Echo email', 'Alpha printer', 'Charlie printer', 'Bravo badge', 'Delta desk'],
    'Every row has a subject',
    read => !!read.where,
  );
  assert.deepEqual(lastRead().where, rule(subjectId, 'not-empty', []));
  await filters.getByRole('button', { name: 'Edit filter: Subject is not empty', exact: true }).click();
  await page.getByRole('button', { name: 'Remove filter', exact: true }).click();
  await page.waitForURL(url => !url.searchParams.has('where'));

  pageSize = 2;
  await page.reload();
  await settled(['Echo email', 'Alpha printer']);
  await rows.getByRole('button', { name: 'Next rows', exact: true }).click();
  await settled(['Charlie printer', 'Bravo badge'], 'Next rows shows the second page');
  assert.equal(lastRead().after, issuedCursors.at(-2), 'Next rows sends the nextCursor back verbatim');
  assert.equal(await rows.getByText('5 rows', { exact: true }).count(), 0, 'Later pages carry no total');
  await sortHeader('Subject').click();
  await settled(['Alpha printer', 'Bravo badge'], 'A new sort returns to page 1');
  assert.equal(lastRead().after, undefined);
  assert.equal(await rows.getByRole('button', { name: 'Previous rows', exact: true }).isDisabled(), true);
  await rows.getByRole('button', { name: 'Next rows', exact: true }).click();
  await settled(['Charlie printer', 'Delta desk']);
  staleCursors = true;
  await changeRows();
  await rows
    .getByText('This page is no longer valid. The rows may have changed since it loaded.', { exact: true })
    .waitFor();
  assert.equal(
    await rows.getByRole('button', { name: 'Try again', exact: true }).count(),
    0,
    'A stale page offers no retry that repeats it',
  );
  staleCursors = false;
  await rows.getByRole('button', { name: 'Back to first rows', exact: true }).click();
  await settled(['Alpha printer', 'Bravo badge'], 'A stale page link returns to the first rows');

  await addRow.click();
  assert.equal(
    await rows.getByRole('button', { name: /^Sort by Subject/, includeHidden: true }).isDisabled(),
    true,
    'Sorting is locked while a row form is open',
  );
  assert.equal(await searchButton.count(), 0, 'The modal editor keeps the toolbar out of the accessibility tree');
  await editor.getByRole('button', { name: 'Discard new row', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  await sortHeader('Subject').click({ trial: true });
  assert.equal(await searchButton.isDisabled(), false);

  const beforeUncertain = writes.length;
  await addRow.click();
  await editor.getByLabel('Subject', { exact: true }).fill('Exact retry across revisions');
  dropBeforeWrite = true;
  await editor.getByRole('button', { name: 'Save new row', exact: true }).click();
  await editor.getByRole('button', { name: 'Check row request', exact: true }).waitFor();
  const originalCommand = structuredClone(writes.at(-1));
  definition.fields[0] = { ...definition.fields[0], maxLength: 190 };
  await renameTable('Support tickets uncertain schema');
  assert.equal(
    await page.getByRole('button', { name: 'Review field changes', exact: true }).isDisabled(),
    true,
    'Uncertain commands must settle before field review',
  );
  await editor.getByRole('button', { name: 'Check row request', exact: true }).click();
  await editor.getByRole('button', { name: 'Retry same row request', exact: true }).click();
  await editor.getByRole('button', { name: 'Check row request', exact: true }).waitFor({ state: 'detached' });
  assert.equal(writes.length, beforeUncertain + 2);
  assert.deepEqual(
    writes.at(-1),
    originalCommand,
    'Retry preserves request ID, generated row ID, original revision, and exact values',
  );
  assert.equal(records.has(originalCommand.recordId), false, 'The server still rejects an old revision');
  assert.equal(await editor.getByLabel('Subject', { exact: true }).inputValue(), 'Exact retry across revisions');
  await page.getByRole('button', { name: 'Review field changes', exact: true }).click();
  await dialog.getByRole('button', { name: 'Use current fields', exact: true }).click();
  await editor.getByRole('button', { name: 'Save new row', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(
    writes.at(-1).recordId,
    originalCommand.recordId,
    'An explicit revised save retains the generated row identity',
  );
  assert.notEqual(
    writes.at(-1).requestId,
    originalCommand.requestId,
    'A settled rejected command is not reused for changed intent',
  );
  assert.equal(writes.at(-1).revision, revision);

  const concurrent = [...records.values()][0];
  await page.goto(`${origin}/acme/tables/${tableId}?row=${concurrent.id}`);
  await page.getByRole('button', { name: 'Edit row', exact: true }).click();
  await linkedEditor.getByLabel('Notes', { exact: true }).fill('Do not overwrite another edit');
  const selectedToken = concurrent.token;
  concurrent.token = randomUUID();
  await renameTable('Support tickets concurrent row');
  await linkedEditor.getByRole('button', { name: 'Save row', exact: true }).click();
  await linkedEditor.getByText(/changed since/).waitFor();
  assert.equal(writes.at(-1).expectedToken, selectedToken, 'Fresh row reads never replace the edit session token');
  assert.equal(concurrent.values[notesId], undefined, 'A stale update is rejected');
  await linkedEditor.getByRole('button', { name: 'Discard edits', exact: true }).click();

  // Exercise page-scoped selection and real limits with more than one maximum-size page.
  records.clear();
  tombstones.clear();
  pageSize = 100;
  const bulkIds = Array.from({ length: 137 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  bulkIds.forEach((id, i) =>
    records.set(id, {
      id,
      token: randomUUID(),
      values: { [subjectId]: { kind: 'text', value: i === 0 ? '=HYPERLINK("unsafe")' : `Ticket ${i + 1}` } },
    }),
  );
  await page.goto(`${origin}/acme/tables/${tableId}`);
  await rows.getByRole('navigation', { name: 'Row pages' }).waitFor();
  const grid = rows.getByRole('table');
  const allRows = rows.getByRole('checkbox', { name: 'Select all rows on this page', exact: true });
  const checkRow = i => grid.locator('tbody tr').nth(i).getByRole('checkbox');
  const paging = rows.getByRole('navigation', { name: 'Row pages' });
  await paging.getByText('1-50 of 137 rows', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 50);
  assert.equal(
    await rows
      .getByRole('button', { name: /^Sort by Subject/ })
      .locator('svg')
      .count(),
    1,
    'Unsorted headers show a sort icon',
  );
  const borders = await grid.evaluate(table => ({
    frame: getComputedStyle(table.closest('[data-slot="table-container"]')).borderTopWidth,
    row: getComputedStyle(table.querySelector('tbody tr')).borderBottomWidth,
    cell: getComputedStyle(table.querySelector('td')).borderRightWidth,
  }));
  assert.deepEqual(borders, { frame: '1px', row: '1px', cell: '1px' }, 'Grid has frame, row and column separation');
  const alignment = await grid.locator('th:first-child, td:first-child').evaluateAll(cells =>
    cells.map(cell => {
      const box = cell.getBoundingClientRect(),
        checkbox = cell.querySelector('[role="checkbox"]').getBoundingClientRect();
      return {
        x: Math.abs(box.x + box.width / 2 - checkbox.x - checkbox.width / 2),
        y: Math.abs(box.y + box.height / 2 - checkbox.y - checkbox.height / 2),
      };
    }),
  );
  for (const delta of alignment) {
    assert.ok(delta.x <= 1, `Checkbox horizontal center is within 1px (${delta.x})`);
    assert.ok(delta.y <= 1, `Checkbox vertical center is within 1px (${delta.y})`);
  }
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await rows.locator('[data-slot="table-container"]').scrollIntoViewIfNeeded();
    await checkRow(0).focus();
    const geometry = () =>
      grid.evaluate(table => {
        const frame = table.closest('[data-slot="table-container"]').getBoundingClientRect(),
          row = table.querySelector('tbody tr').getBoundingClientRect();
        return {
          top: frame.top,
          left: frame.left,
          width: frame.width,
          height: frame.height,
          rowTop: row.top,
          scroll: table.closest('[data-slot="scroll-area-viewport"]').scrollTop,
        };
      });
    const before = await geometry();
    const stable = async state => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const after = await geometry();
      for (const key of Object.keys(before))
        assert.ok(
          Math.abs(before[key] - after[key]) <= 1,
          `${width}px ${state} keeps ${key} stable: ${before[key]} -> ${after[key]}`,
        );
    };
    await page.keyboard.press('Space');
    await stable('one selected');
    await allRows.click();
    await stable('all selected');
    const clear = rows.getByRole('button', { name: 'Clear selection', exact: true });
    await clear.focus();
    await page.keyboard.press('Enter');
    await stable('cleared');
    assert.equal(
      await checkRow(0).evaluate(node => node === document.activeElement),
      true,
      'Clearing returns keyboard focus to the first selected checkbox',
    );
    assert.ok(
      await grid.getByRole('columnheader', { name: 'Actions', exact: true }).evaluate(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect().width > 20;
      }),
      'Actions is visibly labeled after loading',
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  rowsGate = new Promise(resolve => {
    releaseRows = resolve;
  });
  await changeRows();
  await rows.getByText('Refreshing status…', { exact: true }).waitFor();
  assert.equal(await grid.locator('tbody tr').count(), 50, 'Background refresh retains the loaded page');
  assert.equal(
    await grid.locator('[data-loading-row]').count(),
    0,
    'Background refresh does not replace data with skeletons',
  );
  await paging.getByText('1-50 of 137 rows', { exact: true }).waitFor();
  releaseRows();
  rowsGate = null;
  await rows.getByText('Refreshing status…', { exact: true }).waitFor({ state: 'detached' });
  await checkRow(0).click();
  assert.equal(await allRows.getAttribute('aria-checked'), 'mixed');
  await allRows.click();
  assert.equal(
    await grid.locator('tbody [role=checkbox][aria-checked=true]').count(),
    50,
    'Select all is this page only',
  );
  await allRows.click();
  assert.equal(await allRows.getAttribute('aria-checked'), 'false');
  await checkRow(0).click();
  const footerNode = await paging.elementHandle();
  rowsGate = new Promise(resolve => {
    releaseRows = resolve;
  });
  await paging.getByRole('button', { name: 'Next rows', exact: true }).click();
  await loadingRows(50);
  assert.equal(
    await footerNode.evaluate(node => node.isConnected),
    true,
    'Changing pages keeps the same footer mounted',
  );
  await capture('table-rows-page-loading-50');
  releaseRows();
  rowsGate = null;
  await paging.getByText('51-100 of 137 rows', { exact: true }).waitFor();
  assert.equal(await allRows.getAttribute('aria-checked'), 'false', 'Changing pages clears selection');
  const sizeSelect = paging.getByRole('combobox', { name: 'Rows per page', exact: true });
  for (const size of [10, 25, 50, 100]) {
    await checkRow(0).click();
    rowsGate = new Promise(resolve => {
      releaseRows = resolve;
    });
    await choose(sizeSelect, String(size));
    if (size !== 50) {
      await loadingRows(size);
      assert.equal(
        await footerNode.evaluate(node => node.isConnected),
        true,
        'Changing page size keeps the same footer mounted',
      );
      await capture(`table-rows-page-loading-${size}`);
    }
    releaseRows();
    rowsGate = null;
    await paging.getByText(`1-${size} of 137 rows`, { exact: true }).waitFor();
    assert.ok(
      pageReads.some(read => read.limit === size && !read.after),
      'Each size reads its own first page; revisits may use the cache',
    );
    assert.equal(await grid.locator('tbody tr').count(), size);
    assert.equal(await allRows.getAttribute('aria-checked'), 'false');
  }
  assert.deepEqual(await optionsOf(sizeSelect), ['10', '25', '50', '100']);
  const viewport = rows.locator('[data-slot="scroll-area-viewport"]');
  const settleScroll = () =>
    page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 390, height: 844 });
    await viewport.scrollIntoViewIfNeeded();
    await settleScroll();
    const bounds = await viewport.evaluate(node => ({
      width: node.clientWidth,
      contentWidth: node.scrollWidth,
      height: node.clientHeight,
      contentHeight: node.scrollHeight,
      maxHeight: innerHeight * 0.6,
      native: getComputedStyle(node).scrollbarWidth,
      tabIndex: node.tabIndex,
    }));
    assert.ok(bounds.contentWidth > bounds.width, 'Mobile grid scrolls horizontally');
    assert.ok(
      bounds.contentHeight > bounds.height && bounds.height <= bounds.maxHeight,
      'One table viewport bounds vertical scrolling',
    );
    assert.equal(bounds.native, 'none', 'Native bars are replaced by the shared scroll area');
    assert.equal(bounds.tabIndex, 0, 'The scroll viewport is keyboard accessible');
    const bars = rows.locator('[data-slot="scroll-area-scrollbar"]');
    assert.equal(await bars.count(), 2, 'Both axes expose custom scrollbars');
    for (const bar of await bars.all()) assert.equal(await bar.locator('[data-slot="scroll-area-thumb"]').count(), 1);
    for (const end of [false, true]) {
      await viewport.evaluate((node, end) => {
        node.scrollLeft = end ? node.scrollWidth : 0;
        node.scrollTop = 180;
      }, end);
      await settleScroll();
      const sticky = await grid.evaluate(table => {
        const viewport = table.closest('[data-slot="scroll-area-viewport"]'),
          bounds = viewport.getBoundingClientRect();
        const cells = [...table.querySelectorAll('tbody [data-sticky-end]')].filter(cell => {
          const box = cell.getBoundingClientRect();
          return box.top > bounds.top + 45 && box.bottom < bounds.bottom - 12;
        });
        const header = table.querySelector('thead [data-sticky-end]'),
          headerBox = header.getBoundingClientRect();
        const separator = cell => {
          const style = getComputedStyle(cell, '::before');
          return {
            width: style.width,
            height: Number.parseFloat(style.height),
            position: style.position,
            left: style.left,
            content: style.content,
            color: style.backgroundColor,
            edge: getComputedStyle(cell).borderRightColor,
          };
        };
        return {
          header: { left: headerBox.left, right: headerBox.right, top: headerBox.top },
          separators: [header, ...cells].map(separator),
          viewport: { left: bounds.left, right: bounds.right, top: bounds.top },
          cells: cells.map(cell => {
            const box = cell.getBoundingClientRect(),
              button = cell.querySelector('button'),
              action = button.getBoundingClientRect();
            return {
              right: box.right,
              width: box.width,
              position: getComputedStyle(cell).position,
              background: getComputedStyle(cell).backgroundColor,
              reachable: button.contains(
                document.elementFromPoint(action.x + action.width / 2, action.y + action.height / 2),
              ),
            };
          }),
        };
      });
      assert.ok(
        Math.abs(sticky.header.top - sticky.viewport.top) <= 1,
        'Actions header stays at the top during vertical scrolling',
      );
      assert.ok(
        sticky.header.left >= sticky.viewport.left && sticky.header.right <= sticky.viewport.right + 1,
        'Actions header stays visible at both horizontal extremes',
      );
      for (const seam of sticky.separators) {
        assert.equal(seam.width, '1px', 'Sticky actions draw a persistent 1px divider');
        assert.equal(seam.position, 'absolute');
        assert.equal(seam.left, '0px');
        assert.ok(seam.height > 0 && seam.content !== 'none', 'The divider is drawn across the cell height');
        assert.equal(seam.color, seam.edge, 'The divider uses the shared input edge in both themes');
      }
      assert.ok(sticky.cells.length > 0);
      for (const cell of sticky.cells) {
        assert.equal(cell.position, 'sticky');
        assert.ok(Math.abs(cell.right - sticky.viewport.right) <= 1, 'Actions stay at the visible right edge');
        assert.ok(cell.width <= 90, 'Actions stay content-sized on mobile');
        assert.notEqual(cell.background, 'rgba(0, 0, 0, 0)', 'Sticky actions have an opaque background');
        assert.equal(cell.reachable, true, 'Visible actions stay above scrolling cells');
      }
      await capture(`table-rows-sticky-${theme}-${end ? 'end' : 'start'}`);
    }
    if (theme === 'light') {
      await viewport.evaluate(node => {
        node.scrollTop = 0;
        node.scrollLeft = 0;
      });
      await viewport.focus();
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction(
        () => document.querySelector('[data-slot="table-container"] [data-slot="scroll-area-viewport"]').scrollTop > 0,
      );
      const thumb = rows.locator(
        '[data-slot="scroll-area-scrollbar"][data-orientation="horizontal"] [data-slot="scroll-area-thumb"]',
      );
      const box = await thumb.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      assert.ok(await viewport.evaluate(node => node.scrollLeft > 0), 'The custom horizontal thumb is draggable');
    }
    await page.evaluate(() => document.activeElement?.blur());
    await settleScroll();
    const flat = await rows
      .locator(
        '[data-slot="select-trigger"], [data-slot="button"].border-input, [data-slot="button"][data-variant="outline"]',
      )
      .evaluateAll(nodes =>
        nodes.map(node => ({
          border: getComputedStyle(node).borderTopColor,
          shadow: getComputedStyle(node).boxShadow,
        })),
      );
    assert.ok(flat.length > 3);
    for (const control of flat) {
      assert.equal(control.border, flat[0].border, 'Table controls share one edge');
      assert.equal(control.shadow, 'none', 'Table controls have no idle shadow');
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await viewport.evaluate(node => {
    node.scrollLeft = 0;
    node.scrollTop = 0;
  });
  await paging.getByRole('button', { name: 'Next rows', exact: true }).click();
  await paging.getByText('101-137 of 137 rows', { exact: true }).waitFor();
  assert.equal(await paging.getByRole('button', { name: 'Next rows', exact: true }).isDisabled(), true);
  await paging.getByRole('button', { name: 'First rows', exact: true }).click();
  await paging.getByText('1-100 of 137 rows', { exact: true }).waitFor();
  await checkRow(0).click();
  await checkRow(1).click();
  const exportTop = await grid.evaluate(node => node.getBoundingClientRect().top);
  const download = page.waitForEvent('download');
  await rows.getByRole('button', { name: 'Export selected', exact: true }).click();
  const stream = await (await download).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString('utf8');
  assert.ok(csv.includes(`"'=HYPERLINK(""unsafe"")"`), 'Selected export uses formula-safe CSV');
  assert.ok(csv.includes('Ticket 2'));
  assert.equal(csv.includes('Ticket 3'), false, 'Selected export excludes unchecked rows');
  await rows.getByRole('button', { name: 'Exported', exact: true }).waitFor();
  assert.ok(
    Math.abs((await grid.evaluate(node => node.getBoundingClientRect().top)) - exportTop) <= 1,
    'Export completion does not insert a message above the table',
  );
  await rows.getByRole('button', { name: 'Delete selected', exact: true }).click();
  const beforeCancel = writes.length;
  await dialog.getByRole('button', { name: 'Keep rows', exact: true }).click();
  assert.equal(writes.length, beforeCancel, 'Cancel does not delete');
  await rows.getByRole('button', { name: 'Delete selected', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete 2 rows', exact: true }).click();
  await dialog.getByText('2 of 2 rows deleted.', { exact: true }).waitFor();
  assert.equal(records.has(bulkIds[0]), false);
  assert.equal(records.has(bulkIds[1]), false);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await paging.getByText('1-100 of 135 rows', { exact: true }).waitFor();
  await checkRow(0).click();
  await checkRow(1).click();
  await checkRow(2).click();
  linkedIds.add(bulkIds[3]);
  await rows.getByRole('button', { name: 'Delete selected', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete 3 rows', exact: true }).click();
  await dialog.getByText('Deletion stopped. No further rows will be deleted.', { exact: true }).waitFor();
  await dialog.getByText('1 of 3 rows deleted.', { exact: true }).waitFor();
  assert.equal(records.has(bulkIds[2]), false);
  assert.equal(records.has(bulkIds[3]), true);
  assert.equal(records.has(bulkIds[4]), true, 'Rows after a blocked delete remain untouched');
  await dialog.getByRole('button', { name: 'Close and review rows', exact: true }).click();
  linkedIds.clear();
  await paging.getByText('1-100 of 134 rows', { exact: true }).waitFor();
  await checkRow(0).click();
  await checkRow(1).click();
  dropBeforeWrite = true;
  await rows.getByRole('button', { name: 'Delete selected', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete 2 rows', exact: true }).click();
  await dialog.getByRole('button', { name: 'Check row request', exact: true }).waitFor();
  const uncertainDelete = structuredClone(writes.at(-1));
  const beforeRetry = writes.length;
  assert.equal(records.has(bulkIds[4]), true, 'An uncertain result stops the queue');
  await dialog.getByRole('button', { name: 'Check row request', exact: true }).click();
  await dialog.getByRole('button', { name: 'Retry same row request', exact: true }).click();
  await dialog.getByText('2 of 2 rows deleted.', { exact: true }).waitFor();
  assert.deepEqual(writes[beforeRetry], uncertainDelete, 'Bulk retries preserve exact input and request ID');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await paging.getByText('1-100 of 132 rows', { exact: true }).waitFor();
  await checkRow(0).click();
  await checkRow(1).click();
  dropWrite = true;
  await rows.getByRole('button', { name: 'Delete selected', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete 2 rows', exact: true }).click();
  await dialog.getByRole('button', { name: 'Check row request', exact: true }).click();
  await dialog.getByText('2 of 2 rows deleted.', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await paging.getByText('1-100 of 130 rows', { exact: true }).waitFor();
  await checkRow(0).click();
  permissions.delete = false;
  await changeRows(true);
  await rows.getByRole('button', { name: 'Delete selected', exact: true }).waitFor({ state: 'detached' });
  assert.equal(
    await rows.getByRole('button', { name: 'Export selected', exact: true }).isEnabled(),
    true,
    'Read-only selection still supports export',
  );

  assert.deepEqual(errors, []);
  console.log(
    'Table row HTTP-stub proof passed. Drafts survive applied label revisions in create, edit, direct-row, and uncertain states. Changed fields need explicit review; removed input stays until confirmed, new limits revalidate, old results do not cross revisions, denied reads conceal, write revocation blocks, original row tokens and exact uncertain retries survive. Search, sort, filters, paging, delete/restore, and error recovery remain covered. Widths 320/375-dark/768/1440. Not end-to-end backend proof.',
  );
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) {
    if (process.env.TABLE_ROWS_SCREENSHOTS)
      await failedPage.screenshot({ path: `${process.env.TABLE_ROWS_SCREENSHOTS}/table-experience-failure.png` });
    console.error('Last table request:', JSON.stringify(pageReads.at(-1)));
    console.error('Visible table state:', (await failedPage.locator('main').innerText()).slice(-3000));
  }
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
