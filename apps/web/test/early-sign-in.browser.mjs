import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startBuiltApp } from './built-app.fixture.mjs';

// Runs against the production build (`VITE_API_URL= pnpm --filter @tulipfarm/web build`), whose
// index.html paints the login page before the app's scripts and styles arrive.
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();

async function open(browser, origin, path, { session = null, methods } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  if (methods)
    await context.addInitScript(
      value => localStorage.setItem('tulipfarm:auth-methods', value),
      JSON.stringify(methods),
    );
  let release;
  const scripts = new Promise(resolve => (release = resolve));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/get-session')) return route.fulfill({ json: session });
    if (url.pathname === '/v1/auth/options')
      return route.fulfill({ json: { turnstileSiteKey: null, google: true, magicLink: true } });
    if (url.origin !== origin) return route.abort();
    if (url.pathname.endsWith('.js')) await scripts;
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin + path, { waitUntil: 'commit' });
  return { page, context, release };
}

test('the login page paints before the app loads and hands over what was typed', { timeout: 120000 }, async () => {
  const app = await startBuiltApp();
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, context, release } = await open(browser, app.origin, '/login');
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.locator('#tf-sign-in').getByRole('heading', { name: 'Log in to TulipFarm' }).waitFor();
    assert.equal(await page.locator('#root').innerHTML(), '', 'The app has not rendered yet');
    await page.locator('#tf-sign-in').getByRole('textbox', { name: 'Email' }).fill('ada@example.test');
    await page.locator('#tf-sign-in').getByRole('textbox', { name: 'Email' }).focus();
    release();
    await page.locator('#tf-sign-in').waitFor({ state: 'detached' });
    const email = page.getByRole('textbox', { name: 'Email', exact: true });
    assert.equal(await email.inputValue(), 'ada@example.test');
    assert.equal(await email.evaluate(input => input === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('tulipfarm:auth-methods') ?? 'null')), {
      emailPassword: false,
      google: true,
      magicLink: true,
    });
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    await app.close();
  }
});

test(
  'the early login page shows the remembered methods and stays away when it would differ',
  { timeout: 120000 },
  async () => {
    const app = await startBuiltApp();
    const browser = await chromium.launch({ headless: true });
    try {
      const googleOnly = await open(browser, app.origin, '/login', {
        methods: { emailPassword: false, google: true, magicLink: false },
      });
      const shell = googleOnly.page.locator('#tf-sign-in');
      await shell.getByRole('button', { name: 'Continue with Google' }).waitFor();
      assert.equal(await shell.getByText('Continue with your Google account.').count(), 1);
      assert.equal(await shell.getByRole('textbox').count(), 0);
      await googleOnly.context.close();

      for (const [path, options] of [
        ['/login', { methods: { emailPassword: true, google: true, magicLink: false } }],
        ['/login?error=unable_to_link_account', {}],
        ['/register', {}],
      ]) {
        const { page, context, release } = await open(browser, app.origin, path, options);
        await page.waitForFunction(() => document.readyState !== 'loading');
        assert.equal(await page.locator('#tf-sign-in').count(), 0, `${path} paints no early login page`);
        release();
        await context.close();
      }

      const signedIn = await open(browser, app.origin, '/login?redirect=/settings', {
        session: {
          session: { id: 'session', userId: 'user', expiresAt },
          user: { id: 'user', name: 'Ada', email: 'ada@example.test' },
        },
      });
      await signedIn.page.locator('#tf-sign-in').waitFor();
      signedIn.release();
      await signedIn.page.locator('#tf-sign-in').waitFor({ state: 'detached' });
      await signedIn.context.close();
    } finally {
      await browser.close();
      await app.close();
    }
  },
);
