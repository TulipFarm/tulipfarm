import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { normalizeQueryRequest } from '@tulipfarm/tables/query';
import { governanceSnapshotSchema } from '@tulipfarm/workspaces/governance-contracts';
import { catalogFamily } from '../src/features/models/catalog-fixture.ts';
import { modelOption } from './browser-controls.mjs';

const port = Number(process.env.CLARITY_PORT ?? 5327);
const origin = `http://127.0.0.1:${port}`;
const before = process.env.CLARITY_BEFORE === '1';
const capture = process.env.CLARITY_SCREENSHOTS;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
});
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-09-30T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const memberId = '22222222-2222-4222-8222-222222222222';
const teamId = '33333333-3333-4333-8333-333333333333';
const otherTeamId = '44444444-4444-4444-8444-444444444444';
const tableId = '55555555-5555-4555-8555-555555555555';
const fieldId = '66666666-6666-4666-8666-666666666666';
const notesId = '77777777-7777-4777-8777-777777777777';
const recordId = '88888888-8888-4888-8888-888888888888';
const agentId = '99999999-9999-4999-8999-999999999999';
const teams = [
  {
    id: teamId,
    name: 'Operations',
    description: 'Daily customer operations',
    membershipIds: [memberId],
    managerIds: [memberId],
    canManage: true,
    canLeave: true,
  },
  {
    id: otherTeamId,
    name: 'Support',
    description: 'Customer support',
    membershipIds: [],
    managerIds: [],
    canManage: true,
    canLeave: false,
  },
];
const revision = 'a'.repeat(40);
const definition = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: teamId,
  label: 'Customers',
  fields: [
    { id: fieldId, label: 'Customer name', kind: 'text', required: false, maxLength: 200 },
    { id: notesId, label: 'Notes', kind: 'text', required: false, maxLength: 1000 },
  ],
  uniqueKeys: [],
};
const notes =
  'Call Morgan before renewing the annual agreement. Include the regional offices in the updated proposal and confirm the billing address.';
const row = (id, name, note) => ({
  id,
  token: id,
  values: { [fieldId]: { kind: 'text', value: name }, ...(note ? { [notesId]: { kind: 'text', value: note } } : {}) },
});
const rowPages = {
  first: { records: [row(recordId, 'Northwind Traders', notes)], nextCursor: 'rows-page-2' },
  'rows-page-2': { records: [row('cccccccc-cccc-4ccc-8ccc-000000000002', 'Contoso')], nextCursor: 'rows-page-3' },
  'rows-page-3': { records: [row('cccccccc-cccc-4ccc-8ccc-000000000003', 'Fabrikam')], nextCursor: null },
};
// Table list rows carry appliedAt and recordCount (cloud 7e345588 #844, apps/web/src/features/tables/api.ts:11).
const listed = (id, label) => ({
  id,
  revision,
  definition: { ...definition, id, label },
  appliedAt: workspace.createdAt,
  recordCount: '3',
});
const contactsId = 'dddddddd-dddd-4ddd-8ddd-000000000002',
  archiveId = 'dddddddd-dddd-4ddd-8ddd-000000000003';
const tablePagesByCursor = {
  first: { tables: [listed(tableId, 'Customers')], nextCursor: tableId },
  [tableId]: { tables: [listed(contactsId, 'Customer contacts')], nextCursor: contactsId },
  [contactsId]: { tables: [listed(archiveId, 'Customer archive')], nextCursor: null },
};
const family = (id, displayName, provider) =>
  catalogFamily(id, {
    displayName,
    provider,
    currentVersion: `${id}-v1`,
    inputCreditsPerMillionTokens: 300,
    outputCreditsPerMillionTokens: 1500,
    mappingRevision: 'mapping-1',
    pricingRevision: 'pricing-1',
  });
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
  browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port + 4000}`] });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
      colorScheme: mobile ? 'dark' : 'light',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('dialog', dialog => {
      void dialog.accept().catch(() => {});
    });
    page.on('console', message => {
      if (message.type() === 'error') console.error(message.text());
    });
    let readOnly = false;
    let listFailure = false;
    const rowCursors = [];
    const tablePages = [];
    const agentPages = [];
    const grants = [];
    const grantWrites = [];
    const tableSearches = [];
    await page.route('**/v1/**', async route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      let json;
      if (path === '/v1/auth/get-session')
        json = {
          session: { id: 'session-ada', userId: 'ada' },
          user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
        };
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === '/v1/workspaces/acme') json = workspace;
      // Bud reads its state on every workspace page since cloud 5c797036 (#982); unanswered, its error alert covers the mobile page footer.
      else if (path.endsWith('/bud'))
        json = {
          conversationId: null,
          onboarding: 'skipped',
          bubblesEnabled: false,
          snoozedUntil: null,
          nudge: null,
          preferences: [],
        };
      else if (path.endsWith('/credits'))
        json = { available: 0, granted: 1000, used: 1000, held: 0, days: [], breakdown: [], series: [] };
      else if (path.endsWith('/settings'))
        json = { workspaceId: workspace.id, name: workspace.name, slug: workspace.slug, revision: 1, canManage: true };
      else if (path.endsWith('/personal-memory'))
        json = { content: 'Use concise answers and include next steps.', revision: 1 };
      else if (path.endsWith('/model-catalog'))
        json = {
          families: [
            family('claude-sonnet', 'Claude Sonnet', 'anthropic'),
            family('gemini-flash', 'Gemini Flash', 'google'),
          ],
        };
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: memberId,
          role: 'admin',
          teams,
          capabilities: { manageGovernance: true, canLeave: true },
        };
      else if (path.endsWith('/governance/person-grants')) json = { grants: [] };
      else if (path.endsWith('/governance'))
        json = governanceSnapshotSchema.parse({
          actorMembershipId: memberId,
          members: [{ id: memberId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }],
          teams,
          directory: [{ id: memberId, name: 'Ada', email: 'ada@example.com', image: null }],
          tableTeamIds: [teamId, otherTeamId],
          tables: [{ id: tableId, name: 'Customers', owningTeamId: teamId }],
          grants,
        });
      else if (path.endsWith('/governance/grants')) {
        const input = route.request().postDataJSON();
        grantWrites.push(input);
        if (input.granted) grants.push({ teamId: input.teamId, target: input.target });
        json = { ok: true };
      } else if (path.endsWith(`/tables/${tableId}`))
        json = {
          id: tableId,
          saved: null,
          applied: { revision, definition, appliedAt: workspace.createdAt },
          rowPermissions: { create: !readOnly, update: !readOnly, delete: !readOnly },
        };
      else if (path.endsWith(`/tables/${tableId}/deleted-rows`)) json = { records: [], nextCursor: null };
      else if (path.endsWith(`/tables/${tableId}/rows/${recordId}/history`)) json = [];
      else if (path.endsWith('/tables')) {
        const cursor = url.searchParams.get('after');
        tablePages.push(cursor);
        tableSearches.push(url.searchParams.get('search'));
        if (listFailure) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
        json = tablePagesByCursor[cursor ?? 'first'];
      } else if (route.request().method() === 'POST' && path.endsWith(`/tables/${tableId}/query`)) {
        const body = route.request().postDataJSON();
        assert.equal(body.revision, revision);
        const normalized = normalizeQueryRequest(definition, body.request);
        rowCursors.push(normalized.query.after ?? null);
        const current = rowPages[normalized.query.after ?? 'first'];
        json = {
          mode: 'rows',
          ...normalized,
          references: {},
          records: current.records,
          total: normalized.query.after ? null : '3',
          nextCursor: current.nextCursor,
        };
      } else if (path.endsWith('/agents/authoring-context'))
        json = { currentSoulRevision: 'a'.repeat(40), teams: [], admin: false };
      else if (path.endsWith('/agents')) {
        const cursor = url.searchParams.get('after');
        agentPages.push(cursor);
        json = {
          agents: Array.from({ length: cursor === otherTeamId ? 1 : 25 }, (_, index) => ({
            id: index === 0 ? agentId : `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
            name: index === 0 ? 'Customer reviewer' : `Operations agent ${index + (cursor ? 25 : 0)}`,
            owningTeamId: teamId,
            savedRevision: 'a'.repeat(40),
            definitionRevision: 'b'.repeat(64),
          })),
          count: 51,
          nextCursor: cursor === otherTeamId ? null : cursor ? otherTeamId : agentId,
        };
      } else if (/\/agents\/[a-f0-9-]+$/.test(path))
        json = {
          id: path.split('/').at(-1),
          name: 'Customer reviewer',
          owningTeamId: teamId,
          savedRevision: 'a'.repeat(40),
          definitionRevision: 'b'.repeat(64),
          definition: {
            name: 'Customer reviewer',
            instructions: 'Review customer requests and prepare follow-up notes.',
            tools: ['schema.inspect'],
          },
          capabilities: ['read'],
          admin: false,
          activations: [],
        };
      else if (path.endsWith('/conversations'))
        json = {
          chats: url.searchParams.get('search')
            ? []
            : [
                {
                  id: agentId,
                  title: 'Plan customer follow-ups',
                  titleRevision: 0,
                  archived: false,
                  activityAt: workspace.createdAt,
                  createdAt: workspace.createdAt,
                },
              ],
          nextCursor: null,
        };
      else return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      await route.fulfill({ json });
    });
    async function screenshot(name) {
      if (!capture) return;
      await page.evaluate(() => document.fonts.ready);
      execFileSync(
        'agent-browser',
        [
          '--session',
          `p1-clarity-${port}`,
          '--no-auto-dialog',
          '--cdp',
          String(port + 4000),
          'screenshot',
          `${capture}/${before ? 'before' : 'after'}-${mobile ? 'mobile' : 'desktop'}-${name}.png`,
        ],
        { stdio: 'inherit' },
      );
    }
    await page.goto(`${origin}/acme`);
    await page
      .getByRole('combobox', { name: 'Model: Claude Sonnet', exact: true })
      .click()
      .catch(async error => {
        console.error(await page.locator('body').innerText(), errors);
        throw error;
      });
    await page.getByRole('option', { name: /Claude Sonnet/ }).waitFor();
    await screenshot('selection');
    if (!before) {
      assert.equal(await modelOption(page, 'Claude Sonnet').getAttribute('aria-selected'), 'true');
      if (mobile)
        for (const row of await page.getByRole('option').all()) assert.ok((await row.boundingBox()).height >= 44);
      await page.getByRole('combobox', { name: 'Search models' }).fill('Gemini');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.getByRole('combobox', { name: 'Model: Gemini Flash', exact: true }).waitFor();
    }
    await page.keyboard.press('Escape');
    const rows = page
      .locator('section')
      .filter({ has: page.getByRole('region', { name: 'Customers rows', exact: true }) })
      .last();
    // Row action names use the row's leading values, so find the button inside the Northwind row.
    const rowActions = () =>
      rows
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: 'Northwind Traders', exact: true }) })
        .getByRole('button', { name: /^Actions for Northwind Traders/ });
    const rowAction = async item => {
      await rowActions().click();
      await page.getByRole('menuitem', { name: item, exact: true }).click();
    };
    const rowMenu = async () => {
      await rowActions().click();
      await page.getByRole('menuitem').first().waitFor();
      const items = await page.getByRole('menuitem').allTextContents();
      await page.keyboard.press('Escape');
      await page.getByRole('menu').waitFor({ state: 'detached' });
      return items;
    };
    await page.goto(`${origin}/acme/tables/${tableId}`);
    await rows
      .getByRole('cell', { name: 'Northwind Traders', exact: true })
      .waitFor()
      .catch(async error => {
        console.error(await page.locator('body').innerText());
        throw error;
      });
    await screenshot('records');
    if (!before) {
      await page.getByRole('heading', { level: 1, name: 'Customers', exact: true }).waitFor();
      assert.equal(await page.title(), 'Customers · TulipFarm');
      assert.equal(
        await page
          .getByRole('navigation', { name: 'Breadcrumb', exact: true })
          .getByRole('link', { name: 'Tables', exact: true })
          .getAttribute('href'),
        '/acme/tables',
      );
      assert.equal(
        await page.getByRole('link', { name: 'Change fields in chat', exact: true }).getAttribute('href'),
        `/acme?intent=edit-table&tableId=${tableId}`,
      );
      await rows.getByRole('button', { name: 'Sort by Customer name', exact: true }).waitFor();
      const noteCell = rows.getByRole('cell', { name: notes, exact: true });
      assert.equal(
        await noteCell.locator('span[title]').getAttribute('title'),
        notes,
        'A truncated value keeps its full text available',
      );
      assert.deepEqual(await rowMenu(), ['Edit row', 'History', 'Delete row']);
      await rowAction('Edit row');
      assert.equal(await page.getByLabel('Notes', { exact: true }).inputValue(), notes);
      await screenshot('record-details');
      await page.getByRole('button', { name: 'Discard edits', exact: true }).click();
      await page.getByLabel('Notes', { exact: true }).waitFor({ state: 'detached' });
      await rowAction('Delete row');
      const confirmDelete = page.getByRole('alertdialog', { name: `Delete row ${recordId.slice(0, 8)}?`, exact: true });
      await confirmDelete.getByText(/recoverable for 30 days from Deleted rows in the ⋯ menu/).waitFor();
      await confirmDelete.getByRole('button', { name: 'Keep row', exact: true }).click();
      await confirmDelete.waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'More table options', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Deleted rows', exact: true }).click();
      const deletedRows = page.getByRole('dialog', { name: 'Deleted rows', exact: true });
      await deletedRows.getByText('Deleted rows stay recoverable for 30 days.', { exact: true }).waitFor();
      await deletedRows.getByText('No deleted rows on this page', { exact: true }).waitFor();
      await deletedRows.getByRole('button', { name: 'Close', exact: true }).click();
      await deletedRows.waitFor({ state: 'detached' });
      readOnly = true;
      await page.reload();
      await rows.getByRole('cell', { name: 'Northwind Traders', exact: true }).waitFor();
      assert.deepEqual(await rowMenu(), ['History'], 'Read-only rows offer only actions the member can take');
      assert.equal(await rows.getByRole('button', { name: 'Add row', exact: true }).count(), 0);
      await rowAction('History');
      const history = page.getByRole('region', { name: 'Row history', exact: true });
      await history.getByRole('heading', { name: `History for row ${recordId}`, exact: true }).waitFor();
      await history.getByRole('button', { name: 'Close history', exact: true }).click();
      await history.waitFor({ state: 'detached' });
      readOnly = false;
      const rowNavigation = rows.getByRole('navigation', { name: 'Row pages', exact: true });
      assert.equal(await rowNavigation.getByRole('button', { name: 'Previous rows', exact: true }).isDisabled(), true);
      await rowNavigation.getByRole('button', { name: 'Next rows', exact: true }).click();
      await rows.getByRole('cell', { name: 'Contoso', exact: true }).waitFor();
      await rowNavigation.getByRole('button', { name: 'Next rows', exact: true }).click();
      await rows.getByRole('cell', { name: 'Fabrikam', exact: true }).waitFor();
      assert.equal(await rowNavigation.getByRole('button', { name: 'Next rows', exact: true }).isDisabled(), true);
      await rowNavigation.getByRole('button', { name: 'Previous rows', exact: true }).click();
      await rows.getByRole('cell', { name: 'Contoso', exact: true }).waitFor();
      assert.deepEqual(
        [...new Set(rowCursors)],
        [null, 'rows-page-2', 'rows-page-3'],
        'Row pages read only the cursors the server issued',
      );
      await page.goto(`${origin}/acme/tables`);
      await page.getByRole('heading', { level: 1, name: 'Tables', exact: true }).waitFor();
      await page.getByRole('searchbox', { name: 'Search tables' }).fill('Customer');
      await page.waitForURL(url => url.searchParams.get('q') === 'Customer');
      const tableList = page.getByRole('list', { name: /^Tables, \d+ rows?$/ });
      await tableList.getByRole('listitem', { name: 'Customers', exact: true }).waitFor();
      const resources = page.getByRole('navigation', { name: 'Table pages' });
      assert.equal(await resources.getByRole('button', { name: 'Previous tables', exact: true }).isDisabled(), true);
      await resources.getByRole('button', { name: 'Next tables', exact: true }).click();
      await tableList.getByRole('listitem', { name: 'Customer contacts', exact: true }).waitFor();
      await resources.getByRole('button', { name: 'Next tables', exact: true }).click();
      await tableList.getByRole('listitem', { name: 'Customer archive', exact: true }).waitFor();
      assert.equal(await resources.getByRole('button', { name: 'Next tables', exact: true }).isDisabled(), true);
      await resources.getByRole('button', { name: 'Previous tables', exact: true }).click();
      await tableList.getByRole('listitem', { name: 'Customer contacts', exact: true }).waitFor();
      assert.equal(await page.getByRole('searchbox', { name: 'Search tables' }).inputValue(), 'Customer');
      assert.deepEqual(
        [...new Set(tablePages.slice(tableSearches.indexOf('Customer')))],
        [null, tableId, contactsId],
        'Table pages read only the cursors the server issued',
      );
      assert.equal(tableSearches.at(-1), 'Customer', 'Table pages keep the search');
      listFailure = true;
      await page.evaluate(
        ({ workspaceId, membershipId }) => {
          const channel = new BroadcastChannel('tulipfarm:query:v1');
          channel.postMessage({
            version: 1,
            id: crypto.randomUUID(),
            sessionId: 'session-ada',
            scope: { kind: 'workspace', userId: 'ada', workspaceId, membershipId },
            kind: 'change',
            keys: [['tables', 'list']],
          });
          channel.close();
        },
        { workspaceId: workspace.id, membershipId: memberId },
      );
      await page.getByRole('button', { name: 'Retry refresh' }).waitFor();
      await page.getByText(/The last loaded data is still shown\./).waitFor();
      await tableList.getByRole('listitem', { name: 'Customer contacts', exact: true }).waitFor();
      listFailure = false;
      await page.getByRole('button', { name: 'Retry refresh' }).click();
      await page.getByRole('button', { name: 'Retry refresh' }).waitFor({ state: 'detached' });
      await page.goto(`${origin}/acme/tables/${tableId}/edit`);
      await page.getByRole('heading', { level: 1, name: 'Change table fields', exact: true }).waitFor();
      await page.getByText('Build tables in chat', { exact: true }).waitFor();
      assert.equal(await page.getByText(tableId).count(), 0, 'The edit handoff does not ask people to copy a table ID');
      assert.equal(
        await page.getByRole('link', { name: 'Change fields in chat', exact: true }).getAttribute('href'),
        `/acme?intent=edit-table&tableId=${tableId}`,
      );
      await page.getByRole('link', { name: 'Back to tables', exact: true }).click();
      await page.waitForURL(`${origin}/acme/tables`);
      await page.getByRole('heading', { level: 1, name: 'Tables', exact: true }).waitFor();
      await page.goto(`${origin}/acme/grants`);
      await page.getByRole('combobox', { name: 'Team receiving access' }).click();
      await page.getByRole('option', { name: 'Operations', exact: true }).click();
      if (mobile)
        assert.ok((await page.getByRole('combobox', { name: 'Team receiving access' }).boundingBox()).height >= 44);
      await page.getByText('Changes save immediately. There is no separate Save button.').waitFor();
      await page.getByRole('checkbox', { name: 'Create rows', exact: true }).click();
      await page.getByText('Create rows for Customers granted to Operations.', { exact: true }).waitFor();
      assert.equal(grantWrites.length, 1);
      assert.equal(await page.getByRole('checkbox', { name: 'Read rows', exact: true }).isChecked(), false);
    }
    await page.goto(`${origin}/acme/chat`);
    await page.getByRole('region', { name: 'Chat list' }).waitFor();
    await page.getByRole('button', { name: 'Plan customer follow-ups', exact: true }).waitFor();
    await screenshot('chats');
    if (!before) await page.getByRole('textbox', { name: 'Search chat titles' }).waitFor();
    await page.goto(`${origin}/acme/agents`);
    await page.getByText('Customer reviewer', { exact: true }).waitFor();
    if (!before) {
      await page.getByRole('searchbox', { name: 'Find agents', exact: true }).fill('Customer reviewer');
      await page
        .getByRole('row')
        .filter({ hasText: 'Customer reviewer' })
        .getByRole('cell', { name: 'Not activated', exact: true })
        .waitFor();
      const agents = page.getByRole('navigation', { name: 'Agent pages' });
      await agents.getByRole('button', { name: 'Next page' }).click();
      await agents.getByText('Page 2', { exact: true }).waitFor();
      await agents.getByRole('button', { name: 'Next page' }).click();
      await agents.getByText('Page 3', { exact: true }).waitFor();
      await agents.getByRole('button', { name: 'Previous page' }).click();
      await agents.getByText('Page 2', { exact: true }).waitFor();
      await page.getByText('Operations agent 26', { exact: true }).waitFor();
      assert.deepEqual(
        [...new Set(agentPages.filter(Boolean))],
        [agentId, otherTeamId],
        'Pages read only the cursors the server issued',
      );
      assert.equal(
        await page.getByRole('searchbox', { name: 'Find agents', exact: true }).inputValue(),
        'Customer reviewer',
      );
    }
    await screenshot('agents');
    await page.goto(`${origin}/acme/teams`);
    await page.getByRole('button', { name: 'View Operations details' }).click();
    await page.getByRole('heading', { name: 'Operations details' }).waitFor();
    await page.getByLabel('Description (optional)', { exact: true }).last().fill('Retained team draft');
    await screenshot('team-edits');
    if (!before) {
      await page.getByRole('button', { name: 'View Support details' }).click();
      await page.getByRole('button', { name: 'Keep editing' }).click();
      assert.equal(
        await page.getByLabel('Description (optional)', { exact: true }).last().inputValue(),
        'Retained team draft',
      );
      if (mobile) await page.getByRole('button', { name: 'Toggle Sidebar', exact: true }).first().click();
      // The settings sidebar navigation is named Settings (cloud 0461cae5 #858, apps/web/src/pages/workspace.tsx:271).
      await page.getByRole('navigation', { name: 'Settings' }).getByText('General', { exact: true }).click();
      await page.getByRole('button', { name: 'Keep editing' }).click();
      assert.equal(
        await page.getByLabel('Description (optional)', { exact: true }).last().inputValue(),
        'Retained team draft',
      );
      await page.getByRole('button', { name: 'Close details' }).click();
      await page.getByRole('button', { name: 'Discard edits' }).click();
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === 'View Operations details',
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'View Operations details' })
          .evaluate(node => node === document.activeElement),
        true,
      );
    }
    await page.goto(`${origin}/acme/settings`);
    if (!before) {
      await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
      await page.getByRole('dialog').getByText('Rows, files, and backups are retained.', { exact: true }).waitFor();
      if (mobile) {
        await page.setViewportSize({ width: 390, height: 450 });
        await page.getByRole('button', { name: 'Close workspace for everyone' }).scrollIntoViewIfNeeded();
        const box = await page.getByRole('button', { name: 'Close workspace for everyone' }).boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= 450);
      }
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
