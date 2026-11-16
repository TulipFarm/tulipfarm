// Build first: VITE_API_URL= pnpm --filter @tulipfarm/web build
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { captureBrowserFailure, startBuiltApp } from './built-app.fixture.mjs';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const workspaceId = '11111111-1111-4111-8111-111111111111';
const memberId = '22222222-2222-4222-8222-222222222222';
const adminTeamId = '8a62a927-0000-4000-8000-000000000000';
const opsTeamId = '44444444-4444-4444-8444-444444444444';
const adminTable = '33333333-3333-4333-8333-333333333333';
const opsTable = '55555555-5555-4555-8555-555555555555';
const adminLabel = `Invoices · Admin · ${adminTable.slice(0, 8)}`;
const opsLabel = `Invoices · Operations · ${opsTable.slice(0, 8)}`;
const workspace = {
  id: workspaceId,
  name: 'Acme',
  slug: 'acme',
  createdAt: '2026-09-27T00:00:00.000Z',
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const ada = { id: memberId, name: 'Ada', email: 'ada@example.com', image: null, role: 'admin' };
const tables = [
  { id: adminTable, name: 'Invoices', owningTeamId: adminTeamId },
  { id: opsTable, name: 'Invoices', owningTeamId: opsTeamId },
];
const allPermissions = [
  'table.schema.manage',
  'table.row.create',
  'table.row.read',
  'table.row.update',
  'table.row.delete',
];

let app;
let browser;
before(async () => {
  app = await startBuiltApp();
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await app?.close();
});

/** Mocks the access API for Ada, an admin, whose direct table policies live in `api.policies` by table id. */
async function openAccess(t, { failWrite, refreshDelay = 0, path = `/acme/members/${memberId}` } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  t.after(async () => {
    if (t.passed === false) await captureBrowserFailure(page, `person-grants-${t.name}`);
    await page.close();
  });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const api = { policies: new Map(), writes: [], errors, watching: false, reads: [], events: [] };
  const snapshot = () => ({
    actorMembershipId: memberId,
    adminTeamId,
    members: [{ id: memberId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }],
    directory: [ada],
    tableTeamIds: [opsTeamId],
    teams: [
      {
        id: opsTeamId,
        name: 'Operations',
        description: '',
        membershipIds: [memberId],
        managerIds: [memberId],
        canManage: true,
        canLeave: true,
      },
    ],
    tables,
    grants: [],
    personGrants: [...api.policies].flatMap(([id, permissions]) =>
      permissions.map(permission => ({ membershipId: memberId, target: { kind: 'table', id, permission } })),
    ),
  });
  const memberAccess = () => ({
    member: ada,
    self: true,
    canManage: true,
    canLeave: true,
    finalAdmin: true,
    teams: [{ id: opsTeamId, name: 'Operations', role: 'manager', canManage: true }],
    policies: [
      { scope: { kind: 'all' }, permissions: allPermissions, source: { kind: 'admin' } },
      ...[...api.policies].map(([id, permissions]) => ({
        scope: { kind: 'table', id, name: 'Invoices' },
        permissions,
        source: { kind: 'direct' },
      })),
    ],
    skipped: null,
  });
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (api.watching && request.method() === 'GET') api.reads.push(path);
    // Saving a policy reloads table authority, which refetches workspace integrations such as Google Workspace.
    if (api.watching && request.method() === 'GET' && path.endsWith('/google-workspace')) {
      api.events.push('refresh started');
      api.refreshStarted?.();
      await setTimeout(refreshDelay);
      api.events.push('refresh loaded');
    }
    let json;
    if (path === '/v1/auth/get-session')
      json = { session: { id: 'session', userId: 'ada' }, user: { id: 'ada', name: 'Ada', email: 'ada@example.com' } };
    else if (path === '/v1/auth/options') json = { google: false, magicLink: true, emailPassword: true };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === '/v1/workspaces/acme') json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: memberId,
        role: 'admin',
        teams: [{ id: opsTeamId, name: 'Operations', role: 'manager' }],
        adminTeamId,
        capabilities: { manageGovernance: true, canLeave: true },
      };
    else if (path.endsWith('/governance')) json = snapshot();
    else if (path.endsWith(`/governance/members/${memberId}/access`)) json = memberAccess();
    else if (path.endsWith('/governance/policies') && request.method() === 'PUT') {
      const body = request.postDataJSON();
      api.writes.push(`${body.scope.id === adminTable ? 'admin' : 'ops'}: ${body.permissions.join(', ')}`);
      api.events.push(`PUT ${api.writes.at(-1)}`);
      await setTimeout(300);
      if (failWrite?.(api.writes.length))
        return route.fulfill({ status: 503, json: { error: 'workspace-unavailable' } });
      const before = api.policies.get(body.scope.id) ?? [];
      if (body.permissions.length) api.policies.set(body.scope.id, body.permissions);
      else api.policies.delete(body.scope.id);
      json = {
        added: body.permissions.filter(permission => !before.includes(permission)),
        removed: before.filter(permission => !body.permissions.includes(permission)),
      };
    } else return route.fulfill({ status: 404, json: { error: 'unavailable' } });
    await route.fulfill({ json });
  });
  await page.goto(`${app.origin}${path}`);
  return { page, api };
}

/** Creates a policy for Ada on one table, or edits it when she already has one, as a person would. */
async function savePolicy(page, table, extra = []) {
  await page.getByRole('button', { name: 'Create a policy', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Applies to').click();
  await page.getByRole('option', { name: table, exact: true }).click();
  for (const permission of extra) await dialog.getByRole('checkbox', { name: permission, exact: true }).click();
  await dialog.getByRole('button', { name: /^(Add|Save) policy$/ }).click();
  return dialog;
}

const notice = (page, text) => page.getByRole('status').filter({ hasText: text });
const directRows = page => page.getByRole('row').filter({ hasText: 'Direct policy' });

// Record whether any part of the page was replaced by a loading state.
async function watchLoading(page, api) {
  api.watching = true;
  await page.evaluate(() => {
    window.loadingSeen = false;
    const check = () => {
      if (/Loading (workspace )?access…|Loading tables…/.test(document.body.innerText)) window.loadingSeen = true;
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

async function waitFor(condition, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out waiting for condition');
    await setTimeout(50);
  }
}

test('a table owned by the admin team is labelled Admin', async t => {
  const { page } = await openAccess(t, { path: '/acme/grants' });
  await page.getByRole('heading', { name: adminLabel, exact: true }).waitFor();
  await page.getByRole('heading', { name: opsLabel, exact: true }).waitFor();
  assert.equal(await page.getByLabel(`Owning team for ${adminLabel}`).innerText(), 'Admin');
  assert.equal(await page.getByText(`Team ${adminTeamId.slice(0, 8)}`).count(), 0);

  // The policy editor tells the two tables apart the same way.
  await page.goto(`${app.origin}/acme/members/${memberId}`);
  await page.getByRole('button', { name: 'Create a policy', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('Applies to').click();
  const options = await page.getByRole('option').allInnerTexts();
  assert.ok(options.includes(adminLabel), options.join(' | '));
  assert.ok(options.includes(opsLabel), options.join(' | '));
  assert.equal(
    options.filter(option => option.includes(adminTeamId.slice(0, 8)) && !option.includes(adminTable.slice(0, 8)))
      .length,
    0,
  );
});

test('quick policy changes for yourself all save in order without reloading workspace access', async t => {
  const { page, api } = await openAccess(t);
  const tabs = page.getByRole('tablist', { name: 'Ada’s access' });
  await tabs.waitFor();
  const mounted = await tabs.elementHandle();
  await watchLoading(page, api);
  for (const [table, extra] of [
    [adminLabel, []],
    [opsLabel, []],
    [adminLabel, ['Create rows', 'Update rows']],
  ])
    await (await savePolicy(page, table, extra)).waitFor({ state: 'hidden' });
  await notice(page, `Ada can now create and update rows in ${adminLabel}.`).waitFor();
  assert.deepEqual(api.writes, [
    'admin: table.row.read',
    'ops: table.row.read',
    'admin: table.row.read, table.row.create, table.row.update',
  ]);
  assert.equal(await mounted.evaluate(element => element.isConnected), true, 'the member page was not reloaded');
  assert.equal(await page.getByRole('tab', { name: 'Access policies' }).getAttribute('aria-selected'), 'true');
  await waitFor(() => api.policies.size === 2);
  assert.equal(await directRows(page).count(), 2);
  await directRows(page).filter({ hasText: 'Read rows, Create rows, Update rows' }).waitFor();
  assert.equal(await page.evaluate(() => window.loadingSeen), false, 'no loading state replaced the page');
  assert.deepEqual(api.errors, []);
});

test('a failed policy change for yourself says what was not saved and keeps your choices', async t => {
  const { page, api } = await openAccess(t, { failWrite: write => write === 2 });
  await (await savePolicy(page, adminLabel)).waitFor({ state: 'hidden' });
  const dialog = await savePolicy(page, opsLabel, ['Create rows']);
  await dialog
    .getByText(`Your change wasn’t saved. There’s still no policy for Ada on ${opsLabel}. Try again.`, { exact: true })
    .waitFor();
  assert.deepEqual(api.writes, ['admin: table.row.read', 'ops: table.row.read, table.row.create']);
  // The dialog stays open with what the person chose, ready to try again.
  assert.equal(await dialog.getByLabel('Applies to').innerText(), opsLabel);
  assert.equal(await dialog.getByRole('checkbox', { name: 'Read rows', exact: true }).isChecked(), true);
  assert.equal(await dialog.getByRole('checkbox', { name: 'Create rows', exact: true }).isChecked(), true);
  assert.equal(await dialog.getByRole('checkbox', { name: 'Update rows', exact: true }).isChecked(), false);
  assert.equal(await dialog.getByRole('button', { name: 'Add policy' }).isEnabled(), true);
  // Only the saved policy is listed.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await directRows(page).count(), 1);
  assert.deepEqual(api.errors, []);
});

test('each policy change for yourself refreshes table access once, in the background', async t => {
  const { page, api } = await openAccess(t);
  await page.getByRole('tablist', { name: 'Ada’s access' }).waitFor();
  await watchLoading(page, api);
  for (const [table, extra] of [
    [adminLabel, []],
    [opsLabel, []],
    [adminLabel, ['Create rows']],
  ]) {
    await (await savePolicy(page, table, extra)).waitFor({ state: 'hidden' });
    await setTimeout(600);
  }
  await setTimeout(2000);
  const count = suffix => api.reads.filter(path => path.endsWith(suffix)).length;
  assert.equal(count('/google-workspace'), 3, 'table access refreshed once per change');
  assert.equal(count('/governance'), 3, 'workspace access reloaded once per change');
  assert.equal(count(`/members/${memberId}/access`), 3, 'your access reloaded once per change');
  assert.equal(count('/governance/me'), 0, 'your membership was not reloaded');
  assert.equal(count('/v1/workspaces/acme'), 0, 'the workspace was not reloaded');
  assert.equal(await page.evaluate(() => window.loadingSeen), false, 'no loading state replaced the page');
  assert.equal(await directRows(page).count(), 2);
});

test('a policy change while your own table access refreshes is saved', async t => {
  const { page, api } = await openAccess(t, { refreshDelay: 1500 });
  await page.getByRole('tablist', { name: 'Ada’s access' }).waitFor();
  await watchLoading(page, api);
  const refreshing = new Promise(resolve => (api.refreshStarted = resolve));
  await (await savePolicy(page, adminLabel)).waitFor({ state: 'hidden' });
  await refreshing;
  await (await savePolicy(page, opsLabel)).waitFor({ state: 'hidden' });
  await notice(page, `Ada can now read rows in ${opsLabel}.`).waitFor();
  assert.deepEqual(api.writes, ['admin: table.row.read', 'ops: table.row.read']);
  assert.ok(
    api.events.indexOf('PUT ops: table.row.read') < api.events.indexOf('refresh loaded'),
    `the second change was made while the refresh ran: ${api.events}`,
  );
  await waitFor(() => api.events.filter(event => event === 'refresh loaded').length === 2);
  assert.equal(await directRows(page).count(), 2);
  assert.equal(await page.evaluate(() => window.loadingSeen), false);
  assert.deepEqual(api.errors, []);
});

test('access policy controls stay in place while a change saves', async t => {
  const { page } = await openAccess(t);
  const create = page.getByRole('button', { name: 'Create a policy', exact: true }).first();
  await (await savePolicy(page, adminLabel)).waitFor({ state: 'hidden' });
  await notice(page, `Ada can now read rows in ${adminLabel}.`).waitFor();
  const table = page.getByRole('table', { name: 'Access policies for Ada' });
  await create.evaluate(
    (button, table) => {
      window.positions = [];
      const record = () => {
        window.positions.push([button.getBoundingClientRect().top, table.getBoundingClientRect().top]);
        if (!window.stopRecording) requestAnimationFrame(record);
      };
      record();
    },
    await table.elementHandle(),
  );
  const dialog = await savePolicy(page, opsLabel);
  // The page's status line sits under the dialog's overlay, so it is hidden from the accessibility tree.
  await page.locator('[role="status"]', { hasText: 'Saving…' }).waitFor();
  await dialog.waitFor({ state: 'hidden' });
  await notice(page, `Ada can now read rows in ${opsLabel}.`).waitFor();
  const positions = await page.evaluate(() => ((window.stopRecording = true), window.positions));
  assert.deepEqual([...new Set(positions.map(String))], [String(positions[0])]);
});
