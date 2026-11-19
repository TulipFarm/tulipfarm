import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { membership, credits, governance } from './chat-query.fixture.mjs';

const { workspace, session } = createWorkspaceFixture({ slug: 'acme', name: 'Acme' });
const base = `/v1/workspaces/${workspace.id}`;
const admin = membership.membershipId;
const grace = governance.members[1].id;
const appId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const app = {
  id: appId,
  kind: 'public',
  slug: 'order-tracker',
  title: 'Order tracker',
  publicName: 'acme-orders',
  webAddress: null,
  role: 'edit',
  approval: { state: 'approved', approvedBy: admin, at: '2026-11-10T09:00:00Z', monthlyLimitUnits: null },
  liveReleaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  edgeStatus: 'active',
  stops: { disabledAt: null, editorPausedAt: null, budgetPausedAt: null },
};
const detail = (summary = app) => ({
  ...summary,
  draft: {
    state: 'live',
    revision: 3,
    headCommit: 'c'.repeat(40),
    previewBuildId: null,
    buildId: 'b1',
    commit: 'c'.repeat(40),
  },
  liveRelease: { id: app.liveReleaseId, number: 3, commit: 'c'.repeat(40) },
  sitesDomain: null,
});

const id = (prefix, n) => `${prefix}000000-0000-4000-8000-00000000000${n}`;
const text = (n, label) => ({ id: id('f0', n), label, required: true, kind: 'text', maxLength: 256 });
const tables = {
  orders: { id: id('7a', 1), label: 'Orders', fields: [text(1, 'Order number'), text(2, 'Customer email')] },
  customers: { id: id('7a', 2), label: 'Customers', fields: [text(3, 'Name')] },
  feedback: { id: id('7a', 3), label: 'Feedback', fields: [text(4, 'Message')] },
  returns: { id: id('7a', 4), label: 'Returns', fields: [text(5, 'Reason')] },
};
const tableList = {
  tables: [tables.orders].map(({ id: tableId, label, fields }) => ({
    id: tableId,
    revision: '1',
    definition: { formatVersion: 2, id: tableId, owningTeamId: id('7e', 1), label, fields, uniqueKeys: [] },
    appliedAt: '2026-11-01T00:00:00.000Z',
    recordCount: '3',
  })),
  nextCursor: null,
};
const at = '2026-11-12T10:00:00.000Z';
const dataView = (n, table, over = {}) => ({
  id: id('d0', n),
  tableId: table?.id ?? id('7a', 9),
  fieldIds: table ? [table.fields[0].id] : [id('f0', 9)],
  predicate: { all: [] },
  actions: ['read'],
  createdBy: admin,
  createdAt: at,
  sharedBy: admin,
  sharedAt: at,
  approvedBy: admin,
  approvedAt: at,
  blockers: [],
  table: table && { label: table.label, fields: table.fields },
  ...over,
});
const initialViews = () => [
  dataView(1, tables.customers, {
    predicate: {
      all: [{ fieldId: tables.customers.fields[0].id, op: 'eq', operand: { kind: 'parameter', name: 'name' } }],
    },
  }),
  dataView(2, tables.feedback, {
    createdBy: grace,
    sharedBy: grace,
    approvedBy: null,
    approvedAt: null,
    blockers: ['not-approved'],
  }),
  // The API lists blockers in this order: app-not-serving, not-approved, view-unresolvable.
  dataView(3, null, { approvedBy: null, approvedAt: null, blockers: ['not-approved', 'view-unresolvable'] }),
  dataView(5, tables.returns, {
    sharedBy: null,
    sharedAt: null,
    approvedBy: null,
    approvedAt: null,
    blockers: ['app-not-serving', 'not-approved', 'view-unresolvable'],
  }),
];

async function open({ role = 'admin', appRole = 'edit', failingList = false } = {}) {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  // refusals maps a view id to the view as it stands when the API refuses a share or approval with 404.
  const state = { views: initialViews(), writes: [], errors: [], failing: failingList, refusals: new Map() };
  const summary = { ...app, role: appRole };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
    if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
    if (path === `/v1/workspaces/${workspace.slug}/last-used`) return route.fulfill({ status: 204 });
    if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
    if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
    if (path === `${base}/governance/me`) return route.fulfill({ json: { ...membership, role } });
    if (path === `${base}/governance/directory`)
      return route.fulfill({
        json: {
          members: governance.members.map(({ id, name, email, role }) => ({ id, name, email, role, image: null })),
        },
      });
    if (path === `${base}/credits`) return route.fulfill({ json: credits });
    if (path === `${base}/tables`) return route.fulfill({ json: tableList });
    if (path === `${base}/apps`) return route.fulfill({ json: { apps: [summary] } });
    if (path === `${base}/apps/${appId}`) return route.fulfill({ json: detail(summary) });
    if (path === `${base}/apps/${appId}/data-views`) {
      if (method === 'GET') {
        if (state.failing) return route.fulfill({ status: 500, json: { error: 'internal' } });
        return route.fulfill({ json: { views: state.views } });
      }
      const draft = request.postDataJSON();
      state.writes.push({ method, path, draft });
      const { requestId: _requestId, ...chosen } = draft;
      const created = dataView(4, tables.orders, {
        ...chosen,
        sharedBy: null,
        sharedAt: null,
        approvedBy: null,
        approvedAt: null,
        blockers: ['not-approved'],
      });
      state.views.push(created);
      return route.fulfill({ json: created });
    }
    const action = new RegExp(`^${base}/apps/${appId}/data-views/([\\w-]+)/(share|approval)$`).exec(path);
    if (action) {
      const [, viewId, kind] = action;
      state.writes.push({ method, path: `${kind}:${viewId}` });
      const index = state.views.findIndex(entry => entry.id === viewId);
      const current = state.views[index];
      if (state.refusals.has(viewId)) {
        state.views[index] = state.refusals.get(viewId)(current);
        return route.fulfill({ status: 404, json: { error: 'not-found' } });
      }
      const next =
        method === 'DELETE'
          ? {
              ...current,
              sharedBy: null,
              sharedAt: null,
              approvedBy: null,
              approvedAt: null,
              blockers: ['not-approved'],
            }
          : kind === 'share'
            ? { ...current, sharedBy: admin, sharedAt: at }
            : { ...current, approvedBy: admin, approvedAt: at, blockers: [] };
      state.views[index] = next;
      return method === 'DELETE' ? route.fulfill({ status: 204 }) : route.fulfill({ json: next });
    }
    if (method === 'GET') return route.fulfill({ status: 404, json: { error: 'not-found' } });
    throw new Error(`Unexpected API request ${method} ${path}`);
  });
  const origin = server.resolvedUrls.local[0];
  return {
    page,
    state,
    goto: path => page.goto(`${origin}${workspace.slug}/apps/${app.slug}${path}`),
    close: async () => {
      await context.close();
      await browser.close();
      await server.close();
    },
  };
}

const card = (page, table) => page.getByRole('article', { name: `${table} data view` });
const confirm = async (page, title, action) => {
  const dialog = page.getByRole('alertdialog', { name: title });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: action }).click();
  await dialog.waitFor({ state: 'detached' });
};

test(
  'an editor who is an admin sees each view’s status and shares, approves and stops sharing views',
  { timeout: 180_000 },
  async () => {
    const run = await open({ failingList: true });
    const { page, state } = run;
    try {
      await run.goto('');
      await page.getByRole('link', { name: 'Data access' }).click();
      await page.waitForURL(/\/data-access$/);

      // A read that keeps failing offers a retry, and the retry shows the list.
      await page.getByRole('heading', { name: 'Couldn’t load data access.' }).waitFor({ timeout: 30_000 });
      state.failing = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await page.getByRole('list', { name: 'Data views' }).waitFor();

      const customers = card(page, 'Customers');
      await customers.getByText('In use', { exact: true }).waitFor();
      await customers.getByText('The app can use this data view now.').waitFor();
      await customers.getByRole('button', { name: 'Show details for Customers data view' }).click();
      await customers.getByText('Fields: Name').waitFor();
      assert.equal(
        (await customers.getByText(/^Rows where/).textContent()).trim(),
        'Rows where Name is the value the app sends as name',
      );
      assert.equal(await customers.locator('code').textContent(), 'name');

      const feedback = card(page, 'Feedback');
      await feedback.getByText('Not in use yet', { exact: true }).waitFor();
      await feedback.getByText('Waiting for a workspace admin to approve.').waitFor();
      await feedback.getByText('Shared by Grace on Nov 12, 2026').waitFor();
      await feedback.getByRole('button', { name: 'Approve Feedback data view' }).waitFor();

      // A broken view says so before any other blocker and offers only Stop sharing.
      const deleted = card(page, 'Unavailable table');
      await deleted
        .getByText('The table was deleted. Stop sharing this view, then create a new data view from another table.')
        .waitFor();
      await deleted.getByRole('button', { name: 'Stop sharing Unavailable table data view' }).waitFor();
      assert.equal(await deleted.getByRole('button', { name: 'Approve Unavailable table data view' }).count(), 0);
      const returns = card(page, 'Returns');
      await returns
        .getByText('Returns changed, and this view no longer matches it. Create a new data view to share instead.')
        .waitFor();
      assert.equal(await returns.getByRole('button', { name: 'Share with this app' }).count(), 0);

      // Create a view on Orders: it starts unshared and gives the app nothing.
      await page.getByRole('button', { name: 'Create data view' }).click();
      const form = page.getByRole('dialog', { name: 'New data view' });
      await form.getByRole('combobox').first().click();
      await page.getByRole('option', { name: 'Orders' }).click();
      await form.getByRole('checkbox', { name: 'Order number' }).check();
      await form.getByRole('button', { name: 'Create data view' }).click();
      await form.waitFor({ state: 'detached' });
      const created = state.writes.find(write => write.method === 'POST');
      assert.equal(created.draft.tableId, tables.orders.id);
      assert.deepEqual(created.draft.fieldIds, [tables.orders.fields[0].id]);
      assert.deepEqual(created.draft.actions, ['read']);
      assert.deepEqual(created.draft.predicate, { all: [] });
      assert.match(created.draft.requestId, /^[\da-f-]{36}$/);

      const orders = card(page, 'Orders');
      await orders.getByText('This view isn’t shared with the app.').waitFor();

      // Cancelling the confirmation changes nothing.
      await orders.getByRole('button', { name: 'Share with this app' }).click();
      const shareDialog = page.getByRole('alertdialog', { name: 'Share Orders data view with this app?' });
      await shareDialog.getByRole('button', { name: 'Cancel' }).click();
      await shareDialog.waitFor({ state: 'detached' });
      assert.equal(state.writes.filter(write => write.path.startsWith('share:')).length, 0);

      await orders.getByRole('button', { name: 'Share with this app' }).click();
      await confirm(page, 'Share Orders data view with this app?', 'Share');
      await page.getByText('Shared. Waiting for a workspace admin to approve.').waitFor();
      await orders.getByText('Waiting for a workspace admin to approve.').waitFor();

      await orders.getByRole('button', { name: 'Approve Orders data view' }).click();
      await confirm(page, 'Approve Orders data view?', 'Approve');
      await page.getByText('Approved.', { exact: true }).waitFor();
      await orders.getByText('In use', { exact: true }).waitFor();
      await orders.getByRole('button', { name: 'Approve Orders data view' }).waitFor({ state: 'detached' });

      await customers.getByRole('button', { name: 'Stop sharing Customers data view' }).click();
      await confirm(page, 'Stop sharing Customers data view?', 'Stop sharing');
      await page.getByText('Stopped sharing. The app can no longer use this data view.').waitFor();
      await customers.getByText('This view isn’t shared with the app.').waitFor();
      await customers.getByRole('button', { name: 'Share with this app' }).waitFor();

      const created4 = id('d0', 4);
      assert.deepEqual(
        state.writes.map(write => `${write.method} ${write.method === 'POST' ? 'create' : write.path}`),
        ['POST create', `PUT share:${created4}`, `PUT approval:${created4}`, `DELETE share:${id('d0', 1)}`],
      );
      assert.deepEqual(state.errors, []);
    } finally {
      await run.close();
    }
  },
);

test(
  'a share or approval refused because the view broke says so, not that rights are missing',
  { timeout: 120_000 },
  async () => {
    const run = await open();
    const { page, state } = run;
    try {
      await run.goto('/data-access');
      await page.getByRole('list', { name: 'Data views' }).waitFor();
      const broke = view => ({ ...view, blockers: [...view.blockers, 'view-unresolvable'] });
      const changed = 'This data view or its table was removed or changed. The list now shows its current state.';

      // The feedback table changes while the admin reads the list.
      state.refusals.set(id('d0', 2), broke);
      const feedback = card(page, 'Feedback');
      await feedback.getByRole('button', { name: 'Approve Feedback data view' }).click();
      const approval = page.getByRole('alertdialog', { name: 'Approve Feedback data view?' });
      await approval.getByRole('button', { name: 'Approve' }).click();
      await approval.getByText(changed).waitFor();
      await approval.getByRole('button', { name: 'Cancel' }).click();
      await feedback
        .getByText(
          'Feedback changed, and this view no longer matches it. Create a new data view, then stop sharing this one.',
        )
        .waitFor();
      assert.equal(await feedback.getByRole('button', { name: 'Approve Feedback data view' }).count(), 0);

      // An unchanged view refused with 404 means the sharer lacks rights on the table.
      state.views[0] = {
        ...state.views[0],
        sharedBy: null,
        sharedAt: null,
        approvedBy: null,
        approvedAt: null,
        blockers: ['not-approved'],
      };
      state.refusals.set(id('d0', 1), view => view);
      await page.reload();
      const customers = card(page, 'Customers');
      await customers.getByRole('button', { name: 'Share with this app' }).click();
      const share = page.getByRole('alertdialog', { name: 'Share Customers data view with this app?' });
      await share.getByRole('button', { name: 'Share' }).click();
      await share.getByText('You can’t share this table.', { exact: false }).waitFor();
      await share.getByRole('button', { name: 'Cancel' }).click();

      // The same refusal after the table was deleted names the change instead.
      state.refusals.set(id('d0', 1), view => ({ ...broke(view), table: null }));
      await customers.getByRole('button', { name: 'Share with this app' }).click();
      await share.getByRole('button', { name: 'Share' }).click();
      await share.getByText(changed).waitFor();
      await share.getByRole('button', { name: 'Cancel' }).click();
      await card(page, 'Unavailable table')
        .getByText('The table was deleted, so this view can’t be shared. Create a new data view from another table.')
        .waitFor();
      assert.deepEqual(state.errors, []);
    } finally {
      await run.close();
    }
  },
);

test('a person who can only use the app gets no data access entry or controls', { timeout: 120_000 }, async () => {
  const run = await open({ role: 'member', appRole: 'use' });
  const { page, state } = run;
  try {
    await run.goto('');
    await page.getByText('About this app').waitFor();
    assert.equal(await page.getByRole('link', { name: 'Data access' }).count(), 0);

    await run.goto('/data-access');
    await page.getByRole('heading', { name: 'Only editors can manage data access' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Create data view' }).count(), 0);
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.errors, []);
  } finally {
    await run.close();
  }
});
