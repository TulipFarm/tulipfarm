import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const origin = 'http://127.0.0.1:5197';
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5197', '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      if (attempt === 100) throw new Error('Vite unavailable');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__headings = [];
    new MutationObserver(() => {
      for (const heading of document.querySelectorAll('h1'))
        if (window.__headings.at(-1) !== heading.textContent) window.__headings.push(heading.textContent);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  let status = 503,
    state = 'unlinked',
    execution = 'disabled',
    delay = 0,
    writes = 0,
    signedIn = true,
    sessionDelay = 0;
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/auth/get-session') {
      await setTimeout(sessionDelay);
      return route.fulfill({
        json: signedIn
          ? { session: { id: 'session', userId: 'user' }, user: { id: 'user', name: 'Ada', email: 'ada@example.test' } }
          : null,
      });
    }
    if (path === '/v1/user/visit') return route.fulfill({ json: {} });
    if (route.request().method() === 'POST') {
      writes++;
      await setTimeout(300);
      return route.fulfill({ json: { url: 'https://slack.com/openid/connect/authorize?state=synthetic' } });
    }
    await setTimeout(delay);
    return route.fulfill({ status, json: status === 200 ? { state, execution } : { error: 'unavailable' } });
  });
  await page.route('https://slack.com/**', route =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Local Slack sign-in fixture</h1>' }),
  );
  const path =
    '/slack/link?workspaceId=11111111-1111-4111-8111-111111111111&eventId=22222222-2222-4222-8222-222222222222';
  sessionDelay = 800;
  await page.goto(origin + path);
  await page.getByRole('heading', { name: 'Could not check your Slack link' }).waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.__headings.filter(heading => heading.includes('Could not open TulipFarm'))),
    [],
  );
  sessionDelay = 0;
  delay = 700;
  status = 200;
  await page.getByRole('button', { name: 'Check status again' }).click();
  await page.getByRole('heading', { name: 'Checking your Slack link' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Sign in with Slack' }).count(), 0);
  await page.getByRole('heading', { name: 'Connect your Slack identity' }).waitFor();
  await page.getByRole('button', { name: 'Sign in with Slack' }).click();
  await page.getByRole('heading', { name: 'Opening Slack sign-in' }).waitFor();
  await page.getByRole('heading', { name: 'Local Slack sign-in fixture' }).waitFor();
  assert.equal(writes, 1);
  state = 'dispatch-held';
  delay = 0;
  await page.goto(origin + path);
  await page.getByRole('heading', { name: 'Slack connected', exact: true }).waitFor();
  assert.match(await page.locator('main').innerText(), /resume with current permissions/);
  assert.equal(await page.getByRole('button', { name: 'Sign in with Slack' }).count(), 0);
  for (const [width, height, theme] of [
    [1440, 900, 'light'],
    [390, 844, 'dark'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(theme => {
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme);
    }, theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({
      path: `${process.env.SCREENSHOT_DIR ?? '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode'}/slack-link-${theme}.png`,
      fullPage: true,
    });
  }
  for (const [next, copy] of [
    ['pending', 'queued or running'],
    ['retry', 'without repeating'],
    ['unknown', 'will not resend'],
    ['blocked', 'prevent this answer'],
    ['sent', 'delivered in Slack'],
  ]) {
    execution = next;
    await page.getByRole('button', { name: 'Check status again' }).click();
    await page.getByText(new RegExp(copy)).waitFor();
    assert.equal(writes, 1);
  }
  state = 'reconnect-required';
  await page.reload();
  await page.getByRole('heading', { name: 'Reconnect your Slack account' }).waitFor();
  assert.match(await page.locator('main').innerText(), /Previous approvals will not be reused/);
  await page.getByRole('button', { name: 'Reconnect Slack', exact: true }).click();
  await page.getByRole('heading', { name: 'Local Slack sign-in fixture' }).waitFor();
  assert.equal(writes, 2);
  state = 'cancelled';
  await page.goto(origin + path);
  await page.getByRole('heading', { name: 'This Slack link is unavailable' }).waitFor();
  status = 404;
  await page.reload();
  await page.getByRole('heading', { name: 'This Slack link is unavailable' }).waitFor();
  signedIn = false;
  await page.reload();
  await page.waitForURL('**/login?redirect=*');
  assert.equal(new URL(page.url()).searchParams.get('redirect'), path);
  assert.deepEqual(errors, []);
  console.log('Slack linker browser states, recovery, single submission, themes and auth continuation passed.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
