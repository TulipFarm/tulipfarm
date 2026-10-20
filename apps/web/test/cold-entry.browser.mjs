import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { shellRead } from './shell-reads.mjs';
import { setTimeout as delay } from 'node:timers/promises';

test('cold admission overlaps discovery and membership without admitting partial results', async t => {
  const { workspace, session } = createWorkspaceFixture();
  const server = await preview({
    root: fileURLToPath(new URL('..', import.meta.url)),
    preview: { host: '127.0.0.1', port: 0 },
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  try {
    for (const status of [200, 403, 404, 503])
      await t.test(`membership ${status} while discovery is held`, async () => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const list = Promise.withResolvers();
        const membership = Promise.withResolvers();
        let memberStatus = status;
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/v1/**', async route => {
          const path = new URL(route.request().url()).pathname;
          if (path === '/v1/auth/get-session') return route.fulfill({ json: session });
          if (path === '/v1/workspaces') {
            await list.promise;
            return route.fulfill({ json: [workspace] });
          }
          if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
          if (path.endsWith('/governance/me')) {
            membership.resolve();
            return route.fulfill({
              status: memberStatus,
              json:
                memberStatus === 200
                  ? {
                      membershipId: workspace.id,
                      role: 'member',
                      teams: [],
                      capabilities: { manageGovernance: false, canLeave: true },
                    }
                  : { error: 'unavailable' },
            });
          }
          if (path.endsWith('/credits'))
            return route.fulfill({
              json: { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] },
            });
          if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
          if (path === '/v1/feature-flags') return route.fulfill({ json: {} });
          const shell = shellRead(route.request().method(), path, workspace);
          if (shell) return route.fulfill(shell);
          throw new Error(`Unexpected request ${path}`);
        });
        try {
          await page.goto(`${origin}/${workspace.slug}/help`);
          await Promise.race([
            membership.promise,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Membership waited for discovery')), 5000).unref(),
            ),
          ]);
          assert.equal(
            await page.getByRole('heading', { name: 'Help and support', exact: true }).count(),
            0,
            'Membership alone does not admit the page',
          );
          list.resolve();
          if (status === 200) await page.getByRole('heading', { name: 'Help and support', exact: true }).waitFor();
          else if (status === 503) {
            await page.getByRole('heading', { name: 'Could not open TulipFarm' }).waitFor();
            await delay(500);
            memberStatus = 200;
            await page.getByRole('button', { name: 'Try again', exact: true }).click();
            await page.getByRole('heading', { name: 'Help and support', exact: true }).waitFor();
          } else {
            // Cold-entry denial renders the workspace not-found boundary at the requested URL.
            await page.getByRole('heading', { name: 'Page not found', exact: true }).waitFor();
            assert.equal(page.url(), `${origin}/${workspace.slug}/help`);
            assert.equal(await page.getByRole('heading', { name: 'Help and support', exact: true }).count(), 0);
          }
          assert.deepEqual(errors, []);
        } finally {
          list.resolve();
          await context.close();
        }
      });
  } finally {
    await browser.close();
    await new Promise(resolve => server.httpServer.close(resolve));
  }
});
