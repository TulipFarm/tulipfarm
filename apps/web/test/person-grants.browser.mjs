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

async function openPersonGrants(t, failWrite) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  t.after(async () => {
    if (t.passed === false) await captureBrowserFailure(page, `person-grants-${t.name}`);
    await page.close();
  });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const api = { grants: [], writes: [], errors };
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
