import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ownMembership } from './workspace-query.fixture.mjs';
import { installTurnstileFixture } from './turnstile-fixture.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const origin = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await installTurnstileFixture(page.context());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const workspace = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Browser workspace',
    slug: 'browser-workspace',
    createdAt: '2026-09-27T00:00:00.000Z',
    status: 'provisioning',
  };
  const session = {
    session: { id: 'session', expiresAt: '2099-01-01T00:00:00.000Z' },
    user: { id: '22222222-2222-4222-8222-222222222222', name: 'Browser user', email: 'browser@example.com' },
  };
  let stage = 'reserved';
  let status = 200;
  let posts = 0;
  let checks = 0;
  let setupError = null;
  let signedIn = true;
  const signIns = [];
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/auth/get-session') return route.fulfill({ json: signedIn ? session : null });
    if (path === '/v1/auth/sign-in/magic-link') {
      signIns.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: true } });
    }
    if (path === '/v1/dev/sign-in-link') return route.fulfill({ status: 404, json: { error: 'Not found' } });
    if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
    if (path === '/v1/auth/options')
      return route.fulfill({ json: { turnstileSiteKey: 'fixture-site-key', google: true, magicLink: true } });
    if (path.endsWith('/governance/me')) return route.fulfill({ json: ownMembership });
    if (path.startsWith('/v1/workspace-setups/')) {
      checks++;
      return route.fulfill({
        status,
        json: status === 200 ? { id: workspace.id, stage, error: setupError } : { error: 'Injected failure' },
      });
    }
    if (path === '/v1/workspaces' && route.request().method() === 'POST') {
      posts++;
      return route.fulfill({ status: 202, json: workspace });
    }
    const ready = { ...workspace, status: 'ready', soulCommit: 'a'.repeat(40) };
    if (path === '/v1/workspaces') return route.fulfill({ json: [ready] });
    if (path === '/v1/workspaces/browser-workspace') return route.fulfill({ json: ready });
    if (path.endsWith('/credits'))
      return route.fulfill({
        json: { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] },
      });
    if (path.endsWith('/model-catalog')) return route.fulfill({ json: { families: [] } });
    throw new Error(`Unexpected API request ${path}`);
  });
  await page.goto(`${origin}create-workspace`);
  await page.getByLabel('Workspace name', { exact: true }).fill(workspace.name);
  await page.getByText('Choose carefully. This address cannot be changed after creation.').waitFor();
  await page.getByText('Test verification widget').waitFor();
  await page.evaluate(() => window.challenge.solve());
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await page.waitForURL(`**/workspace-setups/${workspace.id}`);
  await page.getByRole('heading', { name: 'Setting up your workspace' }).waitFor();
  assert.equal(posts, 1);
  stage = 'database';
  await page.getByRole('heading', { name: 'Finishing workspace setup' }).waitFor();
  status = 503;
  await page.getByRole('heading', { name: 'Could not check workspace setup' }).waitFor();
  const stopped = checks;
  await page.waitForTimeout(2300);
  assert.equal(checks, stopped);
  status = 200;
  stage = 'ready';
  await page.getByRole('button', { name: 'Check status again' }).click();
  await page.waitForURL('**/browser-workspace');
  assert.equal(posts, 1);

  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 375, height: 812 });
    status = 404;
    await page.goto(`${origin}workspace-setups/${workspace.id}`);
    await page.getByRole('heading', { name: 'Workspace setup is unavailable' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  status = 200;
  setupError = 'setup_failed';
  stage = 'database';
  await page.goto(`${origin}workspace-setups/${workspace.id}`);
  await page.getByRole('heading', { name: 'Workspace setup needs attention' }).waitFor();
  setupError = null;
  stage = 'unavailable';
  await page.getByRole('button', { name: 'Check status again' }).click();
  await page.getByRole('heading', { name: 'Workspace setup is unavailable' }).waitFor();
  const setupPath = `/workspace-setups/${workspace.id}`;
  const callbackURL = new URL(setupPath, origin).href;
  stage = 'database';
  await page.goto(callbackURL);
  await page.getByRole('heading', { name: 'Finishing workspace setup' }).waitFor();
  status = 401;
  signedIn = false;
  await page.waitForURL(url => url.pathname === '/login');
  assert.equal(new URL(page.url()).searchParams.get('redirect'), setupPath);
  await page.getByLabel('Email', { exact: true }).fill(session.user.email);
  await page.getByText('Test verification widget').waitFor();
  await page.evaluate(() => window.challenge.solve());
  await page.getByRole('button', { name: 'Email me a sign-in link', exact: true }).click();
  await page.getByText('Check your email', { exact: true }).waitFor();
  assert.equal(signIns.length, 1);
  assert.equal(signIns[0].callbackURL, callbackURL);
  assert.equal(signIns[0].newUserCallbackURL, callbackURL);
  assert.equal(new URL(signIns[0].errorCallbackURL).searchParams.get('redirect'), setupPath);
  status = 200;
  signedIn = true;
  await page.goto(callbackURL);
  await page.getByRole('heading', { name: 'Finishing workspace setup' }).waitFor();
  assert.equal(new URL(page.url()).pathname, setupPath);
  stage = 'reserved';
  await page.clock.install();
  await page.goto(`${origin}workspace-setups/${workspace.id}`);
  await page.getByRole('heading', { name: 'Setting up your workspace' }).waitFor();
  for (let check = 0; check < 31; check++) {
    await page.clock.runFor(2100);
    await page.waitForTimeout(20);
  }
  await page.getByRole('heading', { name: 'Setup is taking longer than expected' }).waitFor();
  assert.equal(posts, 1);
  assert.deepEqual(errors, []);
  console.log(
    'Chrome setup journey passed: create redirect, progress, failed refresh, bounded polling, read-only retry, focus, ready/open, access loss, sign-in after session expiry, narrow themes.',
  );
} finally {
  await browser.close();
  await server.close();
}
