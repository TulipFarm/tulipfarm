import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { githubFixture } from '../../../packages/github/test/fixture.mjs';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';

const port = Number(process.env.GITHUB_BROWSER_PORT ?? 5218);
const origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await githubFixture();
const app = Fastify();
const auth = {
  api: { getSession: async () => ({ user: { id: f.member.userId }, session: { id: 'browser-session' } }) },
};
await app.register(async routes => registerGitHubAccounts(routes, auth, f.service), { prefix: '/v1' });
await app.ready();
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
let browser;
let failList = false,
  failDisconnect = false,
  listDelay = 0,
  consentDelay = 0,
  callbackStatus = 200,
  installationParams = false,
  inactiveCallback = false;
let beginCalls = 0,
  disconnectCalls = 0,
  callbackCalls = 0;
let accessLost = false,
  configured = true;
const errors = [];
const workspace = {
  id: f.one.id,
  slug: 'github-proof',
  name: 'GitHub proof',
  createdAt: '2026-10-01T00:00:00.000Z',
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      if (attempt === 100) throw new Error('GitHub browser server did not start');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('https://github.com/login/oauth/authorize?**', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    await route.fulfill({
      status: 302,
      headers: {
        location: `${origin}/github/callback?${new URLSearchParams({ code: 'browser-provider-code', iss: 'https://github.com/login/oauth', state: url.searchParams.get('state'), ...(installationParams ? { installation_id: '42', setup_action: 'install' } : {}) })}`,
      },
    });
  });
  await page.route('**/v1/**', async route => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (path.includes('/github/')) {
      if (path.endsWith('/accounts') && req.method() === 'GET') {
        await setTimeout(listDelay);
        if (accessLost) return route.fulfill({ status: 404, json: { error: 'account-not-found' } });
        if (!configured) return route.fulfill({ json: { configured: false, accounts: [] } });
        if (failList) return route.fulfill({ status: 503, json: { error: 'account-unavailable' } });
      }
      if (path.endsWith('/begin')) {
        beginCalls++;
        await setTimeout(consentDelay);
      }
      if (path.endsWith('/disconnect')) {
        disconnectCalls++;
        if (failDisconnect) return route.abort('failed');
      }
      if (path.endsWith('/oauth/callback')) {
        callbackCalls++;
        if (callbackStatus !== 200)
          return route.fulfill({ status: callbackStatus, json: { error: 'account-authorization-denied' } });
      }
      const response = await app.inject({
        method: req.method(),
        url: path + url.search,
        headers: { origin, ...(req.postData() ? { 'content-type': 'application/json' } : {}) },
        ...(req.postData() ? { payload: req.postData() } : {}),
      });
      let body = response.body;
      if (inactiveCallback && path.endsWith('/oauth/callback') && response.statusCode === 200) {
        const result = JSON.parse(body);
        body = JSON.stringify({ ...result, account: { ...result.account, state: 'reconnect-required' } });
      }
      return route.fulfill({ status: response.statusCode, contentType: 'application/json', body });
    }
    let json,
      status = 200;
    if (path === '/v1/auth/get-session')
      json = {
        session: { id: 'browser-session', userId: f.member.userId },
        user: { id: f.member.userId, name: 'Ada', email: 'ada@example.test' },
      };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: '22222222-2222-4222-8222-222222222222',
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith('/integrations')) json = { integrations: [] };
    else if (path.endsWith('/integrations/creation-context')) json = { teams: [] };
    else if (path.endsWith('/atlassian/accounts')) json = { accounts: [], providers: [] };
    else {
      status = 404;
      json = { error: 'not-found' };
    }
    await route.fulfill({ status, json });
  });
  const accountsPath = `/${workspace.slug}/integrations/github?tab=accounts`;
  const open = () => page.goto(origin + accountsPath);
  const logins = page.getByRole('region', { name: 'GitHub logins' });
  listDelay = 800;
  await open();
  await page.getByText('Loading GitHub accounts…').waitFor({ state: 'attached' });
  assert.equal(await page.getByText('No personal GitHub accounts', { exact: true }).count(), 0);
  await page.getByText('No personal GitHub accounts', { exact: true }).waitFor();
  listDelay = 0;
  configured = false;
  await page.reload();
  await page.getByRole('heading', { name: 'GitHub is not configured' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect GitHub account', exact: true }).count(), 0);
  configured = true;
  failList = true;
  await page.reload();
  await page.getByRole('heading', { name: 'Could not load GitHub accounts' }).waitFor();
  await logins.getByRole('button', { name: 'Check again', exact: true }).click();
  await setTimeout(4000);
  await page.getByRole('heading', { name: 'Could not load GitHub accounts' }).waitFor();
  failList = false;
  await logins.getByRole('button', { name: 'Check again', exact: true }).click();
  await page.getByText('No personal GitHub accounts', { exact: true }).waitFor();
  consentDelay = 600;
  await page.getByRole('button', { name: 'Connect GitHub account', exact: true }).dblclick();
  await page.getByRole('heading', { name: 'Connected @octocat' }).waitFor();
  assert.equal(beginCalls, 1);
  assert.equal(callbackCalls, 1);
  assert.equal(new URL(page.url()).search, '');
  await page.getByRole('link', { name: 'Return to GitHub accounts' }).click();
  await page.getByText('@octocat', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, accountsPath);
  f.setProfile({ id: 456, login: 'second-person' });
  await page.getByRole('button', { name: 'Connect another login', exact: true }).click();
  await page.getByRole('heading', { name: 'Connected @second-person' }).waitFor();
  await page.getByRole('link', { name: 'Return to GitHub accounts' }).click();
  await page.getByText('@octocat', { exact: true }).waitFor();
  await page.getByText('@second-person', { exact: true }).waitFor();
  assert.equal((await f.service.list(f.one.id, f.member.userId)).accounts.length, 2);
  failList = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await setTimeout(300);
  assert.equal(await page.getByText(/Account status may be stale/).count(), 0);
  await logins.getByRole('button', { name: 'Check again', exact: true }).click();
  await page.getByText(/Account status may be stale/).waitFor();
  assert.equal(
    await page.getByRole('list', { name: 'GitHub accounts' }).getByText('@octocat', { exact: true }).isVisible(),
    true,
  );
  failList = false;
  await logins.getByRole('button', { name: 'Check again', exact: true }).click();
  await page.getByText(/Account status may be stale/).waitFor({ state: 'hidden' });
  failDisconnect = true;
  await page.getByRole('button', { name: 'Disconnect @octocat', exact: true }).click();
  await page.getByText(/The result could not be confirmed/).waitFor();
  failDisconnect = false;
  await logins.getByRole('button', { name: 'Check again', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect @octocat', exact: true }).click();
  await page.getByText(/Disconnected from TulipFarm/).waitFor();
  assert.equal(disconnectCalls, 2);
  const first = (await f.service.list(f.one.id, f.member.userId)).accounts.find(
    account => account.identity.id === '123',
  );
  assert.equal(first.state, 'disconnected');
  const second = (await f.service.list(f.one.id, f.member.userId)).accounts.find(
    account => account.identity.id === '456',
  );
  f.setProfile({ id: 999, login: 'wrong-person' });
  await page.getByRole('button', { name: 'Reconnect @second-person', exact: true }).click();
  await page.getByRole('heading', { name: 'GitHub consent could not be confirmed' }).waitFor();
  assert.equal((await f.service.status(f.one.id, f.member.userId, second.id)).identity.id, '456');
  await page.getByRole('link', { name: 'Return to GitHub accounts' }).click();
  await page.getByText('@second-person', { exact: true }).waitFor();
  f.setProfile({ id: 456, login: 'renamed-octocat' });
  await page.getByRole('button', { name: 'Reconnect @second-person', exact: true }).click();
  await page.getByRole('heading', { name: 'Connected @renamed-octocat' }).waitFor();
  await page.getByRole('link', { name: 'Return to GitHub accounts' }).click();
  await page.getByText('@renamed-octocat', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/github-accounts-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Reconnect @renamed-octocat', exact: true }).focus();
  assert.equal(
    await page
      .getByRole('button', { name: 'Reconnect @renamed-octocat', exact: true })
      .evaluate(element => element === document.activeElement),
    true,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: '/tmp/github-accounts-mobile-dark.png', fullPage: true });
  accessLost = true;
  await logins.getByRole('button', { name: 'Check again', exact: true }).click();
  await page.getByRole('heading', { name: 'GitHub account access unavailable' }).waitFor();
  assert.equal(await page.getByText('@renamed-octocat', { exact: true }).count(), 0);
  accessLost = false;
  callbackStatus = 400;
  await page.goto(`${origin}/github/callback?code=denied&state=${f.one.id}.${'x'.repeat(43)}`);
  await page.getByText(/GitHub consent was denied/).waitFor();
  assert.equal(new URL(page.url()).search, '');
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Return to GitHub accounts' }).waitFor();
  callbackStatus = 200;
  await open();
  installationParams = true;
  await page.getByRole('button', { name: 'Reconnect @renamed-octocat', exact: true }).click();
  await page.getByRole('heading', { name: 'Connected @renamed-octocat' }).waitFor();
  assert.equal(new URL(page.url()).search, '');
  installationParams = false;
  await page.goto(`${origin}/integrations/github?installation_id=42&setup_action=install`);
  await page.getByRole('heading', { name: 'Connected @renamed-octocat' }).waitFor();
  assert.equal(new URL(page.url()).search, '');
  await page.getByRole('link', { name: 'Return to GitHub accounts' }).click();
  await page.getByText('@renamed-octocat', { exact: true }).waitFor();
  inactiveCallback = true;
  await page.getByRole('button', { name: 'Reconnect @renamed-octocat', exact: true }).click();
  await page.getByRole('heading', { name: 'GitHub sign-in finished, but the login is not connected' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: /^Connected/ }).count(), 0);
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).waitFor();
  inactiveCallback = false;
  assert.deepEqual(errors, []);
  console.log(
    'PASS GitHub browser with real API and PostgreSQL. Slow/empty/error/retry, single connect, two accounts, stale read retention, disconnect uncertainty, identity mismatch and recovery, callback cleanup, App installation returns, inactive results, mobile/dark/keyboard. Provider and shell identity are synthetic.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await app.close();
  await f.close();
}
