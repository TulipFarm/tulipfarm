import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const { workspace, session } = createWorkspaceFixture({ slug: 'sharing-proof', name: 'Sharing proof' });
const memberId = randomUUID(),
  otherId = randomUUID(),
  teamId = randomUUID(),
  hiddenTeamId = randomUUID(),
  accountId = randomUUID();
const port = 21000 + Math.floor(Math.random() * 20000),
  origin = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
);
let browser;
let recipientsStatus = 503,
  slackStatus = 'active',
  accountList = [],
  version = 1,
  admin = true,
  grantsStatus = 200;
let slack = {
  expectedVersion: 'one',
  use: { memberIds: [memberId], teamIds: [hiddenTeamId] },
  managers: { memberIds: [memberId], teamIds: [hiddenTeamId] },
};
let atlassian = {
  expectedVersion: 1,
  memberIds: [memberId],
  teamIds: [],
  managers: { memberIds: [memberId], teamIds: [] },
};
const writes = [],
  errors = [];
const screenshot = process.env.SLACK_SHARING_SCREENSHOT ?? 'reports/check/slack-settings/sharing';
try {
  await mkdir(dirname(screenshot), { recursive: true });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    assert.ok(i < 100);
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/v1/**', async route => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let json,
      status = 200;
    if (path === '/v1/auth/get-session') json = session;
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: memberId,
        role: admin ? 'admin' : 'member',
        teams: [{ id: teamId, name: 'Engineering' }],
        capabilities: { manageGovernance: admin, canLeave: true },
      };
    else if (path.endsWith('/integrations/collaborators')) {
      status = recipientsStatus;
      json = {
        members: [
          { id: memberId, name: 'user-ada' },
          { id: otherId, name: 'user-bob' },
        ],
        teams: [{ id: teamId, name: 'Engineering' }],
      };
    } else if (path.endsWith('/governance/directory'))
      json = {
        members: [
          { id: memberId, name: 'Ada', email: 'ada@example.com', image: null },
          { id: otherId, name: 'Bob', email: 'bob@example.com', image: null },
        ],
      };
    else if (path.endsWith('/integrations/creation-context')) json = { teams: [{ id: teamId, name: 'Engineering' }] };
    else if (path.endsWith('/integrations')) json = { integrations: [] };
    else if (path.endsWith('/workspace-mcp/capabilities')) json = { enabled: false };
    else if (path.endsWith('/slack/status'))
      json = {
        state: slackStatus,
        teamId: slackStatus === 'unavailable' ? null : 'TONE',
        canManage: slackStatus === 'active',
        linked: true,
        scopes: [],
      };
    else if (path.endsWith('/slack/grants')) {
      await setTimeout(250);
      status = grantsStatus;
      if (request.method() === 'PUT') {
        writes.push(request.postDataJSON());
        if (status === 200) slack = { ...request.postDataJSON(), expectedVersion: String(++version) };
      }
      json = slack;
    } else if (path.endsWith('/slack/channels'))
      json = { channels: [{ id: 'CGENERAL', name: 'general', private: false }], complete: true, missingScopes: [] };
    else if (path.endsWith('/atlassian/accounts'))
      json = { accounts: accountList, providers: [{ protocol: 'atlassian-mcp', configured: true }] };
    else if (path.endsWith('/atlassian/sources'))
      json = { sources: [], mcp: { enabled: false, explanation: 'Provider tools unavailable.' } };
    else if (path.endsWith(`/accounts/${accountId}/grants`)) {
      if (request.method() === 'PUT') {
        writes.push(request.postDataJSON());
        atlassian = { ...request.postDataJSON(), expectedVersion: ++version };
        accountList[0].grantsVersion = version;
        json = accountList[0];
      } else json = atlassian;
    } else {
      status = 404;
      json = { error: 'not-found' };
    }
    await route.fulfill({ status, json });
  });
  await page.goto(`${origin}/${workspace.slug}/integrations#slack`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Slack workspace connected', exact: true }).count(), 0);
  assert.equal(await page.getByText('Connected to TONE.', { exact: false }).count(), 0);
  await page.getByRole('heading', { name: 'Could not load Slack sharing' }).waitFor();
  await Promise.all([
    page.waitForResponse(
      response => response.url().endsWith('/integrations/collaborators') && response.status() === 503,
    ),
    page.getByRole('button', { name: 'Reload Slack sharing' }).click(),
  ]);
  await page.getByRole('heading', { name: 'Could not load Slack sharing' }).waitFor();
  recipientsStatus = 200;
  await page.getByRole('button', { name: 'Reload Slack sharing' }).click();
  const sharing = page.getByRole('region', { name: 'Slack sharing', exact: true });
  await sharing.getByRole('checkbox', { name: 'Use Bob', exact: true }).check();
  assert.equal(await sharing.getByRole('checkbox', { name: 'Manage Bob', exact: true }).isChecked(), false);
  await sharing.getByRole('checkbox', { name: 'Manage Engineering', exact: true }).check();
  assert.equal(await sharing.getByRole('checkbox', { name: 'Use Engineering', exact: true }).isChecked(), false);
  for (const name of ['Ada', 'Bob', 'Engineering'])
    assert.equal(await sharing.getByText(name, { exact: true }).count(), 1);
  assert.equal(await sharing.getByRole('listitem').count(), 3);
  await page.getByRole('button', { name: 'Save Slack sharing' }).dblclick();
  await page.getByText(/Slack sharing saved/).waitFor();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].use.memberIds, [memberId, otherId]);
  assert.deepEqual(writes[0].use.teamIds, [hiddenTeamId]);
  assert.deepEqual(writes[0].managers.teamIds, [hiddenTeamId, teamId]);
  assert.equal(writes[0].expectedVersion, 'one');
  assert.equal(await sharing.getByText('Unsaved changes', { exact: true }).count(), 0);

  await sharing.getByRole('checkbox', { name: 'Manage Bob', exact: true }).check();
  grantsStatus = 503;
  await sharing.getByRole('button', { name: 'Save Slack sharing', exact: true }).click();
  await sharing
    .getByText('Sharing could not be confirmed. Your changes are kept. Reload sharing before submitting again.')
    .waitFor();
  await Promise.all([
    page.waitForResponse(
      response =>
        response.url().endsWith('/slack/grants') && response.request().method() === 'GET' && response.status() === 503,
    ),
    sharing.getByRole('button', { name: 'Reload Slack sharing', exact: true }).click(),
  ]);
  await sharing.getByText('Reload Slack sharing before saving.', { exact: true }).waitFor();
  assert.equal(await sharing.getByRole('checkbox', { name: 'Manage Bob', exact: true }).isChecked(), true);
  grantsStatus = 200;
  slack = { ...slack, expectedVersion: String(++version) };
  await sharing.getByRole('button', { name: 'Reload Slack sharing', exact: true }).click();
  await sharing.getByText('Sharing changed. Discard your changes to load the latest permissions.').waitFor();
  assert.equal(await sharing.getByRole('checkbox', { name: 'Manage Bob', exact: true }).isChecked(), true);
  assert.equal(
    await sharing.getByRole('button', { name: 'Save Slack sharing', exact: true }).getAttribute('aria-disabled'),
    'true',
  );
  await sharing.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.waitForFunction(() => !document.body.textContent.includes('Wait for sharing to finish loading.'));
  assert.equal(await sharing.getByRole('checkbox', { name: 'Manage Bob', exact: true }).isChecked(), false);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await sharing.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await sharing.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: `${screenshot}-${colorScheme}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  admin = false;
  await page.goto(`${origin}/${workspace.slug}/integrations#slack`);
  await page.reload();
  await page.getByRole('button', { name: 'Your account', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('region', { name: 'Settings', exact: true }).count(),
    0,
    'Members cannot open workspace Slack settings or sharing',
  );
  await page.goto(`${origin}/${workspace.slug}/integrations#atlassian-heading`);
  await page.getByRole('checkbox', { name: 'Shared business account', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect account', exact: true }).isEnabled(), true);
  accountList = [
    {
      id: accountId,
      protocol: 'atlassian-mcp',
      ownership: 'business',
      state: 'active',
      configured: true,
      identity: { id: 'provider', label: 'Shared Jira', qualification: 'grant-bound-needs-qualification' },
      resources: [],
      scopes: [],
      generation: 1,
      grantsVersion: 1,
      capabilities: { read: true, manage: true, use: true },
    },
  ];
  await page.getByRole('button', { name: 'Check integration status', exact: true }).click();
  await page.getByRole('button', { name: 'Manage use grants' }).click();
  await page.getByRole('checkbox', { name: 'Allow Bob to use account', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Allow Engineering to manage and share', exact: true }).check();
  await page.getByRole('button', { name: 'Save use grants' }).click();
  await page.getByText(/Use grants saved/).waitFor();
  assert.deepEqual(writes.at(-1).managers.teamIds, [teamId]);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  slackStatus = 'unavailable';
  admin = true;
  await page.goto(`${origin}/${workspace.slug}/integrations#slack`);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Slack integration unavailable' }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Slack sharing', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS compact Slack sharing, no connected banner, one row per recipient, independent Use/Manage controls, hidden grants retained, failed read/write, retained drafts on refresh/conflict, discard, double submit, admin visibility, Atlassian controls, and narrow themes.',
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: `${screenshot}-failure.png` });
    console.error(await page.getByRole('dialog').ariaSnapshot());
  }
  console.error(errors);
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
