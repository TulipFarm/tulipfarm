import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = Number(process.env.SESSION_BROWSER_PORT ?? 5297);
const origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-10-01T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    if (
      await fetch(origin).then(
        response => response.ok,
        () => false,
      )
    )
      break;
    assert.ok(attempt < 100, 'Vite starts');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      colorScheme: mobile ? 'dark' : 'light',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Math.random = () => 0.3;
    });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    let user = 'Ada';
    let sessionId = 'session-ada';
    let authStatus = 200;
    let requests = 0;
    let heldRequest;
    let hold = true;
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let status = 200;
      let json;
      if (path === '/v1/auth/get-session') {
        requests++;
        if (hold && requests > 1) {
          heldRequest = route;
          return;
        }
        status = authStatus;
        json = user
          ? { session: { id: sessionId, userId: user }, user: { id: user, name: user, email: `${user}@example.test` } }
          : null;
      } else if (path === '/v1/workspaces') json = [workspace];
      else if (path === '/v1/workspaces/acme') json = workspace;
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: workspace.id,
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        };
      else if (path.endsWith('/model-catalog')) json = chatCatalog;
      else if (path === '/v1/user/visit') json = { firstSession: false };
      else if (path.endsWith('/credits'))
        json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
      else status = 503;
      await route.fulfill({ status, json: status === 200 ? json : { error: 'unavailable' } });
    });
    const refreshSession = async () => {
      const before = requests;
      await page.evaluate(() => {
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: 'better-auth.message',
            newValue: JSON.stringify({ event: 'session', data: { trigger: 'signout' } }),
          }),
        );
      });
      for (let attempt = 0; requests === before; attempt++) {
        assert.ok(attempt < 100, 'Session refresh starts');
        await delay(20);
      }
    };
    await page.goto(`${origin}/acme`);
    const input = page.getByLabel('Message', { exact: true });
    try {
      await input.fill('Keep my draft');
    } catch (error) {
      console.error('Session-loading admission failure', {
        errors,
        body: await page.locator('body').innerText(),
        requests,
        heldRequest: !!heldRequest,
      });
      throw error;
    }
    assert.equal(requests, 1, 'Admission and the mounted session hook share one session request');
    await refreshSession();
    assert.ok(heldRequest, 'Background session check is still pending');
    assert.equal(await page.getByText('Checking your session…', { exact: true }).count(), 0);
    await page
      .getByRole('region', { name: 'Conversation', exact: true })
      .getByRole('heading', { level: 2 })
      .filter({ hasText: 'Ada' })
      .waitFor();
    const admittedInput = await input.elementHandle();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.SESSION_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.SESSION_SCREENSHOT_DIR}/session-pending-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
      });
    hold = false;
    await heldRequest.fulfill({
      json: { session: { id: sessionId, userId: user }, user: { id: user, name: user, email: `${user}@example.test` } },
    });
    await delay(300);
    assert.equal(await input.textContent(), 'Keep my draft', 'Matching background session does not remount chat');
    assert.equal(
      await admittedInput.evaluate(
        element => element === document.querySelector('[role="textbox"][aria-label="Message"]'),
      ),
      true,
      'Matching session keeps the admitted composer mounted',
    );
    authStatus = 503;
    heldRequest = undefined;
    hold = true;
    await refreshSession();
    assert.ok(heldRequest, 'Later background session check is held');
    assert.equal(await input.textContent(), 'Keep my draft', 'Pending refresh preserves the verified chat');
    hold = false;
    await heldRequest.fulfill({ status: authStatus, json: { error: 'unavailable' } });
    await delay(300);
    assert.equal(await input.textContent(), 'Keep my draft', 'Temporary session failure preserves the verified chat');
    assert.equal(
      await admittedInput.evaluate(
        element => element === document.querySelector('[role="textbox"][aria-label="Message"]'),
      ),
      true,
      'Transient failure keeps the admitted composer mounted',
    );
    authStatus = 200;
    await refreshSession();
    await delay(300);
    assert.equal(await input.textContent(), 'Keep my draft', 'Same-session recovery preserves the draft');
    authStatus = 200;
    sessionId = 'session-ada-renewed';
    await refreshSession();
    await page.waitForFunction(
      () => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent === '',
    );
    await input.fill('Ada private draft');
    user = 'Grace';
    sessionId = 'session-grace';
    await refreshSession();
    await page
      .getByRole('region', { name: 'Conversation' })
      .getByRole('heading', { level: 2 })
      .filter({ hasText: 'Grace' })
      .waitFor();
    assert.equal(await input.textContent(), '', 'Account changes clear private drafts');
    authStatus = 401;
    await refreshSession();
    await page.getByRole('heading', { name: 'Sign in to continue' }).waitFor();
    assert.equal(await input.count(), 0, 'Unauthorized responses conceal personal chats');
    authStatus = 200;
    user = null;
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/login/);
    await page.getByRole('textbox', { name: 'Email', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    'PASS session loading, draft preservation, session rotation, account switching, expiry and sign-in recovery on desktop and mobile',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
