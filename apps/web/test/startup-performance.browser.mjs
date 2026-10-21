import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { installTurnstileFixture } from './turnstile-fixture.mjs';

const screenshots = process.env.STARTUP_SCREENSHOTS;
const cdpPort = process.env.STARTUP_CDP_PORT;
if (screenshots) {
  assert.ok(cdpPort, 'STARTUP_SCREENSHOTS requires an isolated STARTUP_CDP_PORT for agent-browser');
  await mkdir(screenshots, { recursive: true });
}
const screenshot = name => {
  if (screenshots)
    execFileSync(
      'agent-browser',
      ['--session', 'signin-startup', '--cdp', cdpPort, 'screenshot', join(screenshots, `${name}.png`)],
      { stdio: 'pipe' },
    );
};
const server = await preview({
  root: process.env.PERF_APP_ROOT ?? fileURLToPath(new URL('..', import.meta.url)),
  preview: { host: '127.0.0.1', port: 0 },
});
const address = server.httpServer.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
let browser;
try {
  browser = await chromium.launch({ args: cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [] });
  const results = [];
  const cases = [
    ...Array.from({ length: 3 }, (_, run) => ({ path: '/login', verification: false, run })),
    ...Array.from({ length: 3 }, (_, run) => ({ path: '/login', verification: true, run })),
    ...['/forgot-password', '/reset-password', '/auth'].map(path => ({ path, verification: false, run: 0 })),
  ];
  for (const { path: entryPath, verification, run } of cases) {
    const context = await browser.newContext({
      viewport: { width: 375, height: 844 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const errors = [];
    const unexpectedRequests = [];
    const scriptRequests = [];
    const sends = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname.endsWith('.js')) scriptRequests.push(url.pathname);
    });
    page.on('pageerror', error => errors.push(String(error)));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith('/get-session')) return route.fulfill({ json: null });
      if (path === '/v1/auth/options')
        return route.fulfill({
          status: verification ? 200 : 503,
          json: verification
            ? { turnstileSiteKey: 'fixture-site-key', google: true, magicLink: true }
            : { error: 'controlled-unavailable' },
        });
      if (verification && path === '/v1/auth/sign-in/magic-link') {
        sends.push(route.request().postDataJSON());
        return route.fulfill({ json: { status: true } });
      }
      if (url.origin === origin && !path.startsWith('/v1/')) return route.continue();
      if (url.origin === 'https://avatars.tulipfarm.ai' && route.request().resourceType() === 'image')
        return route.abort();
      unexpectedRequests.push(url.origin + path);
      return route.abort();
    });
    if (verification) await installTurnstileFixture(context);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: 200000,
      uploadThroughput: 100000,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const started = performance.now();
    const destination = '/acme/settings?tab=general#members';
    await page.goto(`${origin}${entryPath}?redirect=${encodeURIComponent(destination)}`);
    const email = page.getByRole('textbox', { name: 'Email', exact: true });
    await email.fill('performance@example.test');
    assert.equal(await email.inputValue(), 'performance@example.test');
    const emailFieldReadyMs = Math.round(performance.now() - started);
    await page.waitForLoadState('networkidle');
    assert.equal(new URL(page.url()).pathname, '/login');
    assert.equal(new URL(page.url()).searchParams.get('redirect'), destination);
    const scripts = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter(r => new URL(r.name).origin === location.origin && new URL(r.name).pathname.endsWith('.js'))
        .map(r => ({
          file: new URL(r.name).pathname,
          decodedBytes: r.decodedBodySize,
          encodedBytes: r.encodedBodySize,
          transferBytes: r.transferSize,
        })),
    );
    assert.ok(scripts.length > 0, 'The resource observer must measure application JavaScript');
    assert.ok(
      scripts.every(script => script.decodedBytes > 0),
      'Every script must have a non-empty decoded size',
    );
    assert.deepEqual(
      [...new Set(scripts.map(script => script.file))].sort(),
      [...new Set(scriptRequests)].sort(),
      'Every requested script must be measured',
    );
    const decodedJavaScriptBytes = scripts.reduce((sum, script) => sum + script.decodedBytes, 0);
    const result = {
      entryPath,
      verification,
      run,
      emailFieldReadyMs,
      decodedJavaScriptBytes,
      encodedJavaScriptBytes: scripts.reduce((sum, script) => sum + script.encodedBytes, 0),
      transferBytes: scripts.reduce((sum, script) => sum + script.transferBytes, 0),
      scripts,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    const submit = page.getByRole('button', { name: 'Email me a sign-in link' });
    assert.equal(await submit.isDisabled(), true);
    if (verification) {
      await page.getByText('Test verification widget', { exact: true }).waitFor();
      await page.evaluate(() => window.challenge.solve());
      await page.getByText('Verification complete.', { exact: true }).waitFor();
      if (run === 0) screenshot('login-verification-ready');
      await submit.click();
      await page.getByText('Check your email', { exact: true }).waitFor();
      if (run === 0) screenshot('login-email-sent');
      assert.equal(sends.length, 1);
      assert.equal(sends[0].email, 'performance@example.test');
      assert.equal(sends[0].callbackURL, origin + destination);
    } else {
      await page.getByRole('button', { name: 'Retry verification' }).waitFor();
      assert.deepEqual(sends, []);
      if (entryPath === '/login' && run === 0) screenshot('login-error-after');
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
    if (process.env.PERF_BASELINE !== '1') {
      assert.deepEqual(
        scriptRequests.filter(file =>
          /\/(?:editor-extensions|attachment|file-mentions|catalog|draft-files|auth)-[^/]+\.js$/.test(file),
        ),
        [],
        'Sign-in must not load rich editor, attachment, integration catalog, logout storage, or other auth screens',
      );
      assert.ok(decodedJavaScriptBytes < 675_000, 'Cold login stays under 675 KB decoded JavaScript');
    }
    await context.close();
  }
  console.log(
    JSON.stringify(
      {
        method:
          'Production build, cold cache, 375px viewport, 4x CPU, 150ms network latency, 200000 bytes/s. Signed-out HTTP fixtures: failed auth options and successful local verification/mock send. Email-field readiness is not completed sign-in or production latency.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server.httpServer.closeAllConnections();
  await new Promise(resolve => server.httpServer.close(resolve));
}
