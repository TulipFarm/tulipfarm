import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { shellRead } from './shell-reads.mjs';

const origin = 'http://127.0.0.1:5781';
const workspace = {
  id: '10000000-0000-4000-8000-000000000081',
  slug: 'saved-lists',
  name: 'Saved lists',
  createdAt: '2026-10-01T00:00:00Z',
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const agent = (id, name) => ({
  id,
  name,
  owningTeamId: '30000000-0000-4000-8000-000000000081',
  savedRevision: 'a'.repeat(40),
  definitionRevision: 'b'.repeat(64),
});
const saved = agent('20000000-0000-4000-8000-000000000081', 'Saved guide');
const found = agent('20000000-0000-4000-8000-000000000082', 'Searched guide');

test(
  'a reload shows the saved first page of a list while the network is held, and drops it when access is denied',
  {
    timeout: 120000,
  },
  async () => {
    const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5781', '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    });
    let browser;
    try {
      for (
        let attempt = 0;
        !(await fetch(origin).then(
          response => response.ok,
          () => false,
        ));
        attempt++
      ) {
        assert.ok(attempt < 150 && server.exitCode === null, 'Vite starts');
        await delay(100);
      }
      browser = await chromium.launch();
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const state = { list: 'answer', held: [] };
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (path === '/v1/auth/get-session')
          return route.fulfill({
            json: {
              session: { id: 'browser', userId: 'reader' },
              user: { id: 'reader', name: 'Reader', email: 'reader@example.test' },
            },
          });
        if (path === '/v1/workspaces') return route.fulfill({ json: [workspace] });
        if (path === `/v1/workspaces/${workspace.slug}`) return route.fulfill({ json: workspace });
        if (path.endsWith('/governance/me'))
          return route.fulfill({
            json: {
              membershipId: '40000000-0000-4000-8000-000000000081',
              role: 'member',
              teams: [],
              capabilities: { manageGovernance: false, canLeave: true },
            },
          });
        if (path.endsWith('/agents/authoring-context'))
          return route.fulfill({ json: { currentSoulRevision: 'a'.repeat(40), teams: [], admin: false } });
        if (path.endsWith('/agents')) {
          if (url.searchParams.has('search')) return route.fulfill({ json: { agents: [found], nextCursor: null } });
          if (state.list === 'hold') return void state.held.push(route);
          if (state.list === 'deny') return route.fulfill({ status: 403, json: { error: 'forbidden' } });
          return route.fulfill({ json: { agents: [saved], nextCursor: null } });
        }
        const shell = shellRead(request.method(), path, workspace);
        if (shell) return route.fulfill(shell);
        return route.fulfill({ status: 404, json: { error: 'not-found' } });
      });
      const savedNames = () =>
        page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const request = indexedDB.open('tulipfarm-query-cache', 1);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const db = request.result;
                const reads = db.transaction('reads', 'readonly').objectStore('reads').getAll();
                reads.onsuccess = () => {
                  db.close();
                  resolve(reads.result.map(read => `${read.name} ${JSON.stringify(read.key)}`));
                };
                reads.onerror = () => reject(reads.error);
              };
            }),
        );
      const waitFor = async (check, message) => {
        for (let attempt = 0; !(await check()); attempt++) {
          assert.ok(attempt < 100, message);
          await delay(100);
        }
      };
      const agents = `${origin}/${workspace.slug}/agents`;
      const link = name => page.getByRole('main').getByRole('link', { name, exact: true });

      await page.goto(agents);
      await link(saved.name).waitFor();
      await page.getByRole('searchbox', { name: 'Find agents' }).fill('Searched');
      await link(found.name).waitFor();
      await waitFor(async () => {
        const names = await savedNames();
        return names.some(name => name.startsWith('agents ')) && names.some(name => name.startsWith('agent-context '));
      }, 'The first agents page and authoring context are saved');
      const lists = (await savedNames()).filter(name => name.startsWith('agents '));
      assert.equal(lists.length, 1, 'Searches are not saved');
      assert.match(lists[0], /"search":""/);

      state.list = 'hold';
      await page.goto(agents);
      await link(saved.name).waitFor();
      await waitFor(async () => state.held.length > 0, 'The list read is still waiting on the network');

      // A denied refresh removes the saved page from the screen and from disk.
      state.list = 'deny';
      for (const route of state.held.splice(0)) await route.fulfill({ status: 403, json: { error: 'forbidden' } });
      await link(saved.name).waitFor({ state: 'detached' });
      await waitFor(
        async () => !(await savedNames()).some(name => name.startsWith('agents ')),
        'The denied list is removed from disk',
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      server.kill('SIGTERM');
    }
  },
);
