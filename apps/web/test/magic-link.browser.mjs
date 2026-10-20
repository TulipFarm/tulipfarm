import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

test('email links continue automatically and invalid links offer recovery', { timeout: 90000 }, async () => {
  const server = await createServer({
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'magic-link-destination',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/acme/settings?tab=general') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<h1>Requested destination</h1>');
          });
        },
      },
    ],
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      const verifications = [];
      let capturePendingView;
      const pendingView = new Promise(resolve => {
        capturePendingView = resolve;
      });
      await page.exposeFunction('capturePendingView', capturePendingView);
      await page.addInitScript(() => {
        const observer = new MutationObserver(() => {
          const status = document.querySelector('[role="status"][aria-busy="true"]');
          if (status?.textContent !== 'Signing you in…') return;
          window.capturePendingView({
            text: status.textContent,
            buttons: [...document.querySelectorAll('button')].map(button => button.textContent),
            fitsViewport: document.documentElement.scrollWidth <= innerWidth,
          });
          observer.disconnect();
        });
        observer.observe(document, { subtree: true, childList: true });
      });
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/v1/auth/get-session', route => route.fulfill({ json: null }));
      await context.route('**/v1/auth/options', route => route.fulfill({ json: { turnstileSiteKey: null } }));
      const destination = '/acme/settings?tab=general#members';
      const callbackURL = origin + destination;
      let releaseVerification;
      let verificationGate = new Promise(resolve => {
        releaseVerification = resolve;
      });
      await context.route('**/v1/auth/magic-link/verify?*', async route => {
        const url = new URL(route.request().url());
        verifications.push(url);
        await verificationGate;
        const token = url.searchParams.get('token');
        const location =
          token === 'expired'
            ? `${url.searchParams.get('errorCallbackURL')}&error=INVALID_TOKEN`
            : url.searchParams.get(token === 'new-user' ? 'newUserCallbackURL' : 'callbackURL');
        await route.fulfill({ status: 302, headers: { location } });
      });
      await Promise.all([
        page.waitForRequest('**/v1/auth/magic-link/verify?*'),
        page.goto(`${origin}/verify-email?token=returning-user&callbackURL=${encodeURIComponent(callbackURL)}`),
      ]);
      assert.deepEqual(await pendingView, { text: 'Signing you in…', buttons: [], fitsViewport: true });
      assert.equal(verifications.length, 1);
      const verification = verifications[0];
      assert.equal(verification.searchParams.get('token'), 'returning-user');
      assert.equal(verification.searchParams.get('callbackURL'), callbackURL);
      assert.equal(verification.searchParams.get('newUserCallbackURL'), callbackURL);
      const errorURL = new URL(verification.searchParams.get('errorCallbackURL'));
      assert.equal(errorURL.origin + errorURL.pathname, `${origin}/verify-email`);
      assert.equal(errorURL.searchParams.get('callbackURL'), callbackURL);
      assert.equal(errorURL.searchParams.has('token'), false);
      releaseVerification();
      await page.waitForURL(callbackURL);
      await page.getByRole('heading', { name: 'Requested destination' }).waitFor();
      await page.goBack();
      assert.equal(new URL(page.url()).pathname === '/verify-email', false, 'Back must not replay the one-use token');
      verificationGate = Promise.resolve();
      await page.goto(`${origin}/verify-email?token=new-user&callbackURL=${encodeURIComponent(callbackURL)}`);
      await page.waitForURL(callbackURL);
      assert.equal(verifications.length, 2);

      await page.goto(`${origin}/verify-email?token=expired&callbackURL=${encodeURIComponent(callbackURL)}`);
      await page.getByRole('heading', { name: 'This link is no longer valid' }).waitFor();
      assert.equal(verifications.length, 3);
      await page.getByRole('link', { name: 'Request a new link' }).click();
      await page.getByLabel('Email', { exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('redirect'), destination);

      for (const search of ['', '?token=', '?token=used&error=INVALID_TOKEN']) {
        await page.goto(`${origin}/verify-email${search}`);
        await page.getByRole('heading', { name: 'This link is no longer valid' }).waitFor();
        assert.equal(
          await page.getByRole('link', { name: 'Request a new link' }).getAttribute('href'),
          '/login?redirect=%2F',
        );
        assert.equal(await page.getByRole('status').count(), 0);
        assert.equal(verifications.length, 3);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
