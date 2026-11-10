import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startBuiltApp } from './built-app.fixture.mjs';
import { createWorkspaceFixture, serveWorkspaceShellEvent } from './workspace.fixture.mjs';

test('each automatic account can switch to selected content in the same flow', { timeout: 300_000 }, async t => {
  const server = await startBuiltApp();
  t.after(() => server.close());
  const cdpPort = process.env.KNOWLEDGE_SCOPE_CDP_PORT;
  const browser = await chromium.launch({ args: cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [] });
  t.after(async () => {
    if (cdpPort)
      execFileSync('pnpm', ['dlx', 'agent-browser', '--session', 'knowledge-scope', 'close'], { stdio: 'pipe' });
    await browser.close();
  });
  const { workspace, session } = createWorkspaceFixture({ slug: 'scope-demo', name: 'Source controls' });
  const accountKey = '66666666-6666-4666-8666-666666666666';
  const cloudId = '55555555-5555-4555-8555-555555555555';
  const screenshots = process.env.KNOWLEDGE_SCOPE_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });

  for (const product of ['google-drive', 'gmail', 'slack', 'jira', 'confluence']) {
    if (process.env.KNOWLEDGE_SCOPE_PRODUCT && product !== process.env.KNOWLEDGE_SCOPE_PRODUCT) continue;
    await t.test(product, async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(45000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const writes = [];
        const item = {
          intentId: '00000000-0000-4000-8000-000000000001',
          product,
          accountKey: product === 'slack' ? 'TDEMO:UOWNER' : accountKey,
          accountLabel: 'owner@example.test',
          state: 'active',
          syncState: 'ready',
          failure: null,
          discoveredAt: new Date().toISOString(),
          nextAttemptAt: new Date(Date.now() + 3600000).toISOString(),
          scopes: { discovered: 2, included: 2, manual: 0 },
          sources: [],
          counts: { total: 0, ready: 0, queued: 0, failed: 0, skipped: 0, quotaLimited: 0 },
          groupFailures: [],
          ingestion: { state: 'ready', pending: 0, failed: 0, failure: null },
        };
        await context.route('**/v1/**', async route => {
          if (await serveWorkspaceShellEvent(route, workspace)) return;
          const request = route.request();
          const url = new URL(request.url());
          const path = url.pathname;
          const base = `/v1/workspaces/${workspace.id}`;
          const headers = {
            'access-control-allow-origin': server.origin,
            'access-control-allow-credentials': 'true',
            'access-control-allow-methods': 'GET,POST,OPTIONS',
            'access-control-allow-headers': 'content-type',
          };
          if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
          let json;
          if (path.endsWith('/auth/get-session')) json = session;
          else if (path === '/v1/feature-flags') json = {};
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
          else if (path === `${base}/knowledge/defaults`) json = { enabled: true, items: [item] };
          else if (path.endsWith('/defaults/' + item.intentId + '/manage')) {
            const body = request.postDataJSON();
            writes.push(body);
            item.state = body.action === 'resume' ? 'active' : 'opted-out';
            json = item;
          } else if (path === '/v1/google-workspace/availability') json = { configured: true };
          else if (path === `${base}/google-workspace`)
            json = {
              status: 'connected',
              integrationId: accountKey,
              generation: 1,
              accountId: accountKey,
              email: 'owner@example.test',
              scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.modify'],
            };
          else if (path.endsWith('/slack/status'))
            json = { state: 'active', teamId: 'TDEMO', canManage: false, linked: true, scopes: [] };
          else if (path.endsWith('/atlassian/accounts')) json = { accounts: [], providers: [] };
          else if (path.endsWith('/github/accounts')) json = { configured: true, accounts: [] };
          else if (path === `${base}/atlassian/sources`) json = { sources: [], mcp: { enabled: false } };
          else if (path.endsWith('/knowledge/atlassian/sites')) {
            assert.equal(url.searchParams.get('account'), accountKey);
            json = { items: [{ cloudId, name: 'Example', url: 'https://example.atlassian.net' }] };
          } else if (path.endsWith('/knowledge/atlassian/discover')) {
            assert.equal(url.searchParams.get('account'), accountKey);
            json = {
              binding: { accountId: accountKey, atlassianAccountId: 'owner', cloudId },
              items: [{ kind: product === 'jira' ? 'project' : 'space', id: '123', key: 'DOC', title: 'Keep this' }],
              nextCursor: null,
            };
          } else if (path.endsWith('/knowledge/google/discover'))
            json = {
              binding: { integrationId: accountKey, generation: 1, accountId: accountKey, requiredScopes: ['read'] },
              items: [{ nativeId: 'keep', title: 'Keep this', kind: product === 'gmail' ? 'gmail' : 'drive-folder' }],
              nextCursor: null,
            };
          else if (path.endsWith('/knowledge/slack/discover'))
            json = {
              binding: {
                installationId: accountKey,
                installationGeneration: 1,
                identityId: accountKey,
                teamId: 'TDEMO',
                slackUserId: 'UOWNER',
              },
              items: [{ conversationId: 'CKEEP', title: '#keep', kind: 'public' }],
              nextCursor: null,
            };
          else if (/\/knowledge\/(?:google|slack|github|atlassian)\/sources$/.test(path)) {
            if (request.method() === 'POST') {
              writes.push(request.postDataJSON());
              json = {
                ...request.postDataJSON(),
                sourceId: request.postDataJSON().commandId,
                product,
                title: 'Keep this',
                state: 'active',
                syncState: 'queued',
                failure: null,
                nextAttemptAt: new Date().toISOString(),
                counts: null,
                canManage: true,
                targets: [],
                conversations: [],
              };
            } else json = { items: [] };
          } else if (path.endsWith('/bud'))
            json = {
              conversationId: null,
              onboarding: 'skipped',
              bubblesEnabled: false,
              snoozedUntil: null,
              nudge: null,
              preferences: [],
            };
          else if (path.endsWith('/workspace-mcp/capabilities')) json = { enabled: false };
          else return route.fulfill({ status: 404, json: { error: 'unknown-fixture-route' }, headers });
          await route.fulfill({ json, headers });
        });
        await page.goto(`${server.origin}/${workspace.slug}/integrations/${product}?tab=knowledge`);
        const region = page.getByRole('region', { name: 'Automatic Knowledge', exact: true });
        await region
          .getByText('owner@example.test', { exact: true })
          .waitFor()
          .catch(async error => {
            await page.screenshot({ path: `/tmp/knowledge-scope-${product}-failure.png`, fullPage: true });
            console.error(await page.locator('body').innerText(), errors);
            throw error;
          });
        if (screenshots) await region.screenshot({ path: `${screenshots}/${product}-description.png` });
        if (process.env.KNOWLEDGE_SCOPE_BEFORE === '1') return;
        await region.getByRole('button', { name: 'Choose what to index', exact: true }).click();
        await region
          .getByText(
            'This stops indexing everything in this account and removes it from Knowledge. Then choose what to keep.',
            { exact: true },
          )
          .waitFor();
        assert.deepEqual(writes, [], 'opening the confirmation does not change sources');
        if (screenshots) await region.screenshot({ path: `${screenshots}/${product}-confirmation.png` });
        await region.getByRole('button', { name: 'Continue to selection', exact: true }).click();
        const picker = region.getByRole('region', {
          name:
            product === 'slack'
              ? 'Select Slack conversations'
              : product === 'jira'
                ? 'Select Jira content'
                : product === 'confluence'
                  ? 'Select Confluence content'
                  : 'Select Google source',
        });
        await picker.waitFor();
        assert.deepEqual(writes, [{ action: 'narrow' }]);
        if (product === 'google-drive' || product === 'gmail') {
          await picker
            .getByRole('combobox', { name: product === 'gmail' ? 'Gmail scope' : 'Folder', exact: true })
            .click();
          await page.getByRole('option', { name: 'Keep this', exact: true }).click();
        } else {
          await picker.getByRole('checkbox', { name: product === 'slack' ? /keep/ : /Keep this/ }).check();
        }
        if (screenshots) await region.screenshot({ path: `${screenshots}/${product}-picker.png` });
        if (screenshots && cdpPort && product === 'google-drive')
          execFileSync(
            'pnpm',
            [
              'dlx',
              'agent-browser',
              '--session',
              'knowledge-scope',
              '--cdp',
              cdpPort,
              'screenshot',
              `${screenshots}/google-drive-browser.png`,
            ],
            { stdio: 'pipe' },
          );
        await picker.getByRole('button', { name: /Save|Index/, exact: false }).click();
        await region
          .getByText('Your selection was saved. Only selected sources will be indexed.', { exact: true })
          .waitFor();
        assert.equal(writes.length, 2);
        assert.equal(writes[1].accountId, item.accountKey);
        await region.getByRole('button', { name: 'Turn automatic Knowledge back on', exact: true }).click();
        await region.getByRole('button', { name: 'Stop automatic Knowledge', exact: true }).waitFor();
        if (screenshots) await region.screenshot({ path: `${screenshots}/${product}-resumed.png` });
        assert.equal(
          await region
            .getByText('Your selection was saved. Only selected sources will be indexed.', { exact: true })
            .count(),
          0,
        );
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }
});
