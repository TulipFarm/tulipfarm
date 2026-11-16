import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { googleAppScopes, googleIdentityScopes } from '@tulipfarm/google-workspace/public-contracts';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

test('the integrations directory lists every app with one action per row', { timeout: 180000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    envDir: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch({ headless: true }).catch(async error => {
    await server.close();
    throw error;
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const { workspace, session } = createWorkspaceFixture({ slug: 'directory-proof', name: 'Directory' });
  const base = `/v1/workspaces/${workspace.id}`;
  const shell = new Map(workspaceShellReads(workspace.id));
  const catalogSearches = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const scopes = [...googleIdentityScopes, ...Object.values(googleAppScopes).flat()];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin && !url.pathname.startsWith('/v1/')) return route.abort();
    if (!url.pathname.startsWith('/v1/')) return route.continue();
    if (await serveWorkspaceShellEvent(route, workspace)) return;
    const path = url.pathname;
    let json;
    if (path === '/v1/auth/get-session') json = session;
    else if (path === '/v1/user/visit') json = { firstSession: false };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: workspace.id,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: true },
      };
    else if (path === '/v1/google-workspace/availability') json = { configured: true };
    else if (path === `${base}/google-workspace`)
      json = {
        status: 'connected',
        integrationId: randomUUID(),
        generation: 1,
        accountId: 'google-ada',
        email: 'ada@example.test',
        scopes,
      };
    else if (path === `${base}/github/accounts`)
      json = {
        configured: true,
        accounts: [
          {
            id: randomUUID(),
            configured: true,
            state: 'reconnect-required',
            generation: 1,
            scopes: ['repo'],
            identity: { id: '42', login: 'ada' },
          },
        ],
      };
    else if (path === `${base}/slack/status`)
      json = { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] };
    else if (path === `${base}/atlassian/accounts`)
      json = { accounts: [], providers: ['atlassian-mcp', 'trello'].map(protocol => ({ protocol, configured: true })) };
    else if (path === `${base}/workspace-mcp/capabilities`)
      json = { enabled: true, canManageShared: true, integrationsEnabled: true, dispatchEnabled: false };
    else if (path === `${base}/workspace-mcp/integrations`) json = { integrations: [] };
    else if (path === `${base}/workspace-mcp/catalog`) {
      catalogSearches.push(url.searchParams.get('search'));
      json = {
        source: 'Official MCP Registry',
        snapshotVersion: '1',
        syncedAt: null,
        stale: false,
        entries: [
          {
            id: 'ledger',
            name: 'io.github.ada/ledger-tools',
            description: 'double-entry books for small teams',
            version: '1.0.0',
            endpoint: 'https://ledger.example.test/mcp',
            package: null,
            compatibility: 'eligible',
            reason: null,
            authentication: 'oauth',
          },
        ],
        nextCursor: null,
      };
    } else if (path.endsWith('/integrations')) json = { integrations: [] };
    else if (shell.has(path)) json = shell.get(path);
    else return route.fulfill({ status: 404, json: { error: 'not-found' } });
    return route.fulfill({ json });
  });

  const tab = name => page.getByRole('tab', { name });
  const row = name => page.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) });
  const count = async view => Number((await tab(new RegExp(`^${view} \\d+$`)).innerText()).match(/\d+$/)[0]);
  const rows = page
    .getByRole('region', { name: /^(Apps|Search results)$/ })
    .locator('ul')
    .first()
    .getByRole('listitem');
  const search = page.getByRole('searchbox', { name: 'Search apps', exact: true });

  try {
    await page.goto(`${origin}/${workspace.slug}/integrations`);
    // The first visit waits for Vite to transform the whole app on a cold server.
    await tab('Needs attention 1').waitFor({ timeout: 90000 });

    await t.test('tabs count the apps in each state and filter the list', async () => {
      const [all, connected, available] = [await count('All'), await count('Connected'), await count('Available')];
      assert.equal(connected, 6, 'every granted Google app is connected');
      assert.ok(all >= connected + 1 + available, 'All includes every other tab');
      assert.equal(await tab(/^All /).getAttribute('aria-selected'), 'true');
      // Apps that need attention come first, then connected ones.
      assert.equal(await rows.first().getByRole('link').first().innerText(), 'GitHub');
      await tab(/^Connected /).click();
      await page.waitForURL(/\?view=connected$/);
      // The address changes before the list renders again.
      await rows.nth(connected).waitFor({ state: 'detached' });
      assert.equal(await rows.count(), connected);
      await tab(/^Needs attention /).click();
      await page.waitForURL(/\?view=attention$/);
      await rows.nth(1).waitFor({ state: 'detached' });
      assert.equal(await rows.count(), 1);
      await tab(/^All /).click();
      await page.waitForURL(url => !url.search);
    });

    await t.test('the view comes from the address, including older links', async () => {
      await page.goto(`${origin}/${workspace.slug}/integrations?view=attention`);
      await tab('Needs attention 1').waitFor();
      assert.equal(await tab(/^Needs attention /).getAttribute('aria-selected'), 'true');
      await page.goto(`${origin}/${workspace.slug}/integrations?view=yours`);
      await tab('Connected 6').waitFor();
      assert.equal(await tab(/^Connected /).getAttribute('aria-selected'), 'true');
      await page.goto(`${origin}/${workspace.slug}/integrations?view=email-and-calendar`);
      await tab('Needs attention 1').waitFor();
      assert.equal(await tab(/^All /).getAttribute('aria-selected'), 'true');
    });

    await t.test('while searching, the counts are of the matching apps', async () => {
      await search.fill('google');
      // Gmail doesn't say Google; the other five Google apps do.
      await tab('Connected 5').waitFor();
      assert.equal(await count('Needs attention'), 0);
      assert.equal(await count('All'), await rows.count());
      await search.fill('');
      await tab('Needs attention 1').waitFor();
    });

    await t.test('connected apps configure, apps needing attention reconnect, and none disconnect here', async () => {
      await row('Gmail').getByRole('link', { name: 'Configure Gmail', exact: true }).waitFor();
      await row('Gmail').getByText('ada@example.test', { exact: true }).waitFor();
      await row('GitHub').getByRole('button', { name: 'Reconnect GitHub', exact: true }).waitFor();
      await row('Jira').getByRole('button', { name: 'Connect Jira', exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('main')
          .getByRole('button', { name: /Disconnect/ })
          .count(),
        0,
      );
      assert.equal(
        await page
          .getByRole('main')
          .getByRole('link', { name: /Disconnect/ })
          .count(),
        0,
      );
    });

    await t.test('clicking a row opens the app’s page, and its action stays a separate control', async () => {
      const box = await row('Google Drive').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height - 8);
      await page.waitForURL(`${origin}/${workspace.slug}/integrations/google-drive`);
      await page.goBack();
      await row('Gmail').getByRole('link', { name: 'Configure Gmail', exact: true }).click();
      await page.waitForURL(`${origin}/${workspace.slug}/integrations/gmail`);
      await page.goBack();
      await tab('Needs attention 1').waitFor();
    });

    await t.test('apps that are coming soon show a label, not a button', async () => {
      // Discord has no official MCP server to list instead.
      const discord = page.getByRole('listitem').filter({ hasText: 'Discord' });
      await discord.getByText('Soon', { exact: true }).waitFor();
      assert.equal(await discord.getByRole('button').count(), 0);
      assert.equal(await discord.getByRole('link').count(), 0);
    });

    await t.test('an app that can’t be connected explains why on hover and on focus', async () => {
      const reason = 'Ask an integration manager for Slack access.';
      const label = row('Slack').getByText('Ask an admin', { exact: true });
      await label.hover();
      await page.getByRole('tooltip').getByText(reason).waitFor();
      await page.mouse.move(0, 0);
      await page.getByRole('tooltip').waitFor({ state: 'detached' });
      await row('Slack').getByRole('link', { name: 'Slack', exact: true }).focus();
      await page.keyboard.press('Tab');
      assert.equal(await label.evaluate(element => element.closest('[tabindex]') === document.activeElement), true);
      await page.getByRole('tooltip').getByText(reason).waitFor();
      const description = await page.evaluate(() =>
        document.activeElement
          .getAttribute('aria-describedby')
          .split(' ')
          .map(id => document.getElementById(id)?.textContent.trim()),
      );
      assert.ok(description.includes(reason));
      await page.keyboard.press('Escape');
    });

    await t.test('community servers show only while searching', async () => {
      const community = page.getByRole('region', { name: 'Community' });
      assert.equal(await community.count(), 0);
      assert.deepEqual(catalogSearches, []);
      await search.fill('ledger');
      await community.waitFor();
      const ledger = community.getByRole('listitem').filter({ hasText: 'Ledger tools' });
      await ledger.getByText('Double-entry books for small teams', { exact: true }).waitFor();
      await ledger.getByRole('button', { name: 'Connect Ledger tools', exact: true }).waitFor();
      assert.equal(await ledger.getByText('Community', { exact: true }).count(), 0);
      assert.deepEqual(catalogSearches, ['ledger']);
      await search.fill('');
      await community.waitFor({ state: 'detached' });
    });

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});
