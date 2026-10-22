import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { shellRead } from './shell-reads.mjs';
import { fileURLToPath } from 'node:url';

const apiDelay = Number(process.env.PERF_API_DELAY ?? 150);
const { workspace, session } = createWorkspaceFixture();
const server = await preview({
  root: process.env.PERF_APP_ROOT ?? fileURLToPath(new URL('..', import.meta.url)),
  preview: { host: '127.0.0.1', port: 0 },
});
const address = server.httpServer.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
let browser;
try {
  browser = await chromium.launch();
  const results = [];
  for (let run = 0; run < 3; run++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      sessionStorage.setItem('tulipfarm:performance', '1');
      window.perfLongTasks = [];
      new PerformanceObserver(list =>
        window.perfLongTasks.push(...list.getEntries().map(entry => entry.duration)),
      ).observe({ type: 'longtask', buffered: true });
    });
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      requests.push({ path, start: performance.now() });
      await delay(path === '/v1/workspaces' ? Number(process.env.PERF_LIST_DELAY ?? apiDelay) : apiDelay);
      let json;
      if (path === '/v1/auth/get-session') json = session;
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: workspace.id,
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        };
      else if (path.endsWith('/model-catalog')) json = chatCatalog;
      else if (path.endsWith('/credits'))
        json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
      else if (path.endsWith('/conversations')) json = { chats: [], nextCursor: null };
      else if (path.endsWith('/projects')) json = [];
      else if (path === '/v1/user/visit') json = { firstSession: false };
      else {
        const shell = shellRead(route.request().method(), path, workspace);
        if (!shell) throw new Error(`Unexpected API request: ${path}`);
        return route.fulfill(shell);
      }
      await route.fulfill({ json });
    });
    const started = performance.now();
    await page.goto(`${origin}/${workspace.slug}/help`);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('h1')].some(node => node.textContent === 'Help and support'),
    );
    const coldMs = performance.now() - started;
    const coldScripts = await page.evaluate(() =>
      performance
        .getEntriesByType('table')
        .filter(r => r.name.endsWith('.js'))
        .map(r => ({ file: r.name.split('/').pop(), bytes: r.decodedBodySize })),
    );
    await delay(1000);
    const coldRequests = requests.splice(0);
    const nav = page.getByRole('navigation', { name: 'Workspace navigation', exact: true });
    if (process.env.PERF_INTENT === '1') {
      await nav.getByRole('link', { name: 'Chats', exact: true }).hover();
      await nav.getByRole('link', { name: 'Chats', exact: true }).focus();
      await delay(500);
      assert.deepEqual(requests, [], 'Pointer and keyboard intent load code without admission or private reads');
    }
    const navigationStarted = performance.now();
    await nav.getByRole('link', { name: 'Chats', exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('h2')].some(node => node.textContent === 'No chats yet'),
    );
    const navigationMs = performance.now() - navigationStarted;
    const navigationRequests = requests.splice(0);
    const chatScripts = await page.evaluate(() =>
      performance
        .getEntriesByType('table')
        .filter(r => r.name.endsWith('.js'))
        .map(r => ({ file: r.name.split('/').pop(), bytes: r.decodedBodySize })),
    );
    if (process.env.PERF_BASELINE !== '1') {
      assert.ok(
        !chatScripts.some(script =>
          /workspace-home|message-response|tool-labels|github-download|attachment/.test(script.file),
        ),
        'Chat list does not load message, tool, or file rendering',
      );
      assert.ok(
        !navigationRequests.some(request => request.path.endsWith('/model-catalog')),
        'Chat list does not request model choices',
      );
    }
    await page.goBack();
    await page.getByRole('heading', { name: 'Help and support', exact: true }).waitFor();
    await delay(500);
    requests.length = 0;
    const warmStarted = performance.now();
    await nav.getByRole('link', { name: 'Chats', exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('h2')].some(node => node.textContent === 'No chats yet'),
    );
    const warmMs = performance.now() - warmStarted;
    if (process.env.PERF_BASELINE !== '1') {
      assert.ok(
        coldScripts.reduce((sum, script) => sum + script.bytes, 0) < 1_000_000,
        'Cold Help loads less than 1 MB of JavaScript',
      );
      assert.ok(
        !coldScripts.some(script => /workspace-home|message-response|file-viewer/.test(script.file)),
        'Help does not load chat or file rendering',
      );
      const admission = requests.filter(request =>
        /get-session$|\/workspaces$|\/workspaces\/chat-qa$|governance\/me$/.test(request.path),
      );
      assert.equal(admission.length, 4, 'Warm navigation still checks all four admission endpoints');
      assert.ok(
        Math.max(...admission.map(r => r.start)) - Math.min(...admission.map(r => r.start)) < apiDelay,
        'Admission requests overlap instead of forming a waterfall',
      );
    }
    const measures = await page.evaluate(() =>
      performance
        .getEntriesByType('measure')
        .filter(entry => entry.name.startsWith('tulipfarm:'))
        .map(entry => ({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
          detail: entry.detail,
        })),
    );
    if (process.env.PERF_BASELINE !== '1') {
      assert.equal(
        measures.filter(entry => entry.name === 'tulipfarm:chat-list:ready').length,
        2,
        'Cold and cached list mounts report readiness',
      );
      assert.ok(
        measures.every(entry => entry.detail === null),
        'Timing records contain no private metadata',
      );
    }
    results.push({
      run,
      coldMs: Math.round(coldMs),
      coldScriptBytes: coldScripts.reduce((sum, script) => sum + script.bytes, 0),
      coldScripts,
      chatScriptBytes: chatScripts.reduce((sum, script) => sum + script.bytes, 0),
      chatScripts,
      navigationMs: Math.round(navigationMs),
      warmMs: Math.round(warmMs),
      coldRequests: coldRequests.map(r => r.path),
      navigationRequests: navigationRequests.map(r => ({
        path: r.path,
        startMs: Math.round(r.start - navigationStarted),
      })),
      warmRequests: requests.map(r => r.path),
      measures,
      ...(await page.evaluate(() => ({ longTasks: window.perfLongTasks }))),
    });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    JSON.stringify(
      {
        apiDelay,
        listDelay: Number(process.env.PERF_LIST_DELAY ?? apiDelay),
        intent: process.env.PERF_INTENT === '1',
        results,
      },
      null,
      2,
    ),
  );
  if (process.env.PERF_BASELINE !== '1')
    assert.ok(
      results.every(r => r.warmMs < Number(process.env.PERF_MAX_WARM_MS ?? 350)),
      'Warm navigation meets its latency budget',
    );
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
