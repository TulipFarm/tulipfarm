import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { z } from 'zod';
import { preview as serveBuild } from 'vite';
import { fileURLToPath } from 'node:url';
import { mutationSchema } from '@tulipfarm/tables/service';
import { normalizeQueryRequest } from '@tulipfarm/tables/query';
import {
  proposalDecisionSchema,
  proposalControlSchema,
  proposalViewSchema,
} from '@tulipfarm/tables/proposal-contracts';
import { governanceSnapshotSchema } from '@tulipfarm/workspaces/governance-contracts';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = Number(process.env.TABLE_UI_PORT ?? 5398);
const origin = `http://127.0.0.1:${port}`;
const server = process.env.TABLE_UI_PRODUCTION
  ? await serveBuild({
      root: fileURLToPath(new URL('..', import.meta.url)),
      preview: { host: '127.0.0.1', port, strictPort: true },
    })
  : spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
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
  chatId = randomUUID(),
  proposalId = randomUUID(),
  turnId = randomUUID(),
  tableId = randomUUID();
const fieldId = randomUUID(),
  selectId = randomUUID(),
  optionId = randomUUID(),
  recordId = randomUUID();
const fileFieldId = randomUUID(),
  fileId = randomUUID(),
  forbiddenFileId = randomUUID(),
  hiddenFileId = randomUUID(),
  globexId = randomUUID(),
  missingCustomerId = randomUUID();
const linkId = randomUUID(),
  customerId = randomUUID(),
  customerRecordId = randomUUID(),
  customerNameId = randomUUID(),
  tagsId = randomUUID(),
  timestampId = randomUUID();
const amountId = randomUUID(),
  dueId = randomUUID(),
  resolvedId = randomUUID();
const definition = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: teamId,
  label: 'Support tickets',
  fields: [
    { id: fieldId, label: 'Subject', kind: 'text', required: true, maxLength: 1000 },
    {
      id: selectId,
      label: 'Status',
      kind: 'single-select',
      required: true,
      options: [{ id: optionId, label: 'Open', retired: false }],
    },
    { id: amountId, label: 'Amount', kind: 'numeric', required: false, precision: 30, scale: 10 },
    { id: dueId, label: 'Due date', kind: 'date', required: false },
    { id: resolvedId, label: 'Resolved', kind: 'boolean', required: false },
    {
      id: tagsId,
      label: 'Tags',
      kind: 'multi-select',
      required: false,
      options: [{ id: optionId, label: 'Urgent', retired: false }],
    },
    { id: timestampId, label: 'Reported at', kind: 'timestamp', required: false, timezone: 'UTC' },
    {
      id: linkId,
      label: 'Customer',
      kind: 'relationship',
      required: false,
      targetTableId: customerId,
      cardinality: 'one',
      inverseCardinality: 'many',
      reverse: { fieldId: randomUUID(), label: 'Tickets' },
      onDelete: 'restrict',
    },
    { id: fileFieldId, label: 'Evidence', kind: 'file', required: false, cardinality: 'one', access: 'independent' },
  ],
  uniqueKeys: [],
};
const customerDefinition = {
  formatVersion: 2,
  id: customerId,
  owningTeamId: teamId,
  label: 'Customers',
  fields: [{ id: customerNameId, label: 'Name', kind: 'text', required: true, maxLength: 120 }],
  uniqueKeys: [],
};
const record = {
  id: recordId,
  token: randomUUID(),
  values: { [fieldId]: { kind: 'text', value: 'Original subject' }, [selectId]: { kind: 'single-select', optionId } },
};
const digest = 'd'.repeat(64);
const view = {
  content: 'available',
  id: proposalId,
  digest,
  status: 'pending',
  decision: null,
  cancelled: false,
  expired: false,
  freshness: 'current',
  plans: [{ tableId, receipt: null, importProgress: null }],
  manifest: {
    version: 1,
    id: proposalId,
    workspaceId: workspace.id,
    requester: { kind: 'human', userId: 'ada', membershipId: memberId },
    conversationId: chatId,
    turnId,
    sources: [],
    expiresAt: '2099-10-02T12:00:00Z',
    plans: [
      {
        input: {
          kind: 'schema',
          tableId,
          dependsOn: [],
          expectedRevision: 'a'.repeat(40),
          target: definition,
          transforms: { outputs: [{ fieldId, expression: { op: 'trim', input: { op: 'field', fieldId } } }] },
        },
        before: definition,
        after: definition,
        effectCount: 21,
        effectsDigest: 'e'.repeat(64),
        freshnessDigest: 'f'.repeat(64),
        audience: null,
        importSources: [],
      },
    ],
  },
};
const listSearches = [],
  writes = [],
  effectRequests = [],
  recordWrites = [],
  grantWrites = [],
  tableReads = [],
  customerReads = [],
  fileReads = [],
  uploads = [];
const fileSummary = (id, name, mediaType) => ({
  id,
  kind: 'file',
  name,
  parentId: null,
  creatorMembershipId: memberId,
  mediaType,
  size: 2048,
  trashed: false,
  role: 'manager',
  deletion: null,
});
const files = new Map([
  [fileId, fileSummary(fileId, 'contract.pdf', 'application/pdf')],
  [forbiddenFileId, fileSummary(forbiddenFileId, 'revoked.pdf', 'application/pdf')],
]);
const customers = [
  { id: customerRecordId, token: randomUUID(), values: { [customerNameId]: { kind: 'text', value: 'Acme customer' } } },
  { id: globexId, token: randomUUID(), values: { [customerNameId]: { kind: 'text', value: 'Globex' } } },
  { id: randomUUID(), token: randomUUID(), values: { [customerNameId]: { kind: 'text', value: 'Globex' } } },
];
let uploadStatus = 200,
  suggestionStatus = 200,
  linkedStatus = 200,
  summaryStatus = 200;
const summaryRequests = [],
  singleFileReads = [];
const receipts = new Map();
const historyId = randomUUID();
const history = [
  {
    id: historyId,
    token: randomUUID(),
    actor: { kind: 'human', userId: 'ada', membershipId: memberId },
    operation: 'update',
    field_ids: [fieldId],
    outcome: 'applied',
    created_at: '2026-10-02T12:00:00.000Z',
    recoverable_until: '2099-10-02T12:00:00.000Z',
    before_values: {
      [fieldId]: { kind: 'text', value: 'Historical subject' },
      [selectId]: { kind: 'single-select', optionId },
    },
    values: record.values,
  },
];
const executionId = randomUUID();
const schemaEntry = {
  id: executionId,
  revision: 'a'.repeat(40),
  phase: 'completed',
  createdAt: workspace.createdAt,
  savedAt: workspace.createdAt,
  appliedAt: workspace.createdAt,
  definition,
  receipt: { status: 'completed', executionId, revision: 'a'.repeat(40) },
};
let savedDefinition = schemaEntry,
  activeDefinition = { revision: 'a'.repeat(40), definition, appliedAt: workspace.createdAt };
let deleted = false,
  deletedStatus = 200,
  schemaStatus = 200,
  restoreError = null,
  detailStatus = 200;
let schemaSecondPage = false,
  deletedSecondPage = false;
const schemaCursors = [],
  deletedCursors = [];
let historyStatus = 200,
  emptyHistory = false,
  receiptStatus = 200,
  unknownReceipt = false;
let readStatus = 503,
  liveTurn = false,
  dropDecision = true,
  recordConflict = false,
  grants = [];
let listStatus = 200,
  emptyList = false,
  emptyRecords = false,
  recordStatus = 200,
  dropRecord = false,
  listDelay = 0;
let grantStatus = 200,
  grantWriteStatus = 200,
  effectsStatus = 200;
const governance = {
  actorMembershipId: memberId,
  members: [{ id: memberId, userId: 'ada', role: 'admin', name: 'Ada', email: 'ada@example.com' }],
  teams: [
    {
      id: teamId,
      name: 'Support',
      description: '',
      membershipIds: [memberId],
      managerIds: [memberId],
      canManage: true,
      canLeave: false,
    },
  ],
  directory: [{ id: memberId, name: 'Ada', email: 'ada@example.com', image: null }],
  tableTeamIds: [teamId],
  tables: [{ id: tableId, name: definition.label, owningTeamId: teamId }],
  grants: [],
};
let browser;
let page;
let agentAttached = false;
try {
  proposalViewSchema.parse(view);
  governanceSnapshotSchema.parse(governance);
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
  const cdp = process.env.TABLE_EDITOR_CDP_PORT;
  browser = await chromium.launch({ headless: true, args: cdp ? [`--remote-debugging-port=${cdp}`] : [] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', timezoneId: 'UTC' });
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const captureEditor = async name => {
    if (!process.env.TABLE_EDITOR_SCREENSHOTS) return;
    assert.ok(cdp, 'Editor screenshots use agent-browser over CDP');
    await mkdir(process.env.TABLE_EDITOR_SCREENSHOTS, { recursive: true });
    agentAttached = true;
    await promisify(execFile)('agent-browser', [
      '--session',
      'table-editor',
      '--no-auto-dialog',
      '--cdp',
      cdp,
      'screenshot',
      `${process.env.TABLE_EDITOR_SCREENSHOTS}/${name}.png`,
    ]);
  };
  const tableChange = async (keys = [['tables']]) => {
    await page.evaluate(
      ({ keys, workspaceId, membershipId }) => {
        const channel = new BroadcastChannel('tulipfarm:query:v1');
        channel.postMessage({
          version: 1,
          id: crypto.randomUUID(),
          sessionId: 'session-ada',
          scope: { kind: 'workspace', userId: 'ada', workspaceId, membershipId },
          kind: 'change',
          keys,
        });
        channel.close();
      },
      { keys, workspaceId: workspace.id, membershipId: memberId },
    );
  };
  await page.route('**/v1/**', async route => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (
      (request.method() === 'GET' && (path.includes('/tables') || path.includes('/table-changes/'))) ||
      (request.method() === 'POST' && path.endsWith('/query'))
    )
      tableReads.push(path + url.search);
    if (request.method() === 'GET' && /\/files\/[0-9a-f-]{36}$/.test(path)) singleFileReads.push(path);
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
    else if (path.endsWith('/files/suggestions')) {
      if (suggestionStatus !== 200)
        return route.fulfill({ status: suggestionStatus, json: { error: 'file-unavailable' } });
      const query = url.searchParams.get('query').toLowerCase();
      json = { items: [...files.values()].filter(file => file.name.toLowerCase().includes(query)), next: null };
    } else if (path.endsWith('/content') && request.method() === 'PUT') {
      const id = path.split('/').at(-2);
      uploads.push({
        id,
        name: url.searchParams.get('name'),
        parentId: url.searchParams.get('parentId'),
        session: request.headers()['x-tulipfarm-expected-session'],
      });
      if (uploadStatus !== 200) return route.fulfill({ status: uploadStatus, json: { error: 'file-too-large' } });
      files.set(id, fileSummary(id, url.searchParams.get('name'), url.searchParams.get('mediaType')));
      json = files.get(id);
    } else if (path.endsWith('/files/summaries')) {
      const ids = url.searchParams.get('ids').split(',');
      summaryRequests.push(ids);
      fileReads.push(...ids);
      if (summaryStatus !== 200) return route.fulfill({ status: summaryStatus, json: { error: 'file-unavailable' } });
      json = { items: ids.flatMap(id => (files.has(id) ? [files.get(id)] : [])) };
    } else if (path.endsWith('/governance/me'))
      json = { membershipId: memberId, role: 'admin', teams, capabilities: { manageGovernance: true, canLeave: true } };
    else if (path.endsWith('/governance/person-grants')) {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        grantWrites.push(body);
        if (grantWriteStatus !== 200)
          return route.fulfill({ status: grantWriteStatus, json: { error: 'invalid-grant' } });
        grants = body.granted ? [{ membershipId: body.membershipId, target: body.target }] : [];
        json = { ok: true };
      } else {
        if (grantStatus !== 200)
          return route.fulfill({ status: grantStatus, json: { error: 'person-grants-unavailable' } });
        json = { grants };
      }
    } else if (path.endsWith('/governance')) json = governance;
    else if (path.includes('/table-changes/')) {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        writes.push({ path, body });
        if ('decision' in body) {
          assert.ok(path.endsWith('/decision'));
          proposalDecisionSchema.parse(body);
        } else {
          assert.ok(path.endsWith('/control'));
          proposalControlSchema.parse(body);
        }
        await delay(150);
        if ('decision' in body) {
          view.decision = body.decision;
          view.status = body.decision === 'approve' ? 'approved' : 'rejected';
        } else {
          view.cancelled = body.operation === 'cancel';
          view.status = view.cancelled ? 'cancelled' : 'approved';
        }
        if (dropDecision) {
          dropDecision = false;
          return route.abort('failed');
        }
        json = view;
      } else if (path.endsWith('/outcome')) json = { kind: 'proposal' };
      else if (readStatus !== 200)
        return route.fulfill({ status: readStatus, json: { error: 'proposal-unavailable' } });
      else if (path.endsWith('/effects')) {
        if (effectsStatus !== 200)
          return route.fulfill({ status: effectsStatus, json: { error: 'proposal-unavailable' } });
        const after = Number(url.searchParams.get('after'));
        effectRequests.push(after);
        json = {
          digest,
          total: 21,
          items: [
            {
              ordinal: after === -1 ? 0 : 20,
              effect: {
                recordId,
                kind: 'update',
                before: { [fieldId]: { kind: 'text', value: after === -1 ? '  First subject  ' : '  Last subject  ' } },
                after: { [fieldId]: { kind: 'text', value: after === -1 ? 'First subject' : 'Last subject' } },
              },
            },
          ],
          nextCursor: after === -1 ? 19 : null,
        };
      } else json = view;
    } else if (path.endsWith('/tables')) {
      assert.equal(request.method(), 'GET');
      await delay(listDelay);
      if (listStatus !== 200) return route.fulfill({ status: listStatus, json: { error: 'proposal-unavailable' } });
      const search = url.searchParams.get('search')?.toLowerCase();
      if (search) listSearches.push(search);
      json = {
        tables: emptyList
          ? []
          : [
              { id: tableId, revision: 'a'.repeat(40), definition, appliedAt: null, recordCount: '3' },
              {
                id: customerId,
                revision: 'c'.repeat(40),
                definition: customerDefinition,
                appliedAt: null,
                recordCount: '12',
              },
            ].filter(table => !search || table.definition.label.toLowerCase().includes(search)),
        nextCursor: null,
      };
    } else if (path.endsWith(`/tables/${tableId}`)) {
      if (detailStatus !== 200) return route.fulfill({ status: detailStatus, json: { error: 'proposal-unavailable' } });
      json = {
        id: tableId,
        saved: savedDefinition,
        applied: activeDefinition,
        rowPermissions: { create: true, update: true, delete: true },
      };
    } else if (path.endsWith(`/tables/${customerId}`))
      json = {
        id: customerId,
        saved: null,
        applied: { revision: 'c'.repeat(40), definition: customerDefinition, appliedAt: null },
        rowPermissions: { create: false, update: false, delete: false },
      };
    else if (path.endsWith(`/tables/${tableId}/schema-history`)) {
      if (schemaStatus !== 200) return route.fulfill({ status: schemaStatus, json: { error: 'proposal-unavailable' } });
      const after = url.searchParams.get('after');
      schemaCursors.push(after);
      json = { entries: after ? [] : [savedDefinition], nextCursor: schemaSecondPage && !after ? executionId : null };
    } else if (path.endsWith(`/tables/${tableId}/deleted-rows`)) {
      if (deletedStatus !== 200)
        return route.fulfill({ status: deletedStatus, json: { error: 'proposal-unavailable' } });
      const after = url.searchParams.get('after');
      deletedCursors.push(after);
      json = {
        records:
          deleted && !after
            ? [
                {
                  id: record.id,
                  token: record.token,
                  deletedAt: workspace.createdAt,
                  recoverableUntil: history[0].recoverable_until,
                },
              ]
            : [],
        nextCursor: deletedSecondPage && !after ? record.id : null,
      };
    } else if (path.endsWith(`/tables/${customerId}/rows/${customerRecordId}/history`)) json = [];
    else if (path.endsWith(`/tables/${tableId}/rows/${recordId}/history`)) {
      assert.equal(request.method(), 'GET');
      if (historyStatus !== 200)
        return route.fulfill({ status: historyStatus, json: { error: 'proposal-unavailable' } });
      json = emptyHistory ? [] : history;
    } else if (path.includes(`/tables/${tableId}/requests/`)) {
      assert.equal(request.method(), 'GET');
      if (receiptStatus !== 200)
        return route.fulfill({ status: receiptStatus, json: { error: 'proposal-unavailable' } });
      const result = receipts.get(path.split('/').at(-1));
      json = result && !unknownReceipt ? { status: 'applied', result } : { status: 'unknown' };
    } else if (path.endsWith(`/tables/${customerId}/rows`)) {
      customerReads.push(url.searchParams);
      if (linkedStatus !== 200) return route.fulfill({ status: linkedStatus, json: { error: 'proposal-unavailable' } });
      const ids = url.searchParams.get('ids').split(',');
      json = customers.filter(row => ids.includes(row.id));
    } else if (path.endsWith(`/tables/${customerId}/rows/page`)) {
      customerReads.push(url.searchParams);
      const search = url.searchParams.get('search')?.toLowerCase(),
        matching = customers.filter(row => !search || row.values[customerNameId].value.toLowerCase().includes(search));
      json = { records: matching, total: String(matching.length), nextCursor: null };
    } else if (path.endsWith(`/tables/${tableId}/rows`)) {
      if (request.method() === 'POST') {
        const { requestId, ...input } = request.postDataJSON();
        z.uuid().parse(requestId);
        const body = mutationSchema.parse(input);
        recordWrites.push({ requestId, ...body });
        assert.equal(body.tableId, tableId);
        const prior = receipts.get(requestId);
        if (prior) return route.fulfill({ json: prior });
        if (recordConflict) return route.fulfill({ status: 409, json: { error: 'stale-record' } });
        if (body.kind === 'restore' && restoreError)
          return route.fulfill({
            status: restoreError === 'proposal-unavailable' ? 404 : 409,
            json: { error: restoreError },
          });
        if (body.kind === 'update' && body.values[fileFieldId]?.fileIds.includes(forbiddenFileId))
          return route.fulfill({ status: 404, json: { error: 'proposal-unavailable' } });
        assert.equal(body.expectedToken, record.token);
        await delay(150);
        if (body.kind === 'restore') {
          assert.equal(body.historyId, historyId);
          record.values = body.version === 'before' ? history[0].before_values : history[0].values;
          deleted = false;
        } else {
          assert.equal(body.kind, 'update');
          record.values = { ...record.values, ...body.values };
        }
        record.token = randomUUID();
        json = { kind: 'available', ...record };
        receipts.set(requestId, structuredClone(json));
        if (dropRecord) {
          dropRecord = false;
          return route.abort('failed');
        }
      } else return route.fulfill({ status: 405, json: { error: 'invalid-request' } });
    } else if (request.method() === 'POST' && path.endsWith(`/tables/${tableId}/query`)) {
      const body = request.postDataJSON();
      assert.equal(body.revision, 'a'.repeat(40));
      if (recordStatus !== 200) return route.fulfill({ status: recordStatus, json: { error: 'proposal-unavailable' } });
      const rows = emptyRecords || deleted ? [] : [record];
      json = {
        mode: 'rows',
        ...normalizeQueryRequest(definition, body.request),
        references: {},
        records: rows,
        total: String(rows.length),
        nextCursor: null,
      };
    } else if (request.method() === 'POST' && path.endsWith(`/tables/${customerId}/query`)) {
      const body = request.postDataJSON();
      json = {
        mode: 'rows',
        ...normalizeQueryRequest(customerDefinition, body.request),
        references: {},
        records: customers,
        total: String(customers.length),
        nextCursor: null,
      };
    } else if (path.endsWith(`/tables/${tableId}/rows/page`)) {
      assert.equal(url.searchParams.get('revision'), 'a'.repeat(40));
      if (recordStatus !== 200) return route.fulfill({ status: recordStatus, json: { error: 'proposal-unavailable' } });
      const rows = emptyRecords || deleted ? [] : [record];
      json = { records: rows, total: String(rows.length), nextCursor: null };
    } else if (path.endsWith(`/conversations/${chatId}/messages`))
      json = {
        messages: [
          {
            id: randomUUID(),
            sequence: 1,
            author: 'assistant',
            createdAt: workspace.createdAt,
            parts: [{ kind: 'text', text: 'Review the proposed ticket changes below.' }],
            turn: { id: turnId, status: liveTurn ? 'processing' : 'completed', generation: 0 },
            tools: [
              {
                id: proposalId,
                tool: 'tables.propose',
                status: 'completed',
                ...(liveTurn ? { activityStatus: 'waiting' } : {}),
              },
            ],
          },
        ],
        nextBefore: null,
      };
    else if (path.endsWith(`/conversations/${chatId}`))
      json = {
        id: chatId,
        title: 'Build support tickets',
        titleRevision: 1,
        archived: false,
        activityAt: workspace.createdAt,
        createdAt: workspace.createdAt,
      };
    else return route.fulfill({ status: 404, json: { error: 'unavailable' } });
    return route.fulfill({ json });
  });
  await page.goto(`${origin}/acme/chat/${chatId}`);
  const card = page.getByRole('region', { name: 'Table change proposal' });
  await card.getByText('Could not load tables', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: /^Approve/ }).count(), 0);
  await card.getByRole('button', { name: 'Try again', exact: true }).click();
  await card.getByText('Could not load tables', { exact: true }).waitFor({ state: 'detached' });
  await card.getByText('Could not load tables', { exact: true }).waitFor();
  readStatus = 200;
  effectsStatus = 503;
  await card.getByRole('button', { name: 'Try again', exact: true }).click();
  await card.getByRole('button', { name: /^Approve/ }).waitFor();
  assert.equal(await card.getByRole('button', { name: /^Approve/ }).isDisabled(), true);
  await card.getByRole('button', { name: 'Approval details', exact: true }).click();
  await card.getByRole('button', { name: /^Row effects/ }).click();
  await card.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  effectsStatus = 200;
  await card.getByRole('button', { name: 'Try again', exact: true }).click();
  await card.getByText('First subject', { exact: true }).last().waitFor();
  await card.getByRole('button', { name: 'Next effects' }).click();
  await card.getByText('Last subject', { exact: true }).last().waitFor();
  assert.deepEqual(effectRequests.slice(0, 2), [-1, 19]);
  await card.getByRole('button', { name: 'Previous effects' }).click();
  await card.getByText('First subject', { exact: true }).last().waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Close canvas' }).count(),
    0,
    'A proposal in loaded history leaves the canvas closed',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await card.getByRole('button', { name: 'Open schema' }).click();
  const schema = page.getByRole('figure', { name: 'Schema diagram for Change Support tickets table' });
  // Sprout's schema diagram names each table node as a group (@tulipfarm/sprout/schema-diagram), not a region.
  await schema.getByRole('group', { name: 'Support tickets table' }).waitFor();
  await schema.getByRole('group', { name: 'Customers table' }).getByText('Existing', { exact: true }).waitFor();
  assert.equal(await schema.locator('.react-flow__edge').count(), 1, 'The relationship draws one link');
  assert.equal(await schema.getByText(tableId).count(), 0, 'The diagram hides identifiers');
  if (process.env.TABLE_UI_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.TABLE_UI_SCREENSHOTS}/table-review-schema.png` });
  await page.getByRole('button', { name: 'Close canvas' }).click();
  liveTurn = true;
  await page.reload();
  // A live proposal stays in chat; the schema opens only on request (cloud 856d6a73 #1026, apps/web/DESIGN.md:536).
  await card.getByRole('button', { name: 'Open schema' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Close canvas' }).count(),
    0,
    'Live work leaves the canvas closed',
  );
  await card.getByRole('button', { name: 'Open schema' }).click();
  await page.getByRole('figure', { name: 'Schema diagram for Change Support tickets table' }).waitFor();
  if (process.env.TABLE_UI_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.TABLE_UI_SCREENSHOTS}/table-review-live-canvas.png` });
  if (process.env.TABLE_UI_SCREENSHOTS)
    await page
      .getByRole('list', { name: 'Tool activity' })
      .screenshot({ path: `${process.env.TABLE_UI_SCREENSHOTS}/table-review-waiting-tool.png` });
  await page.getByRole('button', { name: 'Close canvas' }).click();
  liveTurn = false;
  await page.reload();
  await card.getByRole('button', { name: /^Approve/ }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'No document overflow',
    );
    await page.getByRole('region', { name: 'Conversation', exact: true }).evaluate(node => {
      node.scrollTop = 0;
    });
    if (process.env.TABLE_UI_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.TABLE_UI_SCREENSHOTS}/table-review-mobile-${theme}.png`,
        fullPage: true,
      });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('region', { name: 'Conversation', exact: true }).evaluate(node => {
    node.scrollTop = 0;
  });
  if (process.env.TABLE_UI_SCREENSHOTS)
    await page.screenshot({ path: `${process.env.TABLE_UI_SCREENSHOTS}/table-review-desktop.png`, fullPage: true });
  await card.getByRole('button', { name: /^Approve/ }).focus();
  assert.equal(
    await card.getByRole('button', { name: /^Approve/ }).evaluate(node => document.activeElement === node),
    true,
  );
  await card.getByRole('button', { name: /^Approve/ }).dblclick();
  await card.getByRole('button', { name: 'Retry same operation' }).waitFor();
  await card.getByRole('heading', { name: 'Outcome not confirmed', exact: true }).waitFor();
  assert.equal(
    await card.getByText(/Nothing has been applied yet/).count(),
    0,
    'An unknown write outcome never claims nothing changed',
  );
  assert.equal(writes.length, 1, 'Double click sends one command');
  await card.getByRole('button', { name: 'Retry same operation' }).click();
  await card.getByRole('heading', { name: 'Approval recorded', exact: true }).waitFor();
  assert.deepEqual(writes[1], writes[0], 'Unknown outcome retry retains command ID and digest');
  const recorded = card.getByText('0 of 1 table changes completed · Waiting for execution.', { exact: true });
  await recorded.waitFor();
  if (process.env.TABLE_UI_SCREENSHOTS) {
    await recorded.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.TABLE_UI_SCREENSHOTS}/table-review-recorded.png` });
  }
  await card.getByRole('button', { name: 'Cancel unfinished work' }).click();
  await card.getByText('Cancelled at a safe checkpoint', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Resume unfinished work' }).click();
  await card.getByRole('heading', { name: 'Approval recorded', exact: true }).waitFor();
  view.status = 'completed';
  view.plans[0].receipt = { status: 'completed', executionId: randomUUID(), revision: 'b'.repeat(40) };
  await card.getByRole('button', { name: 'Check proposal status' }).click();
  await card.getByText('1 of 1 table changes completed.', { exact: true }).waitFor();
  assert.equal(
    await card.getByRole('button', { name: /^Approve/ }).count(),
    0,
    'A completed review no longer offers approval',
  );
  view.status = 'pending';
  view.decision = null;
  view.plans[0].receipt = null;
  view.freshness = 'stale';
  await card.getByRole('button', { name: 'Check proposal status' }).click();
  await card.getByText(/Affected data or permissions changed/).waitFor();
  assert.equal(await card.getByRole('button', { name: /^Approve/ }).isDisabled(), true);
  view.freshness = 'current';
  view.expired = true;
  await card.getByRole('button', { name: 'Check proposal status' }).click();
  await card.getByText(/This review expired/).waitFor();
  view.expired = false;
  view.manifest.requester.userId = 'other';
  await card.getByRole('button', { name: 'Check proposal status' }).click();
  await card.getByText(/Only the person who requested/).waitFor();
  assert.equal(await card.getByRole('button', { name: /^Approve/ }).count(), 0);
  view.manifest.requester.userId = 'ada';
  await card.getByRole('button', { name: 'Check proposal status' }).click();
  await card.getByRole('button', { name: 'Reject proposal' }).click();
  await card.getByText('Rejected', { exact: true }).waitFor();
  assert.equal(writes.at(-1).body.decision, 'reject');
  const schemaPlan = view.manifest.plans[0];
  view.manifest.plans[0] = {
    ...schemaPlan,
    input: {
      kind: 'import',
      tableId,
      dependsOn: [],
      expectedRevision: 'a'.repeat(40),
      reference: { kind: 'integration', resultId: randomUUID(), contentDigest: 'c'.repeat(64) },
      matchFieldIds: [fieldId],
      mappings: [{ sourceColumn: 'subject', fieldId }],
    },
    audience: { policy: 'table-permissions', administrators: true, teams: [teamId], members: [memberId] },
  };
  view.status = 'failed';
  view.decision = 'approve';
  view.plans[0] = {
    tableId,
    receipt: { status: 'failed', executionId: randomUUID(), code: 'access-denied' },
    importProgress: { applied: 8, remaining: 13 },
  };
  proposalViewSchema.parse(view);
  await card.getByRole('button', { name: 'Check proposal status' }).click();
  await card
    .getByText('Failed. Reference access-denied. 8 of 21 rows imported. 13 not yet imported.', { exact: true })
    .waitFor();
  await card.getByRole('button', { name: 'Approval details', exact: true }).click();
  await card.getByText(/Imports apply in batches, and imported rows stay applied if later work stops/).waitFor();
  assert.equal(await card.getByText(/atomically/).count(), 0, 'An import makes no atomicity claim');
  await card.getByRole('button', { name: 'Resume unfinished work' }).waitFor();
  view.status = 'approved';
  view.plans[0] = { tableId, receipt: null, importProgress: { applied: 13, remaining: 8 } };
  await card.getByRole('button', { name: 'Check proposal status' }).click();
  await card.getByText('13 of 21 rows imported. 8 not yet imported.', { exact: true }).waitFor();
  view.manifest.plans[0] = schemaPlan;
  view.status = 'rejected';
  view.decision = 'reject';
  view.plans[0] = { tableId, receipt: null, importProgress: null };
  await card.getByRole('button', { name: 'Check proposal status' }).click();
  await card.getByText(/Schema and row changes apply atomically for each table/).waitFor();
  const originalManifest = view.manifest;
  view.content = 'redacted';
  view.freshness = 'expired';
  view.expired = true;
  view.manifest = {
    version: 1,
    id: proposalId,
    workspaceId: workspace.id,
    requester: originalManifest.requester,
    conversationId: chatId,
    turnId,
    createdAt: workspace.createdAt,
    expiresAt: originalManifest.expiresAt,
    redactedAt: new Date().toISOString(),
    originalDigest: digest,
    originalInputDigest: 'a'.repeat(64),
    plans: [
      {
        input: { tableId, kind: 'import' },
        fieldIds: [fieldId],
        effectCount: 21,
        effectsDigest: 'e'.repeat(64),
        freshnessDigest: 'f'.repeat(64),
      },
    ],
  };
  view.plans[0] = {
    tableId,
    receipt: { status: 'failed', executionId: randomUUID(), code: 'proposal-cancelled' },
    importProgress: { applied: 8, remaining: 13 },
  };
  proposalViewSchema.parse(view);
  const effectCountBeforeRedaction = effectRequests.length,
    writesBeforeRedaction = writes.length;
  await card.getByRole('button', { name: 'Check proposal status' }).click();
  await card.getByText(/History values expired/).waitFor();
  await card.getByText(`Table 1: failed. 8 of 21 rows imported. 13 not yet imported.`, { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: /Approve|Resume|Reject|Cancel/ }).count(), 0);
  assert.equal(await card.getByText('First subject', { exact: true }).count(), 0);
  assert.equal(await card.getByText(digest, { exact: true }).count(), 1);
  await page.reload();
  await card.getByText(/History values expired/).waitFor();
  assert.equal(effectRequests.length, effectCountBeforeRedaction);
  assert.equal(writes.length, writesBeforeRedaction);
  readStatus = 503;
  await card.getByRole('button', { name: 'Check proposal status' }).click();
  await card.getByRole('button', { name: 'Retry refresh', exact: true }).waitFor();
  readStatus = 200;
  await card.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await card.getByText(/History values expired/).waitFor();
  readStatus = 404;
  await card.getByRole('button', { name: 'Check proposal status' }).click();
  await page.getByText('Table unavailable', { exact: true }).waitFor();
  assert.equal(await card.getByText(digest, { exact: true }).count(), 0, 'Denied proposal clears reviewed data');
  assert.equal(await card.getByRole('button', { name: /Approve|Resume|Reject|Cancel/ }).count(), 0);

  listDelay = 500;
  await page.goto(`${origin}/acme/tables`);
  await page.getByRole('status', { name: 'Loading tables', exact: true }).waitFor();
  assert.equal(await page.getByText('No tables yet', { exact: true }).count(), 0);
  await page.getByText('Support tickets', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sort by Records', exact: true }).waitFor();
  listDelay = 0;
  await page.getByLabel('Search tables', { exact: true }).fill('CUSTOM');
  await page.waitForURL(url => url.searchParams.get('q') === 'CUSTOM');
  await page.getByText('Support tickets', { exact: true }).waitFor({ state: 'detached' });
  await page.getByText('Customers', { exact: true }).waitFor();
  assert.equal(listSearches.at(-1), 'custom', 'Table search runs on the server');
  await page.getByLabel('Search tables', { exact: true }).fill('missing');
  await page.getByText('No tables match “missing”', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('Search tables', { exact: true }).isVisible(),
    true,
    'No results keeps the search field',
  );
  await page.reload();
  await page.getByText('No tables match “missing”', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('Search tables', { exact: true }).inputValue(),
    'missing',
    'Reload restores the table search',
  );
  await page.getByRole('button', { name: 'Clear search', exact: true }).last().click();
  await page.getByText('Support tickets', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('q'), false);
  assert.equal(await page.getByLabel('Search tables', { exact: true }).inputValue(), '');
  listStatus = 503;
  const beforeFocus = tableReads.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await delay(500);
  assert.equal(tableReads.length, beforeFocus, 'Focus performs no table reads');
  await tableChange([['tables', 'list']]);
  await page.getByRole('button', { name: 'Retry refresh', exact: true }).waitFor();
  assert.equal(await page.getByText('Support tickets', { exact: true }).isVisible(), true);
  listStatus = 200;
  emptyList = true;
  await page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await page.getByText('No tables yet', { exact: true }).waitFor();
  if (process.env.TABLE_UI_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.TABLE_UI_SCREENSHOTS}/tables-empty-before-create-chat.png`,
      fullPage: true,
    });
  const createTableLink = page.getByText('Create table in chat', { exact: true }).last();
  assert.equal(await createTableLink.getAttribute('href'), '/acme?intent=create-table');
  await createTableLink.click();
  const createTablePrompt =
    'Help me create a new table. Ask me what kind of rows it holds (for example, customers or invoices) and which fields I need, then propose the table for my review.';
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.waitFor();
  await page.waitForFunction(
    prompt => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent === prompt,
    createTablePrompt,
  );
  assert.equal(await composer.textContent(), createTablePrompt);
  assert.equal(await composer.evaluate(element => element === document.activeElement), true);
  assert.equal(new URL(page.url()).search, '');
  if (process.env.TABLE_UI_SCREENSHOTS)
    await page.screenshot({
      path: `${process.env.TABLE_UI_SCREENSHOTS}/tables-create-chat-prefill-after.png`,
      fullPage: true,
    });
  await page.reload();
  await composer.waitFor();
  assert.equal(await composer.textContent(), '', 'Reload does not restore the consumed prompt');
  await page.goto(`${origin}/acme?intent=unknown`);
  await composer.waitFor();
  assert.equal(await composer.textContent(), '', 'Unknown intents do not prefill the composer');
  emptyList = false;
  await page.goto(`${origin}/acme/tables`);
  await page.getByText('Support tickets', { exact: true }).click();
  await page.getByRole('heading', { name: 'Support tickets', exact: true }).waitFor();
  await page
    .getByRole('navigation', { name: 'Breadcrumb', exact: true })
    .getByRole('link', { name: 'Tables', exact: true })
    .waitFor();
  assert.equal(
    await page.getByText('The latest saved definition is active.', { exact: true }).count(),
    0,
    'Schema status stays behind the table menu',
  );
  const openPanel = async name => {
    await page.getByRole('button', { name: 'More table options', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
    await page.getByRole('dialog', { name, exact: true }).waitFor();
  };
  const rowAction = async (id, item) => {
    await page.getByRole('button', { name: `Actions for row ${id.slice(0, 8)}`, exact: true }).click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
  };
  const closePanel = async () => {
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  };
  await openPanel('Schema history');
  await page.getByText('The latest saved definition is active.', { exact: true }).waitFor();
  const schemas = page.getByRole('region', { name: 'Schema history', exact: true });
  await schemas.getByText('Migration completed', { exact: true }).waitFor();
  schemaStatus = 503;
  await schemas.getByRole('button', { name: 'Check schema history', exact: true }).click();
  await schemas.getByRole('button', { name: 'Retry refresh', exact: true }).waitFor();
  assert.equal(await schemas.getByText('Migration completed', { exact: true }).isVisible(), true);
  schemaStatus = 200;
  schemaSecondPage = true;
  await schemas.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await schemas.getByRole('button', { name: 'Next schema history', exact: true }).click();
  await schemas.getByText('No schema executions on this page', { exact: true }).waitFor();
  assert.equal(schemaCursors.at(-1), executionId);
  await schemas.getByRole('button', { name: 'Previous schema history', exact: true }).click();
  schemaSecondPage = false;
  await closePanel();
  await rowAction(recordId, 'Edit row');
  await page.getByLabel('Subject', { exact: true }).fill('Updated subject');
  await page.getByLabel('Amount', { exact: true }).fill('100000000000000000000');
  await page.getByRole('button', { name: 'Save row', exact: true }).click();
  await page
    .getByText('Enter a decimal number. Use up to 20 whole-number digits and 10 decimal places.', { exact: true })
    .waitFor();
  assert.equal(recordWrites.length, 0, 'Out-of-range numbers never reach the API');
  assert.equal(
    await page.getByLabel('Amount', { exact: true }).evaluate(element => element === document.activeElement),
    true,
  );
  await page.getByLabel('Amount', { exact: true }).fill('99999999999999999999.1234567890');
  assert.notEqual(await page.getByLabel('Amount', { exact: true }).getAttribute('aria-invalid'), 'true');
  await page.getByLabel('Due date', { exact: true }).fill('2026-10-20');
  await page.getByLabel('Resolved', { exact: true }).click();
  await page.getByRole('option', { name: 'No', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog', { name: 'Leave these edits?', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await page.getByLabel('Subject', { exact: true }).inputValue(), 'Updated subject');
  const beforeDraftFocus = tableReads.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await delay(500);
  assert.equal(await page.getByLabel('Subject', { exact: true }).inputValue(), 'Updated subject');
  assert.equal(tableReads.length, beforeDraftFocus, 'Focus preserves draft without table reads');
  await page.getByLabel('Status', { exact: true }).click();
  await page.getByRole('option', { name: 'Open', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Urgent', exact: true }).click();
  await page.getByLabel('Reported at', { exact: true }).fill('2026-10-02T12:30');
  await page.getByLabel('Search rows for Customer', { exact: true }).fill('glob');
  await delay(400);
  await page.getByRole('combobox', { name: 'Choose customer', exact: true }).click();
  await page.getByRole('option', { name: 'Globex (row 1 on this page)', exact: true }).waitFor();
  await page.getByRole('option', { name: 'Globex (row 2 on this page)', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.ok(
    customerReads.some(query => query.get('search') === 'glob'),
    'Row search runs on the server',
  );
  await page.getByLabel('Search rows for Customer', { exact: true }).fill('nobody');
  await page.getByText('No rows match “nobody”.', { exact: true }).waitFor();
  await page.getByLabel('Search rows for Customer', { exact: true }).fill('');
  await delay(400);
  await page.getByRole('combobox', { name: 'Choose customer', exact: true }).click();
  await page.getByRole('option', { name: 'Acme customer', exact: true }).click();
  await page
    .getByRole('list', { name: 'Rows linked from Customer', exact: true })
    .getByText('Acme customer', { exact: true })
    .waitFor();
  await page
    .getByRole('list', { name: 'Recent files', exact: true })
    .getByText('contract.pdf', { exact: true })
    .waitFor();
  suggestionStatus = 503;
  await page.getByLabel('Search files for Evidence', { exact: true }).fill('contr');
  await page.getByText(/Couldn’t search files/).waitFor();
  suggestionStatus = 200;
  await page.getByRole('button', { name: 'Retry file search', exact: true }).click();
  await page
    .getByRole('list', { name: 'Matching files', exact: true })
    .getByText('contract.pdf', { exact: true })
    .waitFor();
  await page.getByLabel('Search files for Evidence', { exact: true }).fill('missing');
  await page.getByText('No files match “missing”.', { exact: true }).waitFor();
  await page.getByLabel('Search files for Evidence', { exact: true }).fill('contract');
  await page.getByRole('button', { name: 'Attach contract.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'Remove contract.pdf from Evidence', exact: true }).waitFor();
  assert.equal(await page.getByText(fileId).count(), 0, 'The editor never shows a file id');
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByLabel('Subject', { exact: true }).scrollIntoViewIfNeeded();
      assert.equal(
        await page
          .getByRole('dialog', { name: 'Edit row', exact: true })
          .evaluate(element => element.scrollWidth <= element.clientWidth),
        true,
        'Editor fits narrow screens',
      );
      await captureEditor(`editor-${theme}-${width}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Save row', exact: true }).dblclick();
  await page.getByText('Updated subject', { exact: true }).waitFor();
  // Sprout's Button rendered as a router link keeps the link role (@tulipfarm/sprout/button with nativeButton={false}).
  await page.getByRole('link', { name: 'Acme customer', exact: true }).waitFor();
  await page.getByRole('link', { name: 'contract.pdf', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('link', { name: 'Acme customer', exact: true }).getAttribute('href'),
    `/acme/tables/${customerId}?row=${customerRecordId}`,
  );
  assert.equal(
    await page.getByRole('link', { name: 'contract.pdf', exact: true }).getAttribute('href'),
    `/acme/files/${fileId}`,
  );
  assert.ok(
    customerReads.some(query => query.get('ids') === customerRecordId),
    'Linked labels load by row id',
  );
  assert.ok(
    summaryRequests.every(ids => ids.length >= 1) && summaryRequests.some(ids => ids.includes(fileId)),
    'File names load through the batch summary read',
  );
  const summariesBefore = summaryRequests.length;
  summaryStatus = 503;
  await tableChange([['files']]);
  await page.getByRole('button', { name: 'Retry file names', exact: true }).waitFor();
  summaryStatus = 200;
  await page.getByRole('button', { name: 'Retry file names', exact: true }).click();
  await page.getByRole('button', { name: 'Retry file names', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('link', { name: 'contract.pdf', exact: true }).waitFor();
  assert.ok(summaryRequests.length > summariesBefore, 'Retry reads file names again');

  assert.equal(await page.getByText(customerRecordId).count(), 0, 'The grid never shows a linked row id');
  linkedStatus = 503;
  await tableChange([['tables', 'linked']]);
  await page.getByRole('button', { name: 'Retry linked rows', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('cell', { name: 'Updated subject', exact: true }).count(),
    1,
    'A failed label refresh keeps the rows',
  );
  linkedStatus = 200;
  await page.getByRole('button', { name: 'Retry linked rows', exact: true }).click();
  await page.getByRole('button', { name: 'Retry linked rows', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('link', { name: 'Acme customer', exact: true }).waitFor();
  assert.equal(recordWrites.length, 1, 'Double click saves one row mutation');
  assert.equal(recordWrites[0].values[fieldId].value, 'Updated subject');
  assert.equal(
    recordWrites[0].values[amountId].value,
    '99999999999999999999.1234567890',
    'Numbers remain exact decimal strings',
  );
  assert.deepEqual(recordWrites[0].values[resolvedId], { kind: 'boolean', value: false });
  assert.deepEqual(recordWrites[0].values[dueId], { kind: 'date', value: '2026-10-20' });
  assert.equal(
    Object.hasOwn(recordWrites[0].values, selectId),
    false,
    'Unchanged selected fields are omitted from direct edit patches',
  );
  assert.deepEqual(recordWrites[0].values[linkId], {
    kind: 'relationship',
    tableId: customerId,
    recordIds: [customerRecordId],
  });
  assert.deepEqual(recordWrites[0].values[tagsId], { kind: 'multi-select', optionIds: [optionId] });
  assert.deepEqual(recordWrites[0].values[timestampId], { kind: 'timestamp', value: '2026-10-02T12:30:00.000Z' });
  assert.deepEqual(recordWrites[0].values[fileFieldId], { kind: 'file', fileIds: [fileId] });
  recordConflict = true;
  await rowAction(recordId, 'Edit row');
  await page.getByLabel('Subject', { exact: true }).fill('Preserved draft');
  await page.getByRole('button', { name: 'Save row', exact: true }).click();
  await page.getByText(/This row changed since you opened it/).waitFor();
  assert.equal(await page.getByLabel('Subject', { exact: true }).inputValue(), 'Preserved draft');
  recordConflict = false;
  await page.getByLabel('Search files for Evidence', { exact: true }).fill('revoked');
  await page.getByRole('button', { name: 'Replace with revoked.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'Save row', exact: true }).click();
  await page.getByText(/This table or a referenced file is missing/).waitFor();
  assert.equal(await page.getByLabel('Subject', { exact: true }).inputValue(), 'Preserved draft');
  await page.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await rowAction(recordId, 'Edit row');
  const chooser = page.locator('input[type="file"]');
  await chooser.setInputFiles({ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) });
  await page.getByText('empty.png is empty. Choose a file with content.', { exact: true }).waitFor();
  uploadStatus = 413;
  await chooser.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('png bytes') });
  await page.getByText(/The file was not uploaded/).waitFor();
  uploadStatus = 200;
  await chooser.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('png bytes') });
  await page.getByText('Uploaded and attached photo.png. Save the row to keep it.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove photo.png from Evidence', exact: true }).waitFor();
  assert.equal(uploads.length, 2);
  assert.deepEqual(
    { ...uploads[1], id: undefined },
    { id: undefined, name: 'photo.png', parentId: 'null', session: 'session-ada' },
  );
  await page.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await rowAction(recordId, 'Edit row');
  await page.getByLabel('Subject', { exact: true }).fill('Saved despite lost response');
  dropRecord = true;
  await page.getByRole('button', { name: 'Save row', exact: true }).click();
  await page.getByRole('button', { name: 'Check row request', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save row', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Retry same operation', exact: true }).count(), 0);
  receiptStatus = 503;
  await page.getByRole('button', { name: 'Check row request', exact: true }).click();
  await page.getByText(/Could not check this row request/).waitFor();
  receiptStatus = 200;
  unknownReceipt = true;
  await page.getByRole('button', { name: 'Check row request', exact: true }).click();
  await page.getByRole('button', { name: 'Retry same row request', exact: true }).waitFor();
  const uncertainRequest = recordWrites.at(-1);
  const priorReceipt = receipts.get(uncertainRequest.requestId);
  receipts.set(uncertainRequest.requestId, { kind: 'expired', id: priorReceipt.id, token: priorReceipt.token });
  await page.getByRole('button', { name: 'Retry same row request', exact: true }).click();
  await page.getByText('Saved despite lost response', { exact: true }).waitFor();
  assert.deepEqual(recordWrites.at(-1), uncertainRequest);
  unknownReceipt = false;
  await rowAction(recordId, 'Edit row');
  await page.getByLabel('Subject', { exact: true }).fill('Confirmed from expired receipt');
  dropRecord = true;
  await page.getByRole('button', { name: 'Save row', exact: true }).click();
  await page.getByRole('button', { name: 'Check row request', exact: true }).waitFor();
  const expiredRequest = recordWrites.at(-1),
    writeCount = recordWrites.length;
  const expiredReceipt = receipts.get(expiredRequest.requestId);
  receipts.set(expiredRequest.requestId, { kind: 'expired', id: expiredReceipt.id, token: expiredReceipt.token });
  await page.getByRole('button', { name: 'Check row request', exact: true }).click();
  await page.getByText('Confirmed from expired receipt', { exact: true }).waitFor();
  assert.equal(
    recordWrites.length,
    writeCount,
    'Metadata-only reconciliation reloads current rows without a duplicate write',
  );
  historyStatus = 503;
  await rowAction(recordId, 'History');
  const historyPanel = page.getByRole('region', { name: 'Row history', exact: true });
  await historyPanel.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  historyStatus = 200;
  emptyHistory = true;
  await historyPanel.getByRole('button', { name: 'Try again', exact: true }).click();
  await historyPanel.getByText('No history on this page', { exact: true }).waitFor();
  await historyPanel.getByRole('button', { name: 'Close history', exact: true }).click();
  emptyHistory = false;
  history[0].operation = 'transform';
  history[0].recoverable_until = '2099-10-02T12:00:00.000Z';
  history[0].before_values = {
    [fieldId]: { kind: 'text', value: 'Restored deleted subject' },
    [selectId]: { kind: 'single-select', optionId },
  };
  deleted = true;
  record.token = randomUUID();
  const tombstoneToken = record.token;
  const deletedPanel = page.getByRole('region', { name: 'Deleted rows', exact: true });
  await openPanel('Deleted rows');
  await deletedPanel.getByRole('button', { name: `Review deleted row ${recordId.slice(0, 8)}`, exact: true }).waitFor();
  deletedStatus = 503;
  await deletedPanel.getByRole('button', { name: 'Refresh deleted rows', exact: true }).click();
  await deletedPanel.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await deletedPanel.getByRole('button', { name: 'Retry refresh', exact: true }).waitFor();
  deletedStatus = 200;
  deletedSecondPage = true;
  await deletedPanel.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await deletedPanel.getByRole('button', { name: 'Next deleted rows', exact: true }).click();
  await deletedPanel.getByText('No deleted rows on this page', { exact: true }).waitFor();
  assert.equal(deletedCursors.at(-1), recordId);
  await deletedPanel.getByRole('button', { name: 'Previous deleted rows', exact: true }).click();
  deletedSecondPage = false;
  historyStatus = 404;
  await tableChange([['tables', 'detail', tableId, 'record-history']]);
  await deletedPanel.getByRole('button', { name: `Review deleted row ${recordId.slice(0, 8)}`, exact: true }).click();
  await historyPanel.getByText('Table unavailable', { exact: true }).waitFor();
  assert.equal(await historyPanel.getByText('Restored deleted subject', { exact: true }).count(), 0);
  assert.equal(await historyPanel.getByRole('button', { name: 'Restore reviewed values', exact: true }).count(), 0);
  historyStatus = 200;
  await historyPanel.getByRole('button', { name: 'Check access again', exact: true }).click();
  await historyPanel.getByRole('button', { name: 'Review values before transform', exact: true }).click();
  await historyPanel.getByText(/This row is deleted/).waitFor();
  for (const [code, message] of [
    ['recovery-expired', /These historical values are no longer recoverable/],
    ['duplicate-key', /conflict with an existing unique row/],
    ['proposal-unavailable', /This table or a referenced file is missing/],
  ]) {
    restoreError = code;
    await historyPanel.getByRole('button', { name: 'Restore reviewed values', exact: true }).click();
    await historyPanel.getByText(message).waitFor();
    assert.equal(await deletedPanel.getByText('Row restored.', { exact: true }).count(), 0);
  }
  restoreError = null;
  dropRecord = true;
  await historyPanel.getByRole('button', { name: 'Restore reviewed values', exact: true }).dblclick();
  await historyPanel.getByRole('button', { name: 'Check row request', exact: true }).click();
  await deletedPanel.getByText('Row restored.', { exact: true }).waitFor();
  await deletedPanel.getByText('No deleted rows on this page', { exact: true }).waitFor();
  assert.equal(recordWrites.at(-1).expectedToken, tombstoneToken);
  assert.equal(recordWrites.at(-1).version, 'before');
  await closePanel();
  await page.getByRole('cell', { name: 'Restored deleted subject', exact: true }).waitFor();
  deletedStatus = 404;
  await openPanel('Deleted rows');
  await deletedPanel.getByRole('button', { name: 'Refresh deleted rows', exact: true }).click();
  await deletedPanel.getByText('Table unavailable', { exact: true }).waitFor();
  deletedStatus = 200;
  await deletedPanel.getByRole('button', { name: 'Check access again', exact: true }).click();
  await deletedPanel.getByText('No deleted rows on this page', { exact: true }).waitFor();
  await closePanel();
  // Distinct saved/applied revisions and source-redacted metadata remain honest.
  savedDefinition = {
    ...schemaEntry,
    revision: 'b'.repeat(40),
    phase: 'copying',
    appliedAt: null,
    receipt: null,
    definition: null,
  };
  await tableChange();
  await page.getByText(/A field change is still applying/).waitFor();
  await openPanel('Schema history');
  await page.getByText(/latest saved definition is not active/).waitFor();
  await page.getByRole('button', { name: 'Latest saved fields', exact: true }).click();
  await page.getByText(/Saved fields are hidden/).waitFor();
  await schemas.getByRole('button', { name: 'Check schema history', exact: true }).click();
  await schemas.getByText('Migrating rows', { exact: true }).waitFor();
  await schemas.getByText(/Historical fields are hidden/).waitFor();
  savedDefinition = {
    ...savedDefinition,
    phase: 'blocked',
    receipt: { status: 'failed', executionId, code: 'stale-generation' },
  };
  await schemas.getByRole('button', { name: 'Check schema history', exact: true }).click();
  await schemas.getByText('Migration blocked', { exact: true }).waitFor();
  await schemas.getByText(/Execution failed/).waitFor();
  await closePanel();
  const applied = activeDefinition;
  activeDefinition = null;
  await tableChange();
  await page.getByText('No active definition yet', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Refresh rows', exact: true }).count(), 0);
  activeDefinition = applied;
  savedDefinition = schemaEntry;
  await tableChange();
  await page.getByRole('cell', { name: 'Restored deleted subject', exact: true }).waitFor();
  history[0].operation = 'update';
  history[0].before_values = {
    [fieldId]: { kind: 'text', value: 'Historical subject' },
    [selectId]: { kind: 'single-select', optionId },
    [fileFieldId]: { kind: 'file', fileIds: [hiddenFileId] },
    [linkId]: { kind: 'relationship', tableId: customerId, recordIds: [globexId] },
  };
  history[0].unavailable_file_ids = [hiddenFileId];
  await tableChange([['tables', 'detail', tableId, 'record-history']]);
  await rowAction(recordId, 'History');
  await historyPanel.getByRole('button', { name: 'Review values before update', exact: true }).click();
  await historyPanel.getByText('Historical subject', { exact: true }).waitFor();
  await historyPanel.getByText('File unavailable', { exact: true }).waitFor();
  await historyPanel.getByRole('link', { name: 'Globex', exact: true }).waitFor();
  assert.equal(fileReads.includes(hiddenFileId), false, 'History never requests a file the server marked unavailable');
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'History does not overflow the document',
    );
    if (process.env.TABLE_UI_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.TABLE_UI_SCREENSHOTS}/table-history-mobile-${theme}.png`,
        fullPage: true,
      });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  recordConflict = true;
  await historyPanel.getByRole('button', { name: 'Restore reviewed values', exact: true }).click();
  await historyPanel.getByText(/This row changed since you opened it/).waitFor();
  recordConflict = false;
  dropRecord = true;
  await historyPanel.getByRole('button', { name: 'Restore reviewed values', exact: true }).click();
  await historyPanel.getByRole('button', { name: 'Check row request', exact: true }).click();
  await historyPanel.waitFor({ state: 'detached' });
  await page.getByText('Historical subject', { exact: true }).waitFor();
  assert.equal(await historyPanel.count(), 0);
  assert.equal(recordWrites.at(-1).kind, 'restore');
  assert.equal(recordWrites.at(-1).version, 'before');
  history[0].recoverable_until = '2020-01-01T00:00:00.000Z';
  history[0].before_values = null;
  history[0].values = null;
  await tableChange([['tables', 'detail', tableId, 'record-history']]);
  await rowAction(recordId, 'History');
  await historyPanel.getByText(/Recovery expired/).waitFor();
  assert.equal(await historyPanel.getByRole('button', { name: 'Review values before update', exact: true }).count(), 0);
  await historyPanel.getByRole('button', { name: 'Close history', exact: true }).click();
  emptyRecords = true;
  await tableChange();
  await page.getByText('No rows yet', { exact: true }).waitFor();
  emptyRecords = false;
  recordStatus = 404;
  await tableChange();
  await page.getByText('Table unavailable', { exact: true }).first().waitFor();
  recordStatus = 200;
  await page.getByRole('button', { name: 'Check access again', exact: true }).first().click();
  await page.getByText('Historical subject', { exact: true }).waitFor();
  detailStatus = 404;
  await tableChange();
  await page.getByRole('region', { name: 'Definition status', exact: true }).waitFor({ state: 'detached' });
  await page.getByText('Table unavailable', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Definition status', exact: true }).count(), 0);
  assert.equal(await page.getByRole('cell', { name: 'Historical subject', exact: true }).count(), 0);
  detailStatus = 200;
  await page.getByRole('button', { name: 'Check access again', exact: true }).click();
  await page.getByRole('cell', { name: 'Historical subject', exact: true }).waitFor();
  record.values = {
    ...record.values,
    [fileFieldId]: { kind: 'file', fileIds: [hiddenFileId] },
    [linkId]: { kind: 'relationship', tableId: customerId, recordIds: [missingCustomerId] },
  };
  record.unavailableFileIds = [hiddenFileId];
  fileReads.length = 0;
  await tableChange();
  await page.getByRole('cell', { name: 'File unavailable', exact: true }).waitFor();
  await page.getByRole('cell', { name: 'Row unavailable', exact: true }).waitFor();
  assert.equal(
    (await page.getByText(hiddenFileId).count()) + (await page.getByText(missingCustomerId).count()),
    0,
    'Unavailable references never show ids',
  );
  await page.goto(`${origin}/acme/tables/${customerId}?row=${customerRecordId}`);
  await page.getByRole('region', { name: 'Row history', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close history', exact: true }).click();
  await page.waitForURL(`${origin}/acme/tables/${customerId}`);
  await page.goto(`${origin}/acme/tables/${customerId}?row=${missingCustomerId}`);
  await page.getByRole('heading', { name: 'Row unavailable', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to table', exact: true }).click();
  await page.waitForURL(`${origin}/acme/tables/${customerId}`);
  await page.goto(`${origin}/acme/tables/${tableId}`);
  const layoutTabs = page.getByRole('tablist', { name: 'Layout', exact: true });
  await layoutTabs.getByRole('tab', { name: 'Board', exact: true }).click();
  const board = page.locator('[data-slot="board"]');
  await board.getByText('Open', { exact: true }).first().waitFor();
  const subject = record.values[fieldId].value;
  await board.getByText(subject, { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('tabpanel').count(), 1, 'The board is the Layout tab panel');
  await layoutTabs.getByRole('tab', { name: 'List', exact: true }).click();
  const recordList = page.locator('[data-slot="record-list"]');
  await recordList.getByText(subject, { exact: true }).waitFor();
  await recordList.getByText(subject, { exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit row', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Edit row', exact: true }).waitFor({ state: 'detached' });
  await layoutTabs.getByRole('tab', { name: 'Table', exact: true }).click();
  await page.locator('table[data-slot=table]').waitFor();
  await rowAction(recordId, 'Edit row');
  const evidence = page.getByRole('list', { name: 'Files attached to Evidence', exact: true });
  await evidence.getByText('File unavailable', { exact: true }).waitFor();
  await page
    .getByRole('list', { name: 'Rows linked from Customer', exact: true })
    .getByText('Row unavailable', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Remove file 1 from Evidence', exact: true }).click();
  await page.getByText('No files attached.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove linked row 1 from Customer', exact: true }).click();
  await page.getByRole('button', { name: 'Save row', exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit row', exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(
    [recordWrites.at(-1).values[fileFieldId], recordWrites.at(-1).values[linkId]],
    [null, null],
    'Unavailable references can be removed',
  );
  assert.equal(
    fileReads.includes(hiddenFileId),
    false,
    'The table UI never requests a file the server marked unavailable',
  );
  delete record.unavailableFileIds;
  assert.deepEqual(singleFileReads, [], 'Table views read file names in batches, never one file at a time');
  await page.getByText('Change fields in chat', { exact: true }).click();
  await page.waitForURL(`${origin}/acme`);
  await page.waitForFunction(() =>
    document
      .querySelector('[role="textbox"][aria-label="Message"]')
      ?.textContent?.startsWith('Help me change the fields of'),
  );
  const editPrompt = await page.getByRole('textbox', { name: 'Message', exact: true }).textContent();
  assert.match(
    editPrompt,
    /^Help me change the fields of the “[^”]+” table \(table ID [0-9a-f-]{36}, current revision [^)]+\)\. /,
    'The edit handoff names the table and its current revision without copy and paste',
  );
  await page.goto(`${origin}/acme/tables/new`);
  assert.equal(
    await page.getByRole('link', { name: 'Create table in chat', exact: true }).getAttribute('href'),
    '/acme?intent=create-table',
  );
  assert.equal(await page.getByRole('button', { name: 'Save schema', exact: true }).count(), 0);
  grantStatus = 503;
  await page.goto(`${origin}/acme/grants`);
  const person = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Individual table grants', exact: true }) })
    .last();
  await person.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  grantStatus = 200;
  await person.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByLabel('Person receiving access').click();
  await page.getByRole('option', { name: 'Ada (ada@example.com)', exact: true }).click();
  assert.equal(await page.getByLabel('Person receiving access').innerText(), 'Ada (ada@example.com)');
  await person.getByRole('checkbox', { name: 'Read rows', exact: true }).click();
  await page.getByLabel('Person receiving access').getByText('Select a person', { exact: true }).waitFor();
  await page.getByLabel('Person receiving access').click();
  await page.getByRole('option', { name: 'Ada (ada@example.com)', exact: true }).click();
  assert.equal(await page.getByLabel('Person receiving access').innerText(), 'Ada (ada@example.com)');
  await person.getByRole('checkbox', { name: 'Read rows', exact: true }).waitFor();
  assert.equal(await person.getByRole('checkbox', { name: 'Read rows', exact: true }).isChecked(), true);
  assert.deepEqual(grantWrites[0], {
    membershipId: memberId,
    target: { kind: 'table', id: tableId, permission: 'table.row.read' },
    granted: true,
  });
  grantWriteStatus = 409;
  await person.getByRole('checkbox', { name: 'Read rows', exact: true }).click();
  await person.getByRole('button', { name: 'Reload individual grants', exact: true }).waitFor();
  assert.equal(await person.getByRole('checkbox', { name: 'Read rows', exact: true }).isChecked(), true);
  grantWriteStatus = 200;
  await person.getByRole('button', { name: 'Reload individual grants', exact: true }).click();
  await person.getByRole('checkbox', { name: 'Read rows', exact: true }).click();
  await page.getByLabel('Person receiving access').getByText('Select a person', { exact: true }).waitFor();
  await page.getByLabel('Person receiving access').click();
  await page.getByRole('option', { name: 'Ada (ada@example.com)', exact: true }).click();
  assert.equal(await page.getByLabel('Person receiving access').innerText(), 'Ada (ada@example.com)');
  await person.getByRole('checkbox', { name: 'Read rows', exact: true }).waitFor();
  assert.equal(await person.getByRole('checkbox', { name: 'Read rows', exact: true }).isChecked(), false);
  assert.equal(grantWrites.at(-1).granted, false);
  assert.deepEqual(singleFileReads, [], 'Table views read file names in batches, never one file at a time');
  assert.deepEqual(errors, []);
  console.log(
    'Table UI HTTP-stub proof passed. API-schema-validated mutations, proposal recovery, exact effects, token edits, row and file pickers, uploads, unavailable references, file denial, request reconciliation, deleted discovery pagination and tombstone restore, expiry/conflict errors, transform history, saved/active and redacted definitions, migration status and schema pagination, denied refresh clearing, responsive themes, and person grants. Not end-to-end backend proof.',
  );
} catch (error) {
  await page?.screenshot({ path: '/tmp/table-ui-failure.png', fullPage: true });
  throw error;
} finally {
  await browser?.close();
  if (agentAttached) await promisify(execFile)('agent-browser', ['--session', 'table-editor', 'close']);
  if ('httpServer' in server) await new Promise(resolve => server.httpServer.close(resolve));
  else server.kill('SIGTERM');
}
