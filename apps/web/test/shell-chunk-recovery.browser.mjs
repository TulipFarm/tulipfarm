import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const { workspace, session } = createWorkspaceFixture();
const server = await preview({
  root: fileURLToPath(new URL('..', import.meta.url)),
  preview: { host: '127.0.0.1', port: 0 },
});
const address = server.httpServer.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const indexHtml = await fetch(origin).then(response => response.text());
let browser;
try {
  browser = await chromium.launch();
  for (const failure of ['stale-chunk-once', 'missing-chunk-persistent', 'chats-prefetch', 'workspace-api']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    let broken = true;
    let moduleRequests = 0;
    let documents = 0;
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
    });
    await page.route('**/assets/workspace-*.js', async route => {
      moduleRequests++;
      const chats = new URL(route.request().url()).pathname.startsWith('/assets/workspace-chats-');
      if (failure === 'stale-chunk-once' && documents === 1)
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: indexHtml });
      else if ((failure === 'missing-chunk-persistent' && broken) || (failure === 'chats-prefetch' && chats))
        await route.fulfill({
          status: 404,
          contentType: 'text/html; charset=utf-8',
          body: 'Not found',
          headers: { 'cache-control': 'no-store' },
        });
      else await route.continue();
    });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let json;
      if (path.endsWith('/get-session')) json = session;
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === `/v1/workspaces/${workspace.slug}`) {
        if (failure === 'workspace-api' && broken) {
          await route.fulfill({ status: 503, json: { error: 'unavailable' } });
          return;
        }
        json = workspace;
      } else if (path.endsWith('/governance/me'))
        json = {
          membershipId: workspace.id,
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        };
      else if (path.endsWith('/credits'))
        json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
      else {
        await route.fulfill({ status: 404, json: { error: 'not-found' } });
        return;
      }
      await route.fulfill({ json });
    });
    const help = page.getByRole('heading', { name: 'Help and support', exact: true });
    const failed = page.getByRole('heading', { name: 'Could not open TulipFarm' });
    await page.goto(`${origin}/${workspace.slug}/help`);

    if (failure === 'stale-chunk-once') {
      await help.waitFor({ timeout: 10000 });
      assert.equal(documents, 2, 'A stale chunk reloads the document once without user action');
      assert.ok(moduleRequests >= 2, 'The reload requests the shell module again');
      console.log(`PASS ${failure} recovered to Help with ${documents - 1} automatic reload`);
      await context.close();
      continue;
    }

    if (failure === 'chats-prefetch') {
      await help.waitFor();
      await page.getByRole('link', { name: 'Chats', exact: true }).hover();
      await page.waitForResponse(response => response.url().includes('/assets/workspace-chats-'));
      await page.waitForTimeout(1500);
      assert.equal(documents, 1, 'A failed background prefetch does not reload the page');
      assert.ok(await help.isVisible(), 'The open page stays usable');
      console.log(`PASS ${failure} kept Help open with 0 reloads`);
      await context.close();
      continue;
    }

    for (let settled = -1; settled !== documents;) {
      settled = documents;
      await page.waitForTimeout(1500);
    }
    await failed.waitFor();
    const documentsBeforeRetry = documents;
    const modulesBeforeRetry = moduleRequests;
    if (failure === 'missing-chunk-persistent') {
      assert.ok(
        documentsBeforeRetry <= 3,
        `Automatic reloads stop for a persistently missing chunk (${documentsBeforeRetry} documents)`,
      );
      // The network connection, not an integration: #1143's rename over-reached this copy (cloud ca83e935 apps/web/src/router.tsx:190 still says connection).
      await page
        .getByText(
          'Page code could not load. TulipFarm may have been updated, or the connection dropped. Try again will reload this page.',
        )
        .waitFor();
      assert.equal(
        await page.getByText(/account or workspace/).count(),
        0,
        'Asset failures do not blame account or workspace access',
      );
    }
    broken = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await help.waitFor({ timeout: 10000 });
    assert.equal(page.url(), `${origin}/${workspace.slug}/help`);
    if (failure === 'missing-chunk-persistent') {
      assert.ok(moduleRequests > modulesBeforeRetry, 'Recovery requests the shell module again');
      assert.equal(documents, documentsBeforeRetry + 1, 'Try again reloads the document once');
    } else assert.equal(documents, documentsBeforeRetry, 'API recovery does not reload the document');
    console.log(
      `PASS ${failure} recovery to Help with ${documents - documentsBeforeRetry} document reloads after Try again`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
