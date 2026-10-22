import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';

test(
  'opening and switching workspaces saves the preference without prefetch or failed access writes',
  { timeout: 60000 },
  async () => {
    const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { port: 0 } });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const origin = server.resolvedUrls.local[0];
      const first = {
        id: '11111111-1111-4111-8111-111111111111',
        slug: 'northstar',
        name: 'Northstar Studio',
        status: 'ready',
        createdAt: '2026-10-01T00:00:00Z',
        soulCommit: 'a'.repeat(40),
      };
      const second = { ...first, id: '22222222-2222-4222-8222-222222222222', slug: 'river', name: 'River Studio' };
      const writes = [];
      const errors = [];
      let saveStatus = 204;
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.route('**/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/last-used')) {
          assert.equal(route.request().method(), 'PUT');
          writes.push(path);
          await route.fulfill(
            saveStatus === 204 ? { status: 204 } : { status: saveStatus, json: { error: 'Storage unavailable' } },
          );
          return;
        }
        let json;
        if (path === '/v1/auth/get-session')
          json = {
            session: { id: 'session', userId: 'viewer' },
            user: { id: 'viewer', name: 'Mira', email: 'mira@example.test' },
          };
        else if (path === '/v1/workspaces') json = [first, second];
        else if (path === '/v1/workspaces/northstar') json = first;
        else if (path === '/v1/workspaces/river') json = second;
        else if (path.endsWith('/governance/me'))
          json = {
            membershipId: first.id,
            role: 'member',
            teams: [],
            capabilities: { manageGovernance: false, canLeave: true },
          };
        else if (path.endsWith('/model-catalog')) json = chatCatalog;
        else if (path === '/v1/user/visit') json = { firstSession: false };
        else if (path.endsWith('/credits'))
          json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
        else {
          await route.fulfill({ status: 404, json: { error: 'Not found' } });
          return;
        }
        await route.fulfill({ json });
      });
      async function open(slug, status = 204) {
        const saved = page.waitForResponse(
          response => response.url().endsWith(`/workspaces/${slug}/last-used`) && response.status() === status,
        );
        await page.goto(`${origin}${slug}`);
        await saved;
        await page.getByLabel('Message', { exact: true }).waitFor();
      }
      await open('northstar');
      assert.deepEqual(writes, ['/v1/workspaces/northstar/last-used']);
      assert.equal(await page.evaluate(() => localStorage.getItem('tulipfarm:last-workspace:viewer')), first.id);
      await open('river');
      assert.equal(writes.at(-1), '/v1/workspaces/river/last-used');
      assert.equal(await page.evaluate(() => localStorage.getItem('tulipfarm:last-workspace:viewer')), second.id);
      saveStatus = 503;
      await open('northstar', 503);
      assert.ok(errors.some(message => message.includes('Could not save your last workspace. Reload to try again.')));
      saveStatus = 204;
      await open('northstar');
      const count = writes.length;
      await page.goto(`${origin}missing`);
      await page.getByRole('heading', { name: 'Page not found' }).waitFor();
      assert.equal(writes.length, count);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
