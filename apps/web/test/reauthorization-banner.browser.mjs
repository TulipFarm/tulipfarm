import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { googleIdentityScopes, googleAppScopes } from '@tulipfarm/google-workspace/public-contracts';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

test(
  'workspace banner targets confirmed authorization issues and recovers without repeated writes',
  { timeout: 120000 },
  async () => {
    const { workspace, session } = createWorkspaceFixture({ slug: 'authorization', name: 'Acme' });
    const other = { ...workspace, id: randomUUID(), slug: 'other', name: 'Other workspace' };
    const memberId = randomUUID(),
      accountId = randomUUID(),
      mcpId = randomUUID();
    const port = 21000 + Math.floor(Math.random() * 20000),
      origin = `http://127.0.0.1:${port}`;
    const screenshots = process.env.AUTHORIZATION_SCREENSHOTS,
      cdp = process.env.AUTHORIZATION_CDP_PORT;
    const server = spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
    );
    let browser, page;
    try {
      for (let i = 0; ; i++) {
        if (
          await fetch(origin).then(
            response => response.ok,
            () => false,
          )
        )
          break;
        assert.ok(i < 150 && server.exitCode === null, 'Vite starts');
        await delay(100);
      }
      browser = await chromium.launch({ args: cdp ? [`--remote-debugging-port=${cdp}`] : [] });
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(10000);
      const errors = [],
        writes = [],
        destinations = [];
      page.on('pageerror', error => errors.push(String(error)));
      let slack = { state: 'active', teamId: 'TONE', canManage: true, linked: true, scopes: ['chat:write'] };
      let google = {
        status: 'connected',
        integrationId: randomUUID(),
        generation: 1,
        accountId: 'google-one',
        email: 'ada@example.test',
        scopes: [...googleIdentityScopes, ...googleAppScopes.calendar],
      };
      let github = { configured: true, accounts: [] };
      let mcpEnabled = false,
        mcpReads = 0,
        slackHttp = 200,
        installHttp = 503;
      const mcp = {
        id: mcpId,
        name: 'Customer support tools',
        ownership: 'personal',
        endpoint: 'https://mcp.example.test/mcp',
        accountLabel: null,
        authMethod: 'oauth',
        status: 'error',
        version: 1,
        authorizationEpoch: 1,
        canManage: true,
        canUse: true,
        barrier: null,
        statusReason: 'Reconnect and review this integration.',
        reauthorizationRequired: true,
      };
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        let json,
          status = 200;
        if (path === '/v1/auth/get-session') json = session;
        else if (path === '/v1/workspaces') json = [workspace, other];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path === `/v1/workspaces/${other.slug}`) json = other;
        else if (path.endsWith('/governance/me'))
          json = {
            membershipId: memberId,
            role: 'member',
            teams: [],
            capabilities: { manageGovernance: false, canLeave: true },
          };
        else if (path.endsWith('/google-workspace/availability')) json = { configured: true };
        else if (path.endsWith('/google-workspace'))
          json = path.includes(other.id) ? { status: 'disconnected' } : google;
        else if (path.endsWith('/slack/status')) {
          status = slackHttp;
          json = path.includes(other.id)
            ? { ...slack, state: 'disconnected', scopes: [] }
            : status === 200
              ? slack
              : { error: 'slack-unavailable' };
          await delay(100);
        } else if (path.endsWith('/slack/install')) {
          writes.push(path);
          await delay(200);
          status = installHttp;
          json =
            status === 200
              ? { url: 'https://slack.com/oauth/v2/authorize?client_id=fixture' }
              : { error: 'slack-installation-unavailable' };
        } else if (path.endsWith('/github/accounts'))
          json = path.includes(other.id) ? { configured: true, accounts: [] } : github;
        else if (path.endsWith(`/github/accounts/${accountId}/reconnect`)) {
          writes.push(path);
          json = { accountId, url: 'https://github.com/login/oauth/authorize?client_id=fixture' };
        } else if (path.endsWith('/atlassian/accounts')) json = { accounts: [], providers: [] };
        else if (path.endsWith('/workspace-mcp/capabilities'))
          json = mcpEnabled
            ? { enabled: true, canManageShared: false, integrationsEnabled: true, dispatchEnabled: false }
            : { enabled: false };
        else if (path.endsWith(`/workspace-mcp/integrations/${mcpId}`))
          json = {
            integration: mcp,
            tools: [],
            grants: [],
            managers: [],
            grantOptions: [],
            descriptor: { kind: 'chat-only', reason: 'Not reviewed' },
          };
        else if (path.endsWith('/workspace-mcp/integrations')) {
          mcpReads++;
          json = { integrations: path.includes(other.id) ? [] : [mcp] };
        } else if (path.endsWith('/integrations')) json = { integrations: [] };
        else {
          status = 404;
          json = { error: 'not-found' };
        }
        await route.fulfill({ status, json });
      });
      await page.route('https://slack.com/**', async route => {
        destinations.push(route.request().url());
        await route.fulfill({ contentType: 'text/html', body: '<h1>Slack consent fixture</h1>' });
      });
      await page.route('https://github.com/login/oauth/**', async route => {
        destinations.push(route.request().url());
        await route.fulfill({ contentType: 'text/html', body: '<h1>GitHub consent fixture</h1>' });
      });
      const banner = page.getByRole('region', { name: 'Integration authorization', exact: true });
      const visit = async () => {
        await page.goto(`${origin}/${workspace.slug}/integrations`);
        await page.getByRole('heading', { name: 'Integrations', exact: true }).waitFor();
      };
      const shot = async name => {
        if (!screenshots) return;
        await mkdir(screenshots, { recursive: true });
        if (cdp) {
          execFileSync('agent-browser', ['--session', 'authorization-proof', '--cdp', cdp, 'snapshot', '-i'], {
            stdio: 'pipe',
          });
          execFileSync(
            'agent-browser',
            ['--session', 'authorization-proof', '--cdp', cdp, 'screenshot', `${screenshots}/${name}.png`],
            { stdio: 'inherit' },
          );
        } else await page.screenshot({ path: `${screenshots}/${name}.png` });
      };
      await visit();
      await delay(300);
      assert.equal(await banner.count(), 0, 'healthy Google does not nag about unused Gmail');
      assert.equal(mcpReads, 0, 'disabled MCP does not request integration metadata');
      await shot('before-desktop');
      slack = { ...slack, state: 'permissions-required', missingScopes: ['chat:write.customize'] };
      await visit();
      await banner.getByText('Approve the updated permissions to continue.', { exact: false }).waitFor();
      const bounds = await banner.boundingBox(),
        sidebar = await page.locator('[data-slot="sidebar-container"]').boundingBox();
      assert.equal(bounds.x, 0);
      assert.equal(bounds.y, 0);
      assert.equal(bounds.width, 1440);
      assert.ok(sidebar.y >= bounds.height, 'banner sits above the sidebar, not behind it');
      await shot('after-desktop');

      await banner.getByRole('button', { name: 'Update permissions' }).evaluate(element => {
        element.click();
        element.click();
      });
      await banner.getByRole('alert').waitFor();
      assert.equal(writes.length, 1, 'double click starts one authorization attempt');
      slackHttp = 503;
      await banner.getByRole('button', { name: 'Check integration status' }).click();
      await banner.getByText('Integration status could not refresh.', { exact: false }).waitFor();
      assert.equal(writes.length, 1, 'read failure does not reauthorize or dismiss the warning');
      slackHttp = 200;
      await banner.getByRole('button', { name: 'Check integration status' }).click();
      await banner.getByRole('button', { name: 'Update permissions' }).waitFor();
      installHttp = 200;
      await banner.getByRole('button', { name: 'Update permissions' }).click();
      await page.getByRole('heading', { name: 'Slack consent fixture' }).waitFor();
      await visit();
      await banner.waitFor();
      assert.equal(writes.length, 2, 'returning without approval keeps attention and sends no new write');
      slack = { ...slack, state: 'active', scopes: ['chat:write', 'chat:write.customize'], missingScopes: [] };
      await visit();
      await delay(300);
      assert.equal(await banner.count(), 0, 'confirmed scope grant removes the banner');

      google = { ...google, status: 'reconnect-required' };
      github.accounts = [
        {
          id: accountId,
          configured: true,
          state: 'reconnect-required',
          generation: 1,
          scopes: ['repo'],
          identity: { id: '42', login: 'ada' },
        },
      ];
      await visit();
      await banner.getByText('2 integrations need authorization.', { exact: false }).waitFor();
      await banner.getByRole('combobox', { name: 'Integration to reauthorize' }).click();
      await page.getByRole('option', { name: 'GitHub (@ada)', exact: true }).click();
      assert.equal(
        await banner.getByRole('combobox', { name: 'Integration to reauthorize' }).innerText(),
        'GitHub (@ada)',
      );
      await shot('multiple-desktop');
      for (const [width, colorScheme] of [
        [320, 'light'],
        [390, 'dark'],
        [768, 'light'],
      ]) {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
          `no page overflow at ${width}`,
        );
        assert.equal(await banner.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        await shot(`multiple-${width}-${colorScheme}`);
      }
      await banner.getByRole('button', { name: 'Update permissions' }).click();
      await page.getByRole('heading', { name: 'GitHub consent fixture' }).waitFor();
      assert.equal(
        writes.at(-1),
        `/v1/workspaces/${workspace.id}/github/accounts/${accountId}/reconnect`,
        'reauthorizes the selected account',
      );
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.emulateMedia({ colorScheme: 'light' });
      await visit();
      await page.goto(`${origin}/${other.slug}/integrations`);
      await page.getByRole('heading', { name: 'Integrations', exact: true }).waitFor();
      await delay(300);
      assert.equal(await banner.count(), 0, 'authorization notices do not leak across workspaces');
      google = { ...google, status: 'connected' };
      github.accounts = [];
      slack = { ...slack, state: 'permissions-required', missingScopes: ['chat:write.customize'], canManage: false };
      await visit();
      await delay(300);
      assert.equal(await banner.count(), 0, 'only Slack managers see workspace reauthorization');
      mcpEnabled = true;
      await visit();
      await banner.getByText('Customer support tools needs authorization.', { exact: false }).waitFor();
      await banner.getByRole('button', { name: 'Update permissions' }).click();
      await page.getByRole('heading', { name: 'Reconnect MCP server', exact: true }).waitFor();
      assert.ok(page.url().endsWith(`#reauthorize-mcp-${mcpId}`));
      assert.equal(destinations.length, 2);
      assert.deepEqual(errors, []);
    } catch (error) {
      if (page && screenshots) await page.screenshot({ path: `${screenshots}/failure.png` });
      throw error;
    } finally {
      try {
        await browser?.close();
      } finally {
        server.kill('SIGTERM');
      }
    }
  },
);
