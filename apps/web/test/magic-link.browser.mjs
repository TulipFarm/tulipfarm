import assert from 'node:assert/strict';
import { test } from 'node:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { magicLink } from 'better-auth/plugins';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const destination = '/acme/tables?view=mine#rows';
const message = 'This sign-in link did not work. It may have expired or already been used. Request a new link.';
const email = 'person@example.test';

async function withAuth(run) {
  const database = { user: [], session: [], account: [], verification: [] };
  const sent = [];
  let auth;
  let landingSession;
  const server = await createServer({
    define: { 'import.meta.env.VITE_API_URL': 'window.location.origin' },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'magic-link-auth-fixture',
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            try {
              const url = new URL(request.url, 'http://localhost');
              const json = body => {
                response.setHeader('content-type', 'application/json');
                response.end(JSON.stringify(body));
              };
              if (url.pathname === '/v1/auth/options')
                return json({ turnstileSiteKey: null, magicLink: true, emailPassword: true });
              if (url.pathname === '/v1/dev/sign-in-link') return json({ link: sent.at(-1)?.url });
              if (url.pathname.startsWith('/v1/auth/')) return await toNodeHandler(auth)(request, response);
              if (url.pathname === '/acme/tables' && !url.searchParams.has('error')) {
                landingSession = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
                assert.ok(landingSession, 'The return destination requires a real session');
                response.setHeader('content-type', 'text/html');
                response.end('<h1>Requested destination</h1>');
                return;
              }
              next();
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    auth = betterAuth({
      database: memoryAdapter(database),
      secret: 'local-magic-link-browser-fixture-secret',
      baseURL: origin,
      basePath: '/v1/auth',
      trustedOrigins: [origin],
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: false },
      plugins: [
        magicLink({
          expiresIn: 900,
          storeToken: 'hashed',
          sendMagicLink: async link => {
            sent.push(link);
          },
        }),
      ],
    });
    await auth.api.signUpEmail({
      headers: new Headers({ origin }),
      body: { email, name: 'Ada', password: 'local-fixture-password' },
    });
    browser = await chromium.launch({ headless: true });
    await run({
      auth,
      browser,
      database,
      origin,
      sent,
      landingSession: () => landingSession,
      async createLink() {
        await auth.api.signInMagicLink({
          headers: new Headers({ origin }),
          body: { email, callbackURL: origin + destination, newUserCallbackURL: origin + destination },
        });
        return sent.at(-1).url;
      },
    });
  } finally {
    await browser?.close();
    await server.close();
  }
}

for (const failure of ['invalid', 'expired', 'already used']) {
  test(
    `${failure} sign-in link explains recovery and a new link returns without the error`,
    { timeout: 90000 },
    async () => {
      await withAuth(async ({ auth, browser, database, origin, sent, landingSession, createLink }) => {
        const link = new URL(await createLink());
        if (failure === 'invalid') link.searchParams.set('token', 'invalid-token');
        if (failure === 'expired') database.verification.at(-1).expiresAt = new Date(0);
        if (failure === 'already used') {
          const used = await auth.handler(new Request(link));
          assert.equal(used.status, 302);
          assert.ok(used.headers.has('set-cookie'));
        }
        const context = await browser.newContext({ reducedMotion: 'reduce' });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          page.on('console', entry => {
            if (entry.type() === 'error') errors.push(entry.text());
          });
          page.on('response', response => {
            if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
          });
          page.on('requestfailed', request => errors.push(request.failure().errorText));
          await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForURL(url => url.pathname === '/login');
          await page.getByRole('alert').getByText(message, { exact: true }).waitFor();
          const loginURL = new URL(page.url());
          assert.equal(loginURL.searchParams.get('error'), 'INVALID_TOKEN');
          assert.equal(loginURL.searchParams.get('redirect'), destination);
          await page.getByLabel('Email', { exact: true }).fill(email);
          await page.getByRole('button', { name: 'Email me a sign-in link instead', exact: true }).click();
          await page.getByText('Check your email', { exact: true }).waitFor();
          const freshLink = sent.at(-1).url;
          assert.notEqual(freshLink, link.href);
          const callbacks = new URL(freshLink).searchParams;
          assert.equal(callbacks.get('callbackURL'), origin + destination);
          assert.equal(callbacks.get('newUserCallbackURL'), origin + destination);
          assert.equal(new URL(callbacks.get('errorCallbackURL')).searchParams.get('redirect'), destination);
          await page.getByRole('link', { name: 'Open dev sign-in link', exact: true }).click();
          await page.getByRole('heading', { name: 'Requested destination', exact: true }).waitFor();
          assert.equal(page.url(), origin + destination);
          assert.equal(new URL(page.url()).searchParams.has('error'), false);
          assert.equal(landingSession().user.email, email);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    },
  );
}

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
      await context.route('**/v1/auth/options', route =>
        route.fulfill({ json: { turnstileSiteKey: null, google: true, magicLink: true } }),
      );
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
