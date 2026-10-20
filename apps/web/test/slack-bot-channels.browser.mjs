import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const { workspace, session } = createWorkspaceFixture({ slug: 'slack-channels', name: 'Slack channels' });
const memberId = randomUUID();
const port = 21000 + Math.floor(Math.random() * 20000),
  origin = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
);
const screenshot = process.env.SLACK_CHANNELS_SCREENSHOT ?? 'reports/check/slack-settings/channels.png';
let browser;
let channelsStatus = 503;
let role = 'member';
let channelRequests = 0;
let channels = {
  channels: [
    { id: 'GLEAD', name: 'leadership', private: true },
    { id: 'CRANDOM', name: 'random', private: false },
  ],
  complete: true,
  missingScopes: [],
};
const errors = [];
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
    const path = new URL(route.request().url()).pathname;
    let json,
      status = 200;
    if (path === '/v1/auth/get-session') json = session;
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: memberId,
        role,
        teams: [],
        capabilities: { manageGovernance: role === 'admin', canLeave: true },
      };
    else if (path.endsWith('/integrations')) json = { integrations: [] };
    else if (path.endsWith('/workspace-mcp/capabilities')) json = { enabled: false };
    else if (path.endsWith('/slack/status'))
      json = {
        state: 'active',
        teamId: 'TONE',
        canManage: false,
        linked: true,
        scopes: ['chat:write', 'channels:read', 'groups:read'],
      };
    else if (path.endsWith('/slack/channels')) {
      channelRequests++;
      await setTimeout(250);
      status = channelsStatus;
      json = status === 200 ? channels : { error: 'slack-unavailable' };
    } else if (path.endsWith('/atlassian/accounts')) json = { accounts: [], providers: [] };
    else {
      status = 404;
      json = { error: 'not-found' };
    }
    await route.fulfill({ status, json });
  });
  const section = page.getByRole('region', { name: 'Channels', exact: true });
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  const openSettings = () => settings.getByRole('button', { name: 'Settings' }).click();
  await page.goto(`${origin}/${workspace.slug}/integrations#slack`);
  const account = page.getByRole('region', { name: 'Your account', exact: true });
  await account.getByRole('button', { name: 'Your account' }).click();
  await account.getByRole('region', { name: 'Your Slack account' }).waitFor();
  assert.equal(await settings.count(), 0);
  assert.equal(await section.count(), 0);
  assert.equal(channelRequests, 0);

  role = 'admin';
  await page.reload();
  await openSettings();
  await section.getByRole('heading', { name: 'Loading channels', exact: true }).waitFor();
  assert.equal(await section.getByRole('heading', { name: 'Not in any channels yet' }).count(), 0);
  await section.getByRole('heading', { name: 'Could not load channels' }).waitFor();
  channelsStatus = 200;
  await section.getByRole('button', { name: 'Refresh', exact: true }).click();
  const list = section.getByRole('list', { name: 'Slack channels with TulipFarm' });
  await list.waitFor();
  assert.deepEqual(await list.getByRole('listitem').allInnerTexts(), ['leadership', 'random']);
  await list.getByRole('img', { name: 'Private channel' }).waitFor();
  await list.getByRole('img', { name: 'Public channel' }).waitFor();
  await page.screenshot({ path: screenshot, fullPage: false });
  assert.equal(await section.getByText('2', { exact: true }).count(), 1);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await section.scrollIntoViewIfNeeded();
    assert.equal(await section.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: `${screenshot.replace(/\.png$/, '')}-${colorScheme}.png`, fullPage: false });
  }

  channels = {
    channels: [{ id: 'CRANDOM', name: 'random', private: false }],
    complete: false,
    missingScopes: ['groups:read'],
  };
  await section.getByRole('button', { name: 'Refresh', exact: true }).click();
  await section.getByText('Private channels are hidden because Slack did not grant read access to them.').waitFor();
  await section.getByText('Showing the first 1 channels.').waitFor();

  channelsStatus = 503;
  await section.getByRole('button', { name: 'Refresh', exact: true }).click();
  await section.getByRole('button', { name: 'Refreshing…', exact: true }).waitFor();
  assert.deepEqual(await list.getByRole('listitem').allInnerTexts(), ['random']);
  await section.getByText('Channels could not refresh. Showing the last loaded list.').waitFor();
  assert.deepEqual(await list.getByRole('listitem').allInnerTexts(), ['random']);

  channelsStatus = 200;
  channels = { channels: [], complete: true, missingScopes: [] };
  await section.getByRole('button', { name: 'Refresh', exact: true }).click();
  await section.getByRole('heading', { name: 'Not in any channels yet' }).waitFor();
  channelsStatus = 503;
  await section.getByRole('button', { name: 'Refresh', exact: true }).click();
  await section.getByText('Channels could not refresh. Showing the last loaded list.').waitFor();
  await section.getByRole('heading', { name: 'Not in any channels yet' }).waitFor();

  channelsStatus = 200;
  channels = { channels: [], complete: true, missingScopes: ['channels:read', 'groups:read'] };
  await section.getByRole('button', { name: 'Refresh', exact: true }).click();
  await section.getByRole('heading', { name: 'Channel access not granted' }).waitFor();
  channels = { channels: [], complete: true, missingScopes: ['groups:read'] };
  await section.getByRole('button', { name: 'Refresh', exact: true }).click();
  await section.getByRole('heading', { name: 'Not in any channels yet' }).waitFor();
  await section.getByText('Private channels are hidden because Slack did not grant read access to them.').waitFor();

  channelsStatus = 404;
  await page.reload();
  await openSettings();
  await section.getByRole('heading', { name: 'Channels unavailable' }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(
    'PASS Slack bot channels: members see Your account without Settings or channel requests, admin Settings shows failed load/retry, public and private icons, partial scopes, truncation, refresh failure keeps list, empty, no scopes, unavailable, mobile width.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
