import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  workspaceMemberAccess,
  workspaceMemberFields,
  workspaceMembersDefinition,
} from '@tulipfarm/tables/workspace-members';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';
import { base, membersTableId, revision, tableId, tasksApi, until, workspace } from './tasks.fixture.mjs';

// Tasks and Members never show as tables: their table pages open the Tasks board or the Members page, and the
// Tables list leaves both out.
const server = await startBuiltApp();
const { origin } = server;
const api = tasksApi();
// One person added by hand, with no account.
const carol = '88888888-8888-4888-8888-888888888888';
const carolRecord = {
  id: carol,
  token: '99999999-9999-4999-8999-999999999999',
  values: {
    [workspaceMemberFields.name]: { kind: 'text', value: 'Carol Lee' },
    [workspaceMemberFields.contactEmail]: { kind: 'text', value: 'carol@example.com' },
    [workspaceMemberFields.active]: { kind: 'boolean', value: true },
    [workspaceMemberFields.access]: { kind: 'single-select', optionId: workspaceMemberAccess.none },
  },
};
async function routeMembers(page) {
  await page.route(`**${base}/governance/invitations*`, route =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`**${base}/secrets/capabilities`, route => route.fulfill({ json: { enabled: false } }));
  await page.route(`**${base}/settings`, route =>
    route.fulfill({
      json: { workspaceId: workspace.id, name: workspace.name, slug: workspace.slug, revision: 0, canManage: true },
    }),
  );
  await page.route(`**${base}/workspace-members?*`, route =>
    route.fulfill({
      json: {
        tableId: membersTableId,
        revision,
        sync: { pending: 0, failed: 0, repairRequired: 0 },
        members: [],
        nextCursor: null,
      },
    }),
  );
  await page.route(`**${base}/tables/${membersTableId}`, route =>
    route.fulfill({
      json: {
        id: membersTableId,
        systemKind: 'workspace-members',
        saved: null,
        applied: {
          revision,
          definition: workspaceMembersDefinition(membersTableId, '22222222-2222-4222-8222-222222222222'),
          appliedAt: workspace.createdAt,
        },
        rowPermissions: { create: true, update: true, delete: true },
        canArchive: false,
        archived: false,
      },
    }),
  );
  await page.route(`**${base}/tables/${membersTableId}/rows?*`, route => route.fulfill({ json: [carolRecord] }));
  await page.route(`**${base}/tables/${membersTableId}/rows/page?*`, route =>
    route.fulfill({ json: { records: [carolRecord], total: '1', nextCursor: null } }),
  );
}

let browser;
let page;
try {
  browser = await chromium.launch(builderBrowserOptions());
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const lists = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === `${base}/tables`) lists.push(url.searchParams.get('excludeSystem'));
  });
  await api.route(page);
  await routeMembers(page);

  for (const path of [`/acme/tables/${tableId}`, `/acme/tables/${tableId}/edit`]) {
    await page.goto(`${origin}${path}`);
    await page.waitForURL(`${origin}/acme/tasks`);
    await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  }

  for (const path of [`/acme/tables/${membersTableId}`, `/acme/tables/${membersTableId}/edit`]) {
    await page.goto(`${origin}${path}`);
    await page.waitForURL(`${origin}/acme/members`);
  }
  const people = page.getByRole('table', { name: 'Workspace members', exact: true });
  const carolRow = people.getByRole('row').filter({ has: page.getByText('Carol Lee', { exact: true }) });
  await carolRow.getByText('No account', { exact: true }).waitFor();
  await carolRow.getByRole('link', { name: 'Carol Lee', exact: true }).click();
  await page.waitForURL(`${origin}/acme/members/people/${carol}`);
  await page.getByRole('heading', { name: 'Carol Lee', exact: true }).first().waitFor();

  await page.goto(`${origin}/acme/tables/${membersTableId}?row=${carol}`);
  await page.waitForURL(`${origin}/acme/members/people/${carol}`);
  await page.getByRole('heading', { name: 'Carol Lee', exact: true }).first().waitFor();

  await page.goto(`${origin}/acme/tables`);
  await page.getByText('Customers').first().waitFor();
  await until(() => lists.length > 0, 'The Tables list is read');
  assert.deepEqual([...new Set(lists)], ['tasks,workspace-members'], 'Every table list hides Tasks and Members');
  assert.equal(await page.getByText('Workspace members', { exact: true }).count(), 0, 'Tables leaves Members out');
  assert.equal(await page.getByRole('link', { name: 'Tasks', exact: true }).count(), 1, 'Only the sidebar links Tasks');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Tasks and Members table pages open their own pages, and table lists leave both out.');
} catch (error) {
  console.error('Unmocked API requests:', [...new Set(api.unhandled)]);
  await captureBrowserFailure(page, 'tasks-table-redirect');
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
