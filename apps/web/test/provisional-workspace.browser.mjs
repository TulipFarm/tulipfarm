import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startBuiltApp } from './built-app.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';

// Runs against the production build (`VITE_API_URL= pnpm --filter @tulipfarm/web build`): the dev
// server's unbundled modules load slower than the provisional render waits for the disk snapshot.
test(
  'a return visit shows the remembered workspace from disk, holds writes until the session check, and conceals it when access changed',
  { timeout: 120000 },
  async () => {
    const app = await startBuiltApp();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      const origin = `${app.origin}/`;
      const workspace = {
        id: '11111111-1111-4111-8111-111111111111',
        slug: 'northstar',
        name: 'Northstar Studio',
        status: 'ready',
        createdAt: '2026-10-01T00:00:00Z',
        soulCommit: 'a'.repeat(40),
      };
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const memberships = {
        viewer: '33333333-3333-4333-8333-333333333333',
        other: '44444444-4444-4444-8444-444444444444',
      };
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
      const state = { user: 'viewer', sessionId: 'session', hold: false, membershipStatus: 200 };
      let held = [];
      let log = [];
      const respond = async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/v1/auth/get-session') {
          await route.fulfill({
            json: {
              session: { id: state.sessionId, userId: state.user, expiresAt },
              user: { id: state.user, name: state.user, email: `${state.user}@example.test` },
            },
          });
          return;
        }
        if (path.endsWith('/last-used')) {
          await route.fulfill({ status: 204 });
          return;
        }
        if (path === '/v1/auth/sign-out') {
          await route.fulfill({ json: { success: true } });
          return;
        }
        let json;
        let status = 200;
        if (path === '/v1/workspaces') json = [workspace];
        else if (path === '/v1/workspaces/northstar') json = workspace;
        else if (path.endsWith('/governance/me')) {
          status = state.membershipStatus;
          json =
            status === 200
              ? {
                  membershipId: memberships[state.user],
                  role: 'member',
                  teams: [],
                  capabilities: { manageGovernance: false, canLeave: true },
                }
              : { error: 'Forbidden' };
        } else if (path.endsWith('/projects')) json = [];
        else if (path.endsWith('/model-catalog')) json = chatCatalog;
        else if (path === '/v1/user/visit') json = { firstSession: false };
        else if (path.endsWith('/credits'))
          json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
        else {
          await route.fulfill({ status: 404, json: { error: 'Not found' } });
          return;
        }
        await route.fulfill({ status, json });
      };
      await page.route('**/v1/**', async route => {
        const path = new URL(route.request().url()).pathname;
        log.push(`${route.request().method()} ${path}`);
        const checksAccess =
          path === '/v1/auth/get-session' || (path.endsWith('/governance/me') && state.membershipStatus !== 200);
        if (state.hold && checksAccess) held.push(route);
        else await respond(route);
      });
      const stored = () =>
        page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const request = indexedDB.open('tulipfarm-query-cache', 1);
              request.onupgradeneeded = () => {
                for (const name of ['reads', 'index', 'admissions']) request.result.createObjectStore(name);
              };
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction(['reads', 'admissions'], 'readonly');
                const reads = transaction.objectStore('reads').getAllKeys();
                const admissions = transaction.objectStore('admissions').getAllKeys();
                transaction.oncomplete = () => {
                  db.close();
                  resolve({ reads: reads.result.map(String), admissions: admissions.result.map(String) });
                };
              };
            }),
        );
      const waitFor = async (check, message) => {
        for (let attempt = 0; !(await check()); attempt++) {
          assert.ok(attempt < 100, message);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };
      const composer = page.getByLabel('Message', { exact: true });
      const confirmedVisit = async () => {
        log = [];
        state.hold = false;
        await page.goto(`${origin}northstar`);
        await composer.waitFor();
        await waitFor(async () => {
          const { reads, admissions } = await stored();
          return reads.some(id => id.includes(`"${state.user}"`)) && admissions.length > 0;
        }, 'The admission and the project list are persisted after a confirmed visit');
      };
      const release = async () => {
        state.hold = false;
        for (const route of held) await respond(route).catch(() => {});
        held = [];
      };
      const heldVisit = async ({ membershipStatus = 200 } = {}) => {
        for (let attempt = 1; ; attempt++) {
          held = [];
          log = [];
          state.hold = true;
          state.membershipStatus = membershipStatus;
          await page.goto(`${origin}northstar`);
          try {
            await composer.waitFor({ timeout: 5_000 });
            break;
          } catch (error) {
            // The disk snapshot must load within the router's 300 ms provisional wait, which a busy
            // machine can miss. Let the checks pass and try the return visit again.
            if (attempt === 3) throw error;
            state.membershipStatus = 200;
            await release();
            await composer.waitFor();
          }
        }
        assert.ok(held.length > 0, 'The workspace shows while its access checks are still pending');
      };

      await confirmedVisit();
      const membershipReads = () => log.filter(entry => entry.endsWith('/governance/me')).length;
      const firstVisitMembershipReads = membershipReads();
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('tulipfarm:last-session'))), {
        userId: 'viewer',
        sessionId: 'session',
      });

      // Same session: the provisional workspace is confirmed, held writes go out after the check, and
      // the reads started for the remembered session are used rather than repeated.
      await heldVisit();
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(log.filter(entry => entry.startsWith('PUT ')).length, 0, 'Writes wait for the session check');
      await release();
      await waitFor(async () => log.includes('PUT /v1/workspaces/northstar/last-used'), 'The held write is sent');
      await composer.waitFor();
      assert.equal(log.filter(entry => entry === 'GET /v1/workspaces/northstar').length, 1);
      assert.equal(membershipReads(), firstVisitMembershipReads, 'The early membership read is reused');

      // A different user signs in: the remembered reads are discarded and the old user's cache cleared.
      await heldVisit();
      state.user = 'other';
      state.sessionId = 'session-other';
      await release();
      await waitFor(
        async () => (await page.evaluate(() => localStorage.getItem('tulipfarm:last-session')))?.includes('other'),
        'The new session is remembered',
      );
      await composer.waitFor();
      assert.ok(log.filter(entry => entry === 'GET /v1/workspaces/northstar').length >= 2, 'Workspace read again');
      assert.ok(log.filter(entry => entry.endsWith('/governance/me')).length >= 2, 'Membership read again');
      await waitFor(async () => {
        const { reads, admissions } = await stored();
        return ![...reads, ...admissions].some(id => id.includes('"viewer"'));
      }, "The previous user's persisted reads and admission are cleared");

      // Membership revoked: the provisional workspace is replaced by not found and its cache cleared.
      await confirmedVisit();
      await heldVisit({ membershipStatus: 403 });
      await release();
      await page.getByRole('heading', { name: 'Page not found' }).waitFor();
      assert.equal(await composer.count(), 0, 'The provisional workspace is concealed');
      await waitFor(async () => {
        const { reads, admissions } = await stored();
        return reads.length === 0 && admissions.length === 0;
      }, 'The denied workspace cache is cleared');
      assert.equal(log.filter(entry => entry.startsWith('PUT ')).length, 0, 'Held writes are not sent');

      // Logging out clears everything persisted on this device.
      state.membershipStatus = 200;
      await confirmedVisit();
      await page.goto(`${origin}logout`);
      await page.waitForURL(/\/login/);
      assert.deepEqual(await stored(), { reads: [], admissions: [] });
      assert.equal(await page.evaluate(() => localStorage.getItem('tulipfarm:last-session')), null);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.close();
    }
  },
);
