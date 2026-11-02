import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createWorkspaceFixture, serveWorkspaceShellEvent } from './workspace.fixture.mjs';

const counts = (ready, queued = 0) => ({
  total: ready + queued,
  ready,
  queued,
  failed: 0,
  skipped: 0,
  quotaLimited: 0,
});
const githubSource = (n, title, repositories, rest = {}) => ({
  sourceId: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
  selection: null,
  memberIds: [],
  title,
  state: 'active',
  syncState: 'ready',
  failure: null,
  nextAttemptAt: new Date(Date.now() + 240_000).toISOString(),
  repositories: Array.from({ length: repositories }, (_, i) => ({
    repositoryId: String(i + 1),
    fullName: `acme/repo-${i}`,
    visibility: 'private',
    title: `acme/repo-${i}`,
    state: 'active',
    failure: null,
  })),
  counts: { total: 21, ready: 21, failed: 0 },
  canManage: true,
  ...rest,
});
const intent = (n, product, accountLabel, included, rest = {}) => ({
  intentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  product,
  accountLabel,
  state: 'active',
  syncState: 'ready',
  failure: null,
  discoveredAt: '2026-10-16T09:00:00.000Z',
  nextAttemptAt: new Date(Date.now() + 240_000).toISOString(),
  scopes: { discovered: included, included, manual: 0 },
  sources: [],
  counts: counts(0),
  groupFailures: [],
  accountKey: `account-${n}`,
  ingestion: { state: 'ready', pending: 0, failed: 0, failure: null },
  ...rest,
});

test('the Knowledge page lists every automatic source and manages it in Chromium', { timeout: 120_000 }, async () => {
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
  const screenshots = fileURLToPath(new URL('../../../reports/check/knowledge-page-ui/', import.meta.url));
  await mkdir(screenshots, { recursive: true });
  const { workspace, session } = createWorkspaceFixture({ slug: 'knowledge-qa', name: 'Knowledge QA' });
  const items = [
    intent(1, 'github', 'ada-dev', 1, {
      sources: [
        {
          sourceId: '00000000-0000-4000-9000-000000000001',
          state: 'created',
          failure: null,
          sourceState: 'active',
          syncState: 'ready',
          syncFailure: null,
        },
      ],
      counts: counts(5, 7),
      ingestion: { state: 'pending', pending: 7, failed: 0, failure: null },
    }),
    intent(2, 'gmail', 'ada@example.test', 1, { state: 'opted-out' }),
    intent(3, 'google-drive', 'ada@example.test', 3, { counts: counts(8) }),
    intent(5, 'jira', 'Ada Lovelace', 2, { syncState: 'failed', failure: 'provider', counts: counts(3) }),
  ];
  // The automatic source is already counted by its intent, and removed sources stay hidden.
  const github = [
    githubSource(1, 'All repositories', 0, { repositories: null }),
    githubSource(2, 'acme/repo-0 and 9 more', 10),
    githubSource(3, 'acme/old', 1, { state: 'removed' }),
  ];
  const writes = [],
    errors = [];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/v1/**', async route => {
    if (await serveWorkspaceShellEvent(route, workspace)) return;
    const request = route.request(),
      path = new URL(request.url()).pathname,
      base = `/v1/workspaces/${workspace.id}`;
    const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' };
    if (request.method() === 'OPTIONS')
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
    else if (path === `${base}/knowledge/defaults`) json = { enabled: true, items };
    else if (path.startsWith(`${base}/knowledge/defaults/`) && path.endsWith('/manage')) {
      const id = path.split('/defaults/')[1].split('/')[0],
        { action } = request.postDataJSON();
      writes.push([id.slice(-1), action]);
      const target = items.find(item => item.intentId === id);
      Object.assign(
        target,
        action === 'opt-out' ? { state: 'opted-out' } : { state: 'active', syncState: 'queued', failure: null },
      );
      json = target;
    } else if (path === `${base}/knowledge/github/sources`) json = { items: github };
    else if (path.startsWith(`${base}/knowledge/github/sources/`) && path.endsWith('/manage')) {
      const id = path.split('/sources/')[1].split('/')[0],
        { action } = request.postDataJSON();
      writes.push([`github-${id.slice(-1)}`, action]);
      const target = github.find(source => source.sourceId === id);
      target.state = action === 'pause' ? 'paused' : 'active';
      json = target;
    } else if (path.endsWith('/bud'))
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

  try {
    await page.goto(`${origin}/${workspace.slug}/knowledge`);
    const main = page.getByRole('main');
    // The automatic GitHub source and the hand-picked one share one row: 26 of 33 items are searchable.
    await main.getByText('ada-dev · all repositories', { exact: true }).waitFor();
    await main.getByText('78%', { exact: true }).waitFor();
    assert.equal(await main.getByRole('button', { name: 'Actions for GitHub' }).count(), 1);
    assert.equal(await main.getByText('acme/', { exact: false }).count(), 0);
    await main.getByText('ada@example.test · 3 drives', { exact: true }).waitFor();
    await main.getByText('ada@example.test · 1 mailbox', { exact: true }).waitFor();
    for (const product of ['Slack', 'Confluence'])
      await main.getByRole('button', { name: `Connect ${product}` }).waitFor();
    await page.getByRole('link', { name: 'Knowledge', exact: true }).waitFor();
    await page.screenshot({ path: `${screenshots}/sources.png`, fullPage: true });

    await main.getByRole('button', { name: 'Retry Jira' }).click();
    await main.getByRole('button', { name: 'Retry Jira' }).waitFor({ state: 'detached' });
    await main.getByRole('button', { name: 'Actions for Google Drive' }).click();
    await page.getByRole('menuitem', { name: 'Pause syncing' }).click();
    await main.getByRole('button', { name: 'Actions for Gmail' }).click();
    await page.getByRole('menuitem', { name: 'Resume syncing' }).click();
    for (let tries = 0; writes.length < 3 && tries < 50; tries++) await page.waitForTimeout(100);
    await main.getByRole('button', { name: 'Actions for GitHub' }).click();
    await page.getByRole('menuitem', { name: 'Pause syncing' }).click();
    for (let tries = 0; writes.length < 5 && tries < 50; tries++) await page.waitForTimeout(100);
    assert.deepEqual(writes.slice(0, 3), [
      ['5', 'retry'],
      ['3', 'opt-out'],
      ['2', 'resume'],
    ]);
    assert.deepEqual(writes.slice(3).sort(), [
      ['1', 'opt-out'],
      ['github-2', 'pause'],
    ]);

    await main.getByRole('button', { name: 'Connect Slack' }).click();
    await page.waitForURL(`${origin}/${workspace.slug}/integrations/slack?tab=knowledge`);

    Object.assign(items[0], {
      counts: counts(12),
      ingestion: { state: 'ready', pending: 0, failed: 0, failure: null },
    });
    await page.goto(`${origin}/${workspace.slug}/knowledge`);
    await main.getByRole('button', { name: 'Actions for GitHub' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.waitForURL(`${origin}/${workspace.slug}/integrations/github?tab=knowledge`);
    await page.getByRole('heading', { name: 'GitHub', exact: true }).waitFor();
    await page.goto(`${origin}/${workspace.slug}/integrations/github-personal?tab=knowledge`);
    await page.waitForURL(`${origin}/${workspace.slug}/integrations/github?tab=knowledge`);
    await page.getByRole('heading', { name: 'GitHub', exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
