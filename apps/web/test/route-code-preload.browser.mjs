import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

// Session-gated routes download their code while the session check is still pending,
// and one page load makes exactly one session request.
test('gated route code loads during the session check with one session request', async t => {
  const { workspace, session } = createWorkspaceFixture();
  const server = await preview({
    root: fileURLToPath(new URL('..', import.meta.url)),
    preview: { host: '127.0.0.1', port: 0 },
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  });

  async function open(path, signedIn, chunks) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const held = Promise.withResolvers();
    const sessionStarted = Promise.withResolvers();
    let sessionRequests = 0;
    let sessionHeld = true;
    const requestedWhileHeld = new Set();
    page.on('request', request => {
      const file = new URL(request.url()).pathname.split('/').pop() ?? '';
      for (const chunk of chunks)
        if (sessionHeld && file.startsWith(`${chunk}-`) && file.endsWith('.js')) requestedWhileHeld.add(chunk);
    });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/v1/auth/get-session') {
        sessionRequests++;
        sessionStarted.resolve();
        await held.promise;
        return route.fulfill({ json: signedIn ? session : null });
      }
      if (path === '/v1/auth/options') return route.fulfill({ status: 503, json: { error: 'controlled-unavailable' } });
      if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
      if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
      if (path.endsWith('/governance/me'))
        return route.fulfill({
          json: {
            membershipId: workspace.id,
            role: 'member',
            teams: [],
            capabilities: { manageGovernance: false, canLeave: true },
          },
        });
      if (path.endsWith('/credits'))
        return route.fulfill({
          json: { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] },
        });
      return route.fulfill({ status: 404, json: { error: 'not-found' } });
    });
    await page.goto(`${origin}${path}`, { waitUntil: 'commit' });
    await sessionStarted.promise;
    for (let attempt = 0; requestedWhileHeld.size < chunks.length; attempt++) {
      assert.ok(attempt < 100, `Route code requested while the session is held: ${[...requestedWhileHeld].join(', ')}`);
      await delay(20);
    }
    sessionHeld = false;
    held.resolve();
    return { page, context, errors, sessionRequests: () => sessionRequests };
  }

  await t.test('signed-out login', async () => {
    const { page, context, errors, sessionRequests } = await open('/login', false, ['login']);
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('ada@example.test');
    await delay(500);
    assert.equal(sessionRequests(), 1, 'One login load makes one session request');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test('signed-in workspace page', async () => {
    const { page, context, errors, sessionRequests } = await open(`/${workspace.slug}/help`, true, [
      'workspace',
      'help',
    ]);
    await page.getByRole('heading', { name: 'Help and support', exact: true }).waitFor();
    await delay(500);
    assert.equal(sessionRequests(), 1, 'One workspace load makes one session request');
    assert.deepEqual(errors, []);
    await context.close();
  });

  await t.test('signed-in visitor on login is still redirected', async () => {
    const { page, context, errors } = await open(
      `/login?redirect=${encodeURIComponent(`/${workspace.slug}/help`)}`,
      true,
      ['login'],
    );
    await page.waitForURL(`${origin}/${workspace.slug}/help`);
    await page.getByRole('heading', { name: 'Help and support', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  });
});
