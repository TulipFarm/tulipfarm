import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { shellRead } from './shell-reads.mjs';

const origin = 'http://127.0.0.1:5782';
const workspace = {
  id: '10000000-0000-4000-8000-000000000091',
  slug: 'link-intent',
  name: 'Link intent',
  createdAt: '2026-10-01T00:00:00Z',
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const project = (id, name) => ({ id, name, instructions: '', revision: 1, archived: false, manager: true });
const first = project('20000000-0000-4000-8000-000000000091', 'First launch');
const second = project('20000000-0000-4000-8000-000000000092', 'Second launch');

test('pointing at or focusing a record link starts the read its page opens with', { timeout: 120000 }, async () => {
  const server = spawn(
    process.execPath,
    ['test/serve-built-app.mjs', '--host', '127.0.0.1', '--port', '5782', '--strictPort'],
    {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    },
  );
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
    const details = [];
    await page.route('**/v1/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
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
            membershipId: '40000000-0000-4000-8000-000000000091',
            role: 'member',
            teams: [],
            capabilities: { manageGovernance: false, canLeave: true },
          },
        });
      if (path.endsWith('/projects') && request.method() === 'GET') return route.fulfill({ json: [first, second] });
      const detail = /\/projects\/([0-9a-f-]{36})$/.exec(path);
      if (detail && request.method() === 'GET') {
        details.push(detail[1]);
        return route.fulfill({ status: 404, json: { error: 'not-found' } });
      }
      const shell = shellRead(request.method(), path, workspace);
      if (shell) return route.fulfill(shell);
      return route.fulfill({ status: 404, json: { error: 'not-found' } });
    });
    const waitFor = async (check, message) => {
      for (let attempt = 0; !(await check()); attempt++) {
        assert.ok(attempt < 100, message);
        await delay(100);
      }
    };
    const link = name => page.getByRole('main').getByRole('link', { name, exact: true });

    await page.goto(`${origin}/${workspace.slug}/projects`);
    await link(first.name).waitFor();
    await link(second.name).waitFor();

    // Passing over a link without pausing reads nothing.
    const box = await link(first.name).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(0, 0);
    await delay(400);
    assert.deepEqual(details, []);

    await link(first.name).hover();
    await waitFor(async () => details.includes(first.id), 'Pausing on a link reads its project');
    await link(second.name).focus();
    await waitFor(async () => details.includes(second.id), 'Focusing a link reads its project');
    // A denied read is dropped rather than kept, so it is read again rather than shown from memory.
    await page.mouse.move(0, 0);
    await link(first.name).hover();
    await waitFor(
      async () => details.filter(id => id === first.id).length === 2,
      'A failed read is not kept for the page',
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
});
