import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createWorkspaceFixture, serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

test(
  'unfinished consent stays neutral across the directory, account pages and authorization banner',
  { timeout: 300000 },
  async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const server = await createServer({
      root,
      configFile: `${root}/vite.config.ts`,
      envDir: false,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false },
    });
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    assert.equal((await fetch(origin)).ok, true);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const { workspace, session } = createWorkspaceFixture({ slug: 'connection-proof', name: 'Connections' });
    const base = `/v1/workspaces/${workspace.id}`;
    const shell = new Map(workspaceShellReads(workspace.id));
    let github = [];
    let githubBegins = 0;
    let accounts = [];
    let slack = { state: 'disconnected', teamId: null, canManage: true, linked: false, scopes: [] };
    const providers = ['atlassian-mcp', 'trello'].map(protocol => ({ protocol, configured: true }));
    const external = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const atlassianAccount = protocol => ({
      id: randomUUID(),
      protocol,
      ownership: 'personal',
      state: 'authorizing',
      configured: true,
      identity: null,
      resources: [],
      scopes: [],
      generation: 1,
      grantsVersion: 1,
      capabilities: { read: true, manage: true, use: true },
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (['github.com', 'slack.com', 'mcp.atlassian.com', 'auth.atlassian.com'].includes(url.hostname)) {
        external.push(url.href);
        assert.ok(['github.com', 'slack.com', 'mcp.atlassian.com', 'auth.atlassian.com'].includes(url.hostname));
        return route.fulfill({ contentType: 'text/html', body: '<h1>Provider sign-in</h1>' });
      }
      assert.ok(
        url.origin === new URL(origin).origin || url.pathname.startsWith('/v1/'),
        'unexpected external request',
      );
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
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        };
      else if (path === '/v1/google-workspace/availability') json = { configured: true };
      else if (path === `${base}/google-workspace`) json = { status: 'disconnected' };
      else if (path === `${base}/github/accounts` && request.method() === 'GET')
        json = { configured: true, accounts: github };
      else if (path === `${base}/github/accounts/begin` || /\/github\/accounts\/[^/]+\/reconnect$/.test(path)) {
        if (path.endsWith('/begin')) githubBegins++;
        if (!github.length)
          github = [
            { id: randomUUID(), state: 'authorizing', configured: true, identity: null, generation: 1, scopes: [] },
          ];
        github[0].state = 'authorizing';
        json = { accountId: github[0].id, url: 'https://github.com/login/oauth/authorize?client_id=fixture' };
      } else if (/\/github\/accounts\/[^/]+\/disconnect$/.test(path)) {
        const account = { ...github[0], state: 'disconnected' };
        github = [];
        json = { account, providerRevocation: 'manual-required' };
      } else if (path === `${base}/atlassian/accounts` && request.method() === 'GET') json = { accounts, providers };
      else if (path === `${base}/atlassian/accounts/begin` || /\/atlassian\/accounts\/[^/]+\/reconnect$/.test(path)) {
        let account = accounts.find(item => path.includes(item.id));
        if (!account) {
          account = atlassianAccount(request.postDataJSON().protocol);
          accounts.push(account);
        }
        json = { accountId: account.id, url: 'https://mcp.atlassian.com/v1/authorize?client_id=fixture' };
      } else if (/\/atlassian\/accounts\/[^/]+\/disconnect$/.test(path)) {
        accounts = accounts.map(account =>
          path.includes(account.id) ? { ...account, state: 'disconnected' } : account,
        );
        json = { account: accounts.find(account => path.includes(account.id)), providerRevocation: 'manual-required' };
      } else if (path === `${base}/atlassian/sources`)
        json = { sources: [], mcp: { enabled: false, explanation: 'Not enabled' } };
      else if (path === `${base}/slack/status`) json = slack;
      else if (path === `${base}/slack/install`) {
        slack = { ...slack, state: 'authorizing' };
        json = { url: 'https://slack.com/oauth/v2/authorize?client_id=fixture' };
      } else if (path.endsWith('/integrations')) json = { integrations: [] };
      else if (path.endsWith('/integrations/collaborators')) json = { members: [], teams: [] };
      else if (path.endsWith('/governance/directory')) json = { members: [] };
      else if (shell.has(path)) json = shell.get(path);
      else return route.fulfill({ status: 404, json: { error: 'not-found' } });
      return route.fulfill({ json });
    });
    const appNames = { github: 'GitHub', slack: 'Slack', jira: 'Jira', confluence: 'Confluence', trello: 'Trello' };
    const visit = async (id, tab, reload = false) => {
      const href = `/${workspace.slug}/integrations${id ? `/${id}` : ''}${tab ? `?tab=${tab}` : ''}`;
      if (!reload && page.url().startsWith(origin))
        await page.evaluate(async href => {
          const { router } = await import('/src/router.tsx');
          await router.navigate({ href });
        }, href);
      else await page.goto(`${origin.replace(/\/$/, '')}${href}`);
    };
    const neutral = async id => {
      const summary = page.getByRole('region', { name: `${appNames[id]} summary`, exact: true });
      await summary.getByText('Not connected', { exact: true }).waitFor();
      await summary.getByRole('button', { name: `Connect ${appNames[id]}`, exact: true }).waitFor();
      assert.equal(await page.getByLabel('Integration authorization', { exact: true }).count(), 0);
      assert.equal(await summary.getByText('Needs attention', { exact: true }).count(), 0);
    };
    try {
      for (const id of Object.keys(appNames)) {
        await visit(id);
        await neutral(id);
        await page.getByRole('button', { name: `Connect ${appNames[id]}`, exact: true }).click();
        await page.getByRole('heading', { name: 'Provider sign-in' }).waitFor();
        await visit(id);
        await neutral(id);
      }
      assert.equal(external.length, 5);
      await visit();
      await page.getByRole('link', { name: 'Needs attention 0', exact: true }).waitFor();
      const search = page.getByRole('searchbox', { name: 'Search apps', exact: true });
      for (const name of Object.values(appNames)) {
        await search.fill(name);
        assert.match(await page.getByRole('link').filter({ hasText: name }).last().innerText(), /Not connected/);
      }
      await search.fill('');
      await page.screenshot({ path: '/tmp/connection-state-directory.png' });
      await page.getByRole('link', { name: 'Needs attention 0', exact: true }).click();
      await page.getByText('Nothing needs attention', { exact: true }).waitFor();

      github[0].state = 'reconnect-required';
      accounts = accounts.map(account => ({ ...account, state: 'reconnect-required' }));
      slack = { ...slack, state: 'failed' };
      await visit(undefined, undefined, true);
      for (const id of Object.keys(appNames)) {
        await visit(id);
        await neutral(id);
      }
      github[0].state = 'disconnected';
      await visit('github', undefined, true);
      await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
      await page.getByRole('heading', { name: 'Provider sign-in' }).waitFor();
      assert.equal(githubBegins, 1, 'retry resumes the existing disconnected attempt');
      await visit('github');
      await neutral('github');
      await visit('github', 'accounts');
      await page.getByRole('button', { name: 'Finish connecting', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Dismiss attempt', exact: true }).click();
      await neutral('github');
      await page.getByText('No personal GitHub accounts', { exact: true }).waitFor();
      await visit('trello', 'accounts');
      await page.getByRole('button', { name: 'Previous integrations (1)', exact: true }).click();
      await page.getByRole('button', { name: 'Finish connecting', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm disconnect', exact: true }).click();
      await neutral('trello');

      github = [
        {
          id: randomUUID(),
          state: 'authorizing',
          configured: true,
          identity: { id: '123', login: 'existing' },
          generation: 2,
          scopes: [],
        },
      ];
      accounts = accounts.map(account =>
        account.protocol === 'atlassian-mcp'
          ? {
              ...account,
              state: 'reconnect-required',
              identity: { id: 'grant', label: 'Existing account', qualification: 'grant-bound-needs-qualification' },
            }
          : account,
      );
      slack = { ...slack, state: 'reconnect-required', teamId: 'TEXISTING', scopes: ['chat:write'] };
      await visit(undefined, undefined, true);
      await page.getByRole('link', { name: 'Needs attention 4', exact: true }).waitFor();
      await page.getByLabel('Integration authorization', { exact: true }).waitFor();
      for (const id of ['github', 'slack', 'jira', 'confluence']) {
        await visit(id);
        const summary = page.getByRole('region', { name: `${appNames[id]} summary`, exact: true });
        await summary.getByText('Needs attention', { exact: true }).waitFor();
        await summary.getByRole('button', { name: `Reconnect ${appNames[id]}`, exact: true }).waitFor();
        await page.getByLabel('Integration authorization', { exact: true }).waitFor();
      }
      await page.screenshot({ path: '/tmp/connection-state-repair.png' });
      slack = { ...slack, state: 'revoked' };
      github = [];
      accounts = [];
      await visit('slack', undefined, true);
      await neutral('slack');
      await visit();
      await page.getByRole('link', { name: 'Needs attention 0', exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } catch (error) {
      await page.screenshot({ path: '/tmp/connection-state-failure.png' });
      throw error;
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
