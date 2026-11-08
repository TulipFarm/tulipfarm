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
const workspace = {
  id: workspaceId,
  name: 'Acme',
  slug: 'acme',
  createdAt: '2026-09-27T00:00:00.000Z',
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const snapshot = {
  actorMembershipId: memberId,
  adminTeamId,
  members: [{ id: memberId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }],
  directory: [{ id: memberId, name: 'Ada', email: 'ada@example.com', image: null }],
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
  tables: [
    { id: adminTable, name: 'Invoices', owningTeamId: adminTeamId },
    { id: opsTable, name: 'Invoices', owningTeamId: opsTeamId },
  ],
  grants: [],
};

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

async function openPersonGrants(t, failWrite, refreshDelay = 0) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  t.after(async () => {
    if (t.passed === false) await captureBrowserFailure(page, `person-grants-${t.name}`);
    await page.close();
  });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const api = { grants: [], writes: [], errors, watching: false, refreshes: 0, events: [] };
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // Reloading table authority refetches workspace integrations; access listeners then reload the workspace.
    if (api.watching && request.method() === 'GET' && path.endsWith('/google-workspace')) {
      api.events.push('refresh started');
      api.refreshStarted?.();
      await setTimeout(refreshDelay);
      api.events.push('refresh loaded');
    }
    if (api.watching && request.method() === 'GET' && path === '/v1/workspaces/acme') api.refreshes += 1;
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
    else if (path.endsWith('/governance')) json = snapshot;
    else if (path.endsWith('/governance/person-grants') && request.method() === 'PUT') {
      const body = request.postDataJSON();
      api.writes.push(body.target.permission);
      api.events.push(`PUT ${body.target.permission}`);
      await setTimeout(300);
      if (failWrite?.(api.writes.length))
        return route.fulfill({ status: 503, json: { error: 'workspace-unavailable' } });
      api.grants.push({ membershipId: body.membershipId, target: body.target });
      json = { ok: true };
    } else if (path.endsWith('/governance/person-grants')) json = { grants: api.grants };
    else return route.fulfill({ status: 404, json: { error: 'unavailable' } });
    await route.fulfill({ json });
  });
  await page.goto(`${app.origin}/acme/grants`);
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Individual table grants', exact: true }) });
  await section.getByLabel('Person receiving access').click();
  await page.getByRole('option', { name: 'Ada (ada@example.com)', exact: true }).click();
  const checkbox = permission => section.locator(`[id="person-${adminTable}-table.${permission}"]`);
  await checkbox('row.read').waitFor();
  // Toggle with the keyboard; the sticky sidebar header can sit over a pointer target.
  const toggle = async permission => {
    await checkbox(permission).focus();
    await page.keyboard.press('Space');
  };
  return { page, section, checkbox, toggle, api, mounted: await section.elementHandle() };
}

// Record whether the table list was ever replaced by its loading state.
async function watchLoading(page, api) {
  api.watching = true;
  await page.evaluate(() => {
    window.loadingSeen = false;
    const check = () => {
      if (
        document.querySelector('[aria-label="Loading tables"]') ||
        document.body.innerText.includes('Loading tables…')
      )
        window.loadingSeen = true;
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

test('the individual section labels a table owned by the admin team as Workspace admins', async t => {
  const { section } = await openPersonGrants(t);
  await section.getByText(`Invoices · Workspace admins · ${adminTable.slice(0, 8)}`, { exact: true }).waitFor();
  await section.getByText(`Invoices · Operations · ${opsTable.slice(0, 8)}`, { exact: true }).waitFor();
  assert.equal(await section.getByText(`Team ${adminTeamId.slice(0, 8)}`).count(), 0);
});

test('quick grants for yourself all save in order without reloading workspace access', async t => {
  const { page, section, checkbox, toggle, api, mounted } = await openPersonGrants(t);
  for (const permission of ['row.read', 'row.create', 'row.update']) await toggle(permission);
  await section.getByRole('status').filter({ hasText: 'Individual grant saved.' }).waitFor();
  assert.deepEqual(api.writes, ['table.row.read', 'table.row.create', 'table.row.update']);
  assert.equal(await mounted.evaluate(element => element.isConnected), true, 'the section was not reloaded');
  assert.equal(await section.getByLabel('Person receiving access').innerText(), 'Ada (ada@example.com)');
  for (const permission of ['row.read', 'row.create', 'row.update'])
    assert.equal(await checkbox(permission).isChecked(), true, permission);
  assert.equal(await page.getByText('Loading workspace access…').count(), 0);
  assert.deepEqual(api.errors, []);
});

test('a failed grant for yourself says how many queued changes were not saved', async t => {
  const { section, checkbox, toggle, api, mounted } = await openPersonGrants(t, write => write === 2);
  for (const permission of ['row.read', 'row.create', 'row.update']) await toggle(permission);
  await section.getByRole('status').filter({ hasText: '1 other change was not saved.' }).waitFor();
  assert.deepEqual(api.writes, ['table.row.read', 'table.row.create']);
  assert.equal(await mounted.evaluate(element => element.isConnected), true);
  assert.equal(await checkbox('row.read').isChecked(), true);
  assert.equal(await checkbox('row.create').isChecked(), false);
  assert.equal(await checkbox('row.update').isChecked(), false);
});

test('several grants for yourself refresh table access once, in the background', async t => {
  const { page, section, checkbox, toggle, api } = await openPersonGrants(t);
  await watchLoading(page, api);
  for (const permission of ['row.read', 'row.create', 'row.update']) {
    await toggle(permission);
    await section.getByRole('status').filter({ hasText: 'Individual grant saved.' }).waitFor();
    await setTimeout(600);
  }
  await waitFor(() => api.refreshes > 0);
  await setTimeout(2500);
  assert.equal(api.refreshes, 1);
  assert.equal(await page.evaluate(() => window.loadingSeen), false, 'the table list never showed Loading tables…');
  for (const permission of ['row.read', 'row.create', 'row.update'])
    assert.equal(await checkbox(permission).isChecked(), true, permission);
});

test('a click while your own access refreshes is queued and saved', async t => {
  const { page, section, checkbox, toggle, api } = await openPersonGrants(t, undefined, 1000);
  await watchLoading(page, api);
  const read = section.getByRole('checkbox', { name: 'Read rows', exact: true }).first();
  await read.evaluate(element => element.scrollIntoView({ block: 'center' }));
  const box = await read.boundingBox();
  await toggle('row.create');
  await new Promise(resolve => (api.refreshStarted = resolve));
  // Click where the checkbox was, as a person would while the refresh is running.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitFor(() => api.writes.length === 2);
  await section.getByRole('status').filter({ hasText: 'Individual grant saved.' }).waitFor();
  assert.deepEqual(api.writes, ['table.row.create', 'table.row.read']);
  assert.ok(
    api.events.indexOf('PUT table.row.read') > api.events.indexOf('refresh loaded'),
    `the click waited for the refresh: ${api.events}`,
  );
  assert.equal(await checkbox('row.read').isChecked(), true);
  assert.equal(await page.evaluate(() => window.loadingSeen), false);
});

test('individual grant checkboxes stay in place while a change saves', async t => {
  const { page, section, toggle } = await openPersonGrants(t);
  const read = section.getByRole('checkbox', { name: 'Read rows', exact: true }).first();
  await read.evaluate(element => {
    window.positions = [];
    const record = () => {
      window.positions.push(element.getBoundingClientRect().top);
      if (!window.stopRecording) requestAnimationFrame(record);
    };
    record();
  });
  await toggle('row.create');
  await section.getByRole('status').filter({ hasText: 'Individual grant saved.' }).waitFor();
  const positions = await page.evaluate(() => ((window.stopRecording = true), window.positions));
  assert.deepEqual([...new Set(positions)], [positions[0]]);
});
