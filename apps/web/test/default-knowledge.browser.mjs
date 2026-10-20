import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createWorkspaceFixture, serveWorkspaceShellEvent } from './workspace.fixture.mjs';

const at = '2026-10-16T09:00:00.000Z';
const counts = (ready, queued = 0, failed = 0, skipped = 0, quotaLimited = 0) => ({
  total: ready + queued + failed + skipped + quotaLimited,
  ready,
  queued,
  failed,
  skipped,
  quotaLimited,
});
const intent = (n, product, accountLabel, rest = {}) => ({
  intentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  product,
  accountLabel,
  state: 'active',
  syncState: 'ready',
  failure: null,
  discoveredAt: at,
  nextAttemptAt: new Date(Date.now() + 240_000).toISOString(),
  scopes: { discovered: 0, included: 0, manual: 0 },
  sources: [],
  counts: counts(0),
  groupFailures: [],
  accountKey: `account-${n}`,
  ingestion: { state: 'ready', pending: 0, failed: 0, failure: null },
  ...rest,
});
const devAccount = {
  id: '88888888-8888-4888-8888-888888888888',
  state: 'active',
  configured: true,
  identity: { id: '101', login: 'ada-dev' },
  generation: 1,
  scopes: ['repo', 'read:user'],
};
const workAccount = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  state: 'active',
  configured: true,
  identity: { id: '102', login: 'ada-work' },
  generation: 1,
  scopes: ['repo', 'read:user'],
};
const linkedSlack = { state: 'active', teamId: 'TACME', canManage: false, linked: true, scopes: [] };
const restAccount = scopes => ({
  id: '66666666-6666-4666-8666-666666666666',
  protocol: 'atlassian-rest',
  ownership: 'personal',
  state: 'active',
  configured: true,
  identity: { id: 'acc-1', label: 'Ada Lovelace', qualification: 'verified' },
  resources: [],
  scopes,
  generation: 1,
  grantsVersion: 1,
  capabilities: { read: true, manage: true, use: true },
});

test('automatic integration Knowledge disclosure, status and controls in Chromium', { timeout: 240_000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    envDir: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch();
  const screenshots = fileURLToPath(new URL('../../../reports/check/default-knowledge-ui/', import.meta.url));
  await mkdir(screenshots, { recursive: true });
  const { workspace, session } = createWorkspaceFixture({ slug: 'default-knowledge-qa', name: 'Default Knowledge QA' });

  async function fixture(
    run,
    {
      mobile = false,
      items = [],
      enabled = true,
      google = 'connected',
      atlassian = [],
      listStatus = [],
      gate = null,
      atlassianStatus = [],
      atlassianGate = null,
      reconnectGate = null,
      slack = linkedSlack,
      githubAccounts = [devAccount],
    } = {},
  ) {
    const context = await browser.newContext({
      viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 1100 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
      colorScheme: mobile ? 'dark' : 'light',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const state = {
      items: structuredClone(items),
      listStatus: [...listStatus],
      gate,
      atlassianStatus: [...atlassianStatus],
      atlassianGate,
      reconnectGate,
    };
    const writes = [],
      errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const provider of [
      'https://auth.atlassian.com/**',
      'https://accounts.google.com/**',
      'https://github.com/**',
      'https://slack.com/**',
    ])
      await context.route(provider, route =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Provider consent</h1>' }),
      );
    await context.route('**/v1/**', async route => {
      if (await serveWorkspaceShellEvent(route, workspace)) return;
      const request = route.request(),
        path = new URL(request.url()).pathname,
        method = request.method();
      const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' };
      if (method === 'OPTIONS')
        return route.fulfill({
          status: 204,
          headers: {
            ...headers,
            'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
            'access-control-allow-headers': 'content-type',
          },
        });
      let status = 200,
        json;
      const base = `/v1/workspaces/${workspace.id}`;
      if (path.endsWith('/auth/get-session')) json = session;
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
      else if (path === `${base}/knowledge/defaults`) {
        await state.gate;
        status = state.listStatus.shift() ?? 200;
        json = status === 200 ? { enabled, items: enabled ? state.items : [] } : { error: 'knowledge-unavailable' };
      } else if (path.startsWith(`${base}/knowledge/defaults/`) && path.endsWith('/manage')) {
        const id = path.split('/defaults/')[1].split('/')[0],
          { action } = request.postDataJSON();
        writes.push({ kind: 'manage', id, action });
        const target = state.items.find(item => item.intentId === id);
        if (action === 'opt-out') target.state = 'opted-out';
        else
          Object.assign(target, {
            state: 'active',
            syncState: 'queued',
            failure: null,
            ingestion:
              target.ingestion.state === 'failed'
                ? { state: 'pending', pending: target.ingestion.failed, failed: 0, failure: null }
                : target.ingestion,
          });
        json = target;
      } else if (path === '/v1/google-workspace/availability') json = { configured: true };
      else if (path === `${base}/google-workspace`)
        json =
          google === 'connected'
            ? {
                status: 'connected',
                integrationId: '77777777-7777-4777-8777-777777777777',
                generation: 1,
                accountId: 'ada',
                email: 'ada@example.test',
                scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.modify'],
              }
            : { status: 'disconnected' };
      else if (path === `${base}/google-workspace/begin` && method === 'POST') {
        writes.push({ kind: 'google-begin', app: new URL(request.url()).searchParams.get('app') });
        json = { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=qa' };
      } else if (path === `${base}/slack/status`) json = slack;
      else if (path === `${base}/slack/install` && method === 'POST') {
        writes.push({ kind: 'slack-install' });
        json = { url: 'https://slack.com/oauth/v2/authorize?client_id=qa' };
      } else if (path === `${base}/github/accounts`) json = { configured: true, accounts: githubAccounts };
      else if (/\/github\/accounts\/[^/]+\/reconnect$/.test(path) && method === 'POST') {
        const id = path.split('/').at(-2);
        writes.push({ kind: 'github-reconnect', id });
        json = { accountId: id, url: 'https://github.com/login/oauth/authorize?client_id=qa' };
      } else if (/\/atlassian\/accounts\/[^/]+\/reconnect$/.test(path) && method === 'POST') {
        const id = path.split('/').at(-2);
        writes.push({ kind: 'atlassian-reconnect', id });
        await state.reconnectGate;
        json = { accountId: id, url: 'https://auth.atlassian.com/authorize?client_id=qa&state=s' };
      } else if (path === `${base}/atlassian/accounts`) {
        await state.atlassianGate;
        status = state.atlassianStatus.shift() ?? 200;
        json =
          status === 200
            ? {
                accounts: atlassian,
                providers: [
                  { protocol: 'atlassian-mcp', configured: true },
                  { protocol: 'atlassian-rest', configured: true },
                ],
              }
            : { error: 'atlassian-unavailable' };
      } else if (path === `${base}/atlassian/accounts/begin`) {
        writes.push({ kind: 'atlassian-begin', body: request.postDataJSON() });
        json = {
          accountId: '99999999-9999-4999-8999-999999999999',
          url: 'https://auth.atlassian.com/authorize?client_id=qa&state=s',
        };
      } else if (path === `${base}/atlassian/sources`)
        json = { sources: [], mcp: { enabled: true, explanation: 'Jira and Confluence tools are available in chat.' } };
      else if (/\/knowledge\/(?:google|slack|github|atlassian)\/sources$/.test(path)) json = { items: [] };
      else if (path.endsWith('/workspace-mcp/capabilities')) json = { enabled: false };
      else if (path.endsWith('/bud'))
        json = {
          conversationId: null,
          onboarding: 'skipped',
          bubblesEnabled: false,
          snoozedUntil: null,
          nudge: null,
          preferences: [],
        };
      else {
        status = 404;
        json = { error: 'unknown-fixture-route' };
      }
      await route.fulfill({ status, json, headers }).catch(() => {});
    });
    const open = async app => {
      await page.goto(`${origin}/${workspace.slug}/integrations#${app}`);
      const section = page.getByRole('region', { name: 'Automatic Knowledge', exact: true });
      await section.waitFor();
      return section;
    };
    const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    try {
      await run({ page, open, writes, state, focused });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }

  try {
    await fixture(
      async ({ page, open }) => {
        const section = await open('gmail');
        for (const term of ['Included', 'Who can search', 'Coverage', 'Not included', 'Credits'])
          await section.getByText(term, { exact: true }).waitFor();
        await section.getByText(/^Only you\./).waitFor();
        await section.getByText(/last 90 days/).waitFor();
        await section.getByText('Starts after you connect Gmail.').waitFor();
        await page.screenshot({ path: `${screenshots}/before-connect.png`, fullPage: true });
      },
      { google: 'disconnected' },
    );

    await fixture(async ({ page, open }) => {
      const section = await open('google-drive');
      await section
        .getByText(
          'This integration was set up before automatic Knowledge, so nothing is imported automatically. Choose sources below.',
        )
        .waitFor();
      assert.equal(await page.getByRole('list', { name: 'Automatic Google Drive Knowledge' }).count(), 0);
    });

    let release;
    await fixture(
      async ({ open, state }) => {
        const section = await open('gmail');
        await section.getByRole('status', { name: 'Checking automatic Knowledge' }).waitFor();
        release();
        await section.getByText('Retry automatic Knowledge status', { exact: true }).waitFor({ timeout: 30_000 });
        await section
          .getByText('Your integration still works. Status is hidden until it can be checked again.')
          .waitFor();
        state.listStatus.length = 0;
        await section.getByRole('button', { name: 'Retry automatic Knowledge status' }).click();
        await section.getByText('640 searchable · 0 queued · 0 failed · 0 skipped · 0 over limit').waitFor();
      },
      {
        items: [intent(2, 'gmail', 'ada@example.test', { counts: counts(640) })],
        listStatus: Array(10).fill(503),
        gate: new Promise(resolve => {
          release = resolve;
        }),
      },
    );

    await fixture(
      async ({ page }) => {
        const read = page.waitForResponse(response => response.url().endsWith('/knowledge/defaults'));
        await page.goto(`${origin}/${workspace.slug}/integrations#gmail`);
        await read;
        await page.getByRole('region', { name: 'What it can do', exact: true }).waitFor();
        await page.waitForTimeout(300);
        assert.equal(await page.getByRole('region', { name: 'Automatic Knowledge', exact: true }).count(), 0);
      },
      { enabled: false, items: [intent(2, 'gmail', 'ada@example.test')] },
    );

    await fixture(
      async ({ page, open, writes, focused }) => {
        let section = await open('gmail');
        const row = section.getByRole('listitem', { name: 'Gmail ada@example.test' });
        await row.getByText('Finding sources', { exact: true }).first().waitFor();
        await row
          .getByRole('status')
          .filter({ hasText: 'Finding sources. Your integration is ready to use now.' })
          .waitFor();
        await row.getByText('212 searchable · 96 queued · 0 failed · 0 skipped · 0 over limit').waitFor();
        await row.getByRole('button', { name: 'Stop automatic Knowledge' }).click();
        await row.getByRole('button', { name: 'Confirm stop' }).waitFor();
        assert.equal(await focused(), 'Confirm stop');
        assert.match(
          await row.getByRole('button', { name: 'Confirm stop' }).getAttribute('aria-describedby'),
          /^stop-/,
        );
        await row.getByRole('button', { name: 'Cancel' }).click();
        assert.equal(await focused(), 'Stop automatic Knowledge');
        assert.equal(writes.length, 0);
        await row.getByRole('button', { name: 'Stop automatic Knowledge' }).click();
        await row.getByRole('button', { name: 'Confirm stop' }).click();
        await row.getByText('Automatic Knowledge off', { exact: true }).waitFor();
        await page.waitForFunction(
          () => document.activeElement?.textContent?.trim() === 'Turn automatic Knowledge back on',
        );
        await row.getByRole('button', { name: 'Turn automatic Knowledge back on' }).click();
        await row.getByText('Queued for indexing', { exact: true }).waitFor();
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Stop automatic Knowledge');
        assert.deepEqual(
          writes.map(write => [write.id, write.action]),
          [
            [intent(2).intentId, 'opt-out'],
            [intent(2).intentId, 'resume'],
          ],
        );

        section = await open('slack');
        await section
          .getByRole('listitem', { name: 'Slack Ada · Acme Slack' })
          .getByText('Queued for indexing. Your integration is ready to use now.')
          .waitFor();

        section = await open('github-personal');
        const github = section.getByRole('listitem', { name: 'GitHub ada-dev' });
        await github.getByText('27 of 27 repositories included; 1 kept as your own choices.').waitFor();
        await github
          .getByText(
            'Some content is not searchable: 2 failed, 212 skipped by import limits, 4 over the workspace limit. Coverage is partial.',
          )
          .waitFor();
        await github.getByText('Partly searchable', { exact: true }).waitFor();
        assert.equal(await github.getByText('Sync complete', { exact: true }).count(), 0);

        section = await open('confluence');
        const confluence = section.getByRole('listitem', { name: 'Confluence Ada Lovelace' });
        await confluence.getByText('Partly searchable', { exact: true }).waitFor();
        await confluence
          .getByText(
            /Acme Finance \(no access\), Acme Labs \(missing permission\)\. TulipFarm keeps checking them; other sites are still imported\./,
          )
          .waitFor();

        section = await open('slack');
        const empty = section.getByRole('listitem', { name: 'Slack Ada · Acme Slack' });
        await empty.getByText('Queued for indexing. Your integration is ready to use now.').waitFor();
        assert.equal(await empty.getByText(/^0 of 0/).count(), 0);
        await page.screenshot({ path: `${screenshots}/status-desktop.png`, fullPage: true });
      },
      {
        items: [
          intent(2, 'gmail', 'ada@example.test', {
            syncState: 'discovering',
            discoveredAt: null,
            counts: counts(212, 96),
          }),
          intent(3, 'slack', 'Ada · Acme Slack', { syncState: 'queued', discoveredAt: null }),
          intent(4, 'github', 'ada-dev', {
            scopes: { discovered: 27, included: 27, manual: 1 },
            counts: counts(5400, 0, 2, 212, 4),
          }),
          intent(6, 'confluence', 'Ada Lovelace', {
            scopes: { discovered: 9, included: 9, manual: 0 },
            counts: counts(2300),
            groupFailures: [
              { title: 'Acme Finance', failure: 'forbidden' },
              { title: 'Acme Labs', failure: 'insufficient-scope' },
            ],
          }),
        ],
      },
    );

    await fixture(
      async ({ page, open, writes }) => {
        const cases = [
          [
            'gmail',
            'Gmail ada@example.test',
            'Retrying',
            /Gmail is busy or unavailable\. TulipFarm retries automatically/,
          ],
          [
            'slack',
            'Slack Ada · Acme Slack',
            'Limit reached',
            /TulipFarm never buys credits or raises limits for you\./,
          ],
          [
            'github-personal',
            'GitHub ada-dev',
            'Needs authorization',
            /TulipFarm can’t reach GitHub with this account\. Content already imported stays as it is\. Choose Reconnect @ada-dev, then Retry now\./,
          ],
          [
            'google-drive',
            'Google Drive ada@example.test',
            'Needs authorization',
            /A different Google Drive account is connected now\. Sign in as ada@example\.test when you reconnect\./,
          ],
          [
            'jira',
            'Jira Ada Lovelace',
            'Partly imported',
            /More than 2,000 projects were found\. The rest are not imported\./,
          ],
          [
            'confluence',
            'Confluence Ada Lovelace',
            'Sync failed',
            /Automatic Knowledge stopped\. Content already imported is kept\./,
          ],
        ];
        for (const [app, name, badge, message] of cases) {
          const row = (await open(app)).getByRole('listitem', { name });
          await row.getByText(badge, { exact: true }).waitFor();
          await row.getByText(message).waitFor();
        }
        const slack = (await open('slack')).getByRole('listitem', { name: 'Slack Ada · Acme Slack' });
        assert.equal(await slack.getByRole('button', { name: 'Retry now' }).count(), 0);
        await slack.getByRole('button', { name: 'Check again' }).waitFor();
        const row = (await open('confluence')).getByRole('listitem', { name: 'Confluence Ada Lovelace' });
        await row.getByText(/^No spaces were found for this account yet\./).waitFor();
        assert.equal(await row.getByText(/^0 of 0/).count(), 0);
        await row.getByRole('button', { name: 'Retry now' }).click();
        await row.getByText('Queued for indexing', { exact: true }).waitFor();
        assert.deepEqual(
          writes.map(write => [write.id, write.action]),
          [[intent(6).intentId, 'retry']],
        );
        await page.screenshot({ path: `${screenshots}/failures-mobile.png`, fullPage: true });
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          'Narrow layout must not scroll sideways',
        );
      },
      {
        mobile: true,
        items: [
          intent(2, 'gmail', 'ada@example.test', { syncState: 'failed', failure: 'rate-limited', counts: counts(640) }),
          intent(3, 'slack', 'Ada · Acme Slack', {
            syncState: 'failed',
            failure: 'quota',
            counts: counts(4200, 0, 0, 0, 318),
          }),
          intent(4, 'github', 'ada-dev', {
            syncState: 'failed',
            failure: 'reconnect-required',
            counts: counts(5400),
            accountKey: devAccount.id,
          }),
          intent(1, 'google-drive', 'ada@example.test', {
            syncState: 'failed',
            failure: 'account-changed',
            counts: counts(1180),
          }),
          intent(5, 'jira', 'Ada Lovelace', {
            syncState: 'failed',
            failure: 'scope-limit',
            scopes: { discovered: 2400, included: 2000, manual: 0 },
            counts: counts(18000),
          }),
          intent(6, 'confluence', 'Ada Lovelace', { syncState: 'failed', failure: 'not-found', counts: counts(10) }),
        ],
      },
    );

    const repairItems = [
      intent(1, 'google-drive', 'ada@example.test', {
        syncState: 'failed',
        failure: 'account-changed',
        counts: counts(1180),
        accountKey: 'ada',
      }),
      intent(2, 'gmail', 'ada@example.test', {
        syncState: 'failed',
        failure: 'reconnect-required',
        counts: counts(640),
        accountKey: 'ada',
      }),
      intent(3, 'slack', '@UADA', {
        syncState: 'failed',
        failure: 'not-linked',
        counts: counts(4200),
        accountKey: 'TACME:UADA',
      }),
      intent(4, 'github', 'ada-dev', {
        syncState: 'failed',
        failure: 'forbidden',
        counts: counts(5400),
        accountKey: devAccount.id,
      }),
      intent(5, 'jira', 'Ada Lovelace', {
        syncState: 'failed',
        failure: 'consent-required',
        counts: counts(900),
        accountKey: restAccount([]).id,
      }),
      intent(6, 'confluence', 'Ada Lovelace', {
        syncState: 'failed',
        failure: 'insufficient-scope',
        counts: counts(300),
        accountKey: restAccount([]).id,
      }),
    ];
    // Each Reconnect must start the provider's own repair for the account behind the intent, not focus a nearby panel.
    await fixture(
      async ({ page, open, writes }) => {
        const repairs = [
          [
            'google-drive',
            'Google Drive ada@example.test',
            'Reconnect Google Drive',
            /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/,
            { kind: 'google-begin', app: 'drive' },
          ],
          [
            'gmail',
            'Gmail ada@example.test',
            'Reconnect Gmail',
            /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/,
            { kind: 'google-begin', app: 'gmail' },
          ],
          [
            'github-personal',
            'GitHub ada-dev',
            'Reconnect @ada-dev',
            /^https:\/\/github\.com\/login\/oauth\/authorize/,
            { kind: 'github-reconnect', id: devAccount.id },
          ],
          [
            'jira',
            'Jira Ada Lovelace',
            'Reconnect Atlassian Knowledge access',
            /^https:\/\/auth\.atlassian\.com\/authorize/,
            { kind: 'atlassian-reconnect', id: restAccount([]).id },
          ],
          [
            'confluence',
            'Confluence Ada Lovelace',
            'Reconnect Atlassian Knowledge access',
            /^https:\/\/auth\.atlassian\.com\/authorize/,
            { kind: 'atlassian-reconnect', id: restAccount([]).id },
          ],
        ];
        for (const [app, name, label, destination, write] of repairs) {
          const row = (await open(app)).getByRole('listitem', { name });
          await row.getByText('Needs authorization', { exact: true }).waitFor();
          await row.getByText(`Choose ${label}, then Retry now.`, { exact: false }).waitFor();
          assert.equal(await row.getByRole('button', { name: /^Reconnect/ }).count(), 1, `${app} offers one repair`);
          if (app === 'github-personal') {
            assert.equal(await page.getByRole('button', { name: 'Reconnect @ada-work' }).count(), 0);
            await page.screenshot({ path: `${screenshots}/repair-github-two-accounts.png`, fullPage: true });
          }
          await row.getByRole('button', { name: label, exact: true }).click();
          await page.waitForURL(destination);
          assert.deepEqual(writes.at(-1), write);
        }
        assert.equal(
          writes.filter(write => write.kind === 'atlassian-begin').length,
          0,
          'Atlassian repair never begins an MCP or new sign-in when the REST account exists',
        );
        const slack = (await open('slack')).getByRole('listitem', { name: 'Slack @UADA' });
        await slack
          .getByText(/Message TulipFarm in Slack to link your Slack account again, then choose Retry now\./)
          .waitFor();
        assert.equal(
          await slack.getByRole('button', { name: /^Reconnect/ }).count(),
          0,
          'No Reconnect label without a repair flow',
        );
        assert.equal(await slack.getByRole('link', { name: /^Reconnect/ }).count(), 0);
        await slack.getByRole('button', { name: 'Retry now' }).waitFor();
      },
      {
        items: repairItems,
        githubAccounts: [workAccount, devAccount],
        atlassian: [restAccount(['read:me', 'offline_access'])],
      },
    );

    await fixture(
      async ({ page, open }) => {
        const row = (await open('slack')).getByRole('listitem', { name: 'Slack @UADA' });
        await row.getByRole('link', { name: 'Reconnect my Slack account' }).click();
        await page.waitForURL(
          url =>
            url.pathname === '/slack/link' &&
            url.searchParams.get('eventId') === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' &&
            url.searchParams.get('workspaceId') === workspace.id,
        );
      },
      {
        items: repairItems,
        slack: { ...linkedSlack, linked: false, recoveryEventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      },
    );

    await fixture(
      async ({ page, open, writes }) => {
        const row = (await open('slack')).getByRole('listitem', { name: 'Slack @UADA' });
        await row.getByRole('button', { name: 'Reconnect Slack workspace' }).click();
        await page.waitForURL(/^https:\/\/slack\.com\/oauth\/v2\/authorize/);
        assert.deepEqual(writes, [{ kind: 'slack-install' }]);
      },
      { items: repairItems, slack: { ...linkedSlack, state: 'reconnect-required', canManage: true } },
    );

    await fixture(
      async ({ page, open }) => {
        const row = (await open('slack')).getByRole('listitem', { name: 'Slack @UADA' });
        await row.getByText(/Ask a workspace admin to reconnect Slack, then choose Retry now\./).waitFor();
        assert.equal(await row.getByRole('button', { name: /^Reconnect/ }).count(), 0);
        const github = (await open('github-personal')).getByRole('listitem', { name: 'GitHub ada-dev' });
        await github
          .getByText(
            /This GitHub login is no longer connected here\. Connect it again in GitHub accounts below, then choose Retry now\./,
          )
          .waitFor();
        assert.equal(await github.getByRole('button', { name: /^Reconnect/ }).count(), 0);
        await page.screenshot({ path: `${screenshots}/repair-hints-mobile.png`, fullPage: true });
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          'Narrow layout must not scroll sideways',
        );
      },
      {
        mobile: true,
        items: repairItems,
        slack: { ...linkedSlack, state: 'reconnect-required' },
        githubAccounts: [workAccount],
      },
    );

    // Discovery can be finished while provider import is still pending or has failed source-wide.
    await fixture(
      async ({ page, open, writes }) => {
        const drive = (await open('google-drive')).getByRole('listitem', { name: 'Google Drive ada@example.test' });
        await drive.getByText('Queued for indexing', { exact: true }).waitFor();
        await drive
          .getByText('Finished finding sources. 2 sources are still importing; items become searchable as they finish.')
          .waitFor();
        assert.equal(await drive.getByText('Sync complete', { exact: true }).count(), 0);
        const gmail = (await open('gmail')).getByRole('listitem', { name: 'Gmail ada@example.test' });
        await gmail.getByText('Sync failed', { exact: true }).waitFor();
        await gmail
          .getByText(
            'One source stopped importing from Gmail. Content already imported is kept. Choose Retry now to try again.',
          )
          .waitFor();
        await gmail.getByRole('button', { name: 'Retry now' }).click();
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Stop automatic Knowledge');
        assert.deepEqual(
          writes.map(write => [write.id, write.action]),
          [[intent(2).intentId, 'retry']],
        );
      },
      {
        items: [
          intent(1, 'google-drive', 'ada@example.test', {
            counts: counts(300),
            ingestion: { state: 'pending', pending: 2, failed: 0, failure: null },
          }),
          intent(2, 'gmail', 'ada@example.test', {
            counts: counts(640),
            ingestion: { state: 'failed', pending: 0, failed: 1, failure: 'provider' },
          }),
        ],
      },
    );

    await fixture(
      async ({ page, open }) => {
        await (
          await open('jira')
        )
          .getByText(/Knowledge access is allowed for Ada Lovelace\. It was set up before automatic Knowledge/)
          .waitFor();
        const section = await open('confluence');
        await section.getByText('Knowledge access needed', { exact: true }).waitFor();
        await section.getByText(/doesn’t include reading Confluence pages/).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Allow Knowledge access' }).count(), 1);
      },
      { atlassian: [restAccount(['read:me', 'read:jira-work', 'offline_access'])] },
    );

    let releaseAccounts;
    await fixture(
      async ({ open, state }) => {
        const section = await open('jira');
        await section.getByRole('status', { name: 'Checking automatic Knowledge' }).waitFor();
        releaseAccounts();
        await section
          .getByText('Couldn’t check Atlassian Knowledge access', { exact: true })
          .waitFor({ timeout: 30_000 });
        state.atlassianStatus.length = 0;
        await section.getByRole('button', { name: 'Retry Knowledge access check' }).click();
        await section.getByText('Knowledge access needed', { exact: true }).waitFor();
      },
      {
        atlassianStatus: Array(10).fill(503),
        atlassianGate: new Promise(resolve => {
          releaseAccounts = resolve;
        }),
      },
    );

    // A failed Atlassian account check offers a check again in place, and the exact repair appears once it succeeds.
    await fixture(
      async ({ page, open, state }) => {
        const row = (await open('jira')).getByRole('listitem', { name: 'Jira Ada Lovelace' });
        await row
          .getByText(/Couldn’t check Atlassian Knowledge access\. Choose Check Atlassian again\./)
          .waitFor({ timeout: 30_000 });
        assert.equal(
          await row.getByRole('button', { name: /^Reconnect/ }).count(),
          0,
          'No Reconnect label until the account is known',
        );
        assert.equal(await page.getByText(/Reload this page/).count(), 0);
        await page.screenshot({ path: `${screenshots}/repair-atlassian-check-failed.png`, fullPage: true });
        state.atlassianStatus.length = 0;
        await row.getByRole('button', { name: 'Check Atlassian again' }).click();
        await row.getByRole('button', { name: 'Reconnect Atlassian Knowledge access', exact: true }).waitFor();
        assert.equal(await row.getByRole('button', { name: 'Check Atlassian again' }).count(), 0);
      },
      {
        items: [repairItems[4]],
        atlassian: [restAccount(['read:me', 'offline_access'])],
        atlassianStatus: Array(10).fill(503),
      },
    );

    // Back from the provider can restore the page from the back/forward cache; Reconnect must be usable again.
    let releaseReconnect;
    await fixture(
      async ({ page, open, writes }) => {
        const row = (await open('jira')).getByRole('listitem', { name: 'Jira Ada Lovelace' });
        const reconnect = row.getByRole('button', { name: 'Reconnect Atlassian Knowledge access', exact: true });
        await reconnect.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('button')].some(
            button => button.textContent?.includes('Reconnect Atlassian') && button.disabled,
          ),
        );
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        await page.waitForFunction(() =>
          [...document.querySelectorAll('button')].some(
            button =>
              button.textContent?.includes('Reconnect Atlassian') &&
              !button.disabled &&
              button.getAttribute('aria-busy') !== 'true',
          ),
        );
        await reconnect.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('button')].some(
            button => button.textContent?.includes('Reconnect Atlassian') && button.disabled,
          ),
        );
        assert.equal(
          writes.filter(write => write.kind === 'atlassian-reconnect').length,
          2,
          'the restored button starts the repair again',
        );
        const consent = page.waitForRequest(/^https:\/\/auth\.atlassian\.com\/authorize/);
        releaseReconnect();
        await consent;
      },
      {
        items: [repairItems[4]],
        atlassian: [restAccount(['read:me', 'offline_access'])],
        reconnectGate: new Promise(resolve => {
          releaseReconnect = resolve;
        }),
      },
    );

    await fixture(async ({ page, open, writes }) => {
      const section = await open('jira');
      await section.getByText(/Jira and Confluence tools use a separate Atlassian sign-in\./).waitFor();
      await section.getByRole('button', { name: 'Allow Knowledge access' }).click();
      await page.waitForURL(/^https:\/\/auth\.atlassian\.com\/authorize/);
      assert.deepEqual(writes, [
        { kind: 'atlassian-begin', body: { protocol: 'atlassian-rest', ownership: { kind: 'personal' } } },
      ]);
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
