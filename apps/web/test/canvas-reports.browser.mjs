import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { textLayout } from '@tulipfarm/conversations/layout-contracts';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const port = Number(process.env.CANVAS_REPORTS_BROWSER_PORT ?? 5244);
const origin = `http://127.0.0.1:${port}`;
const id = '11111111-1111-4111-8111-111111111111';
const { workspace, session } = createWorkspaceFixture({ slug: 'canvas-qa', name: 'Canvas QA' });
const chat = {
  id,
  title: 'Pipeline review',
  titleRevision: 1,
  archived: false,
  activityAt: workspace.createdAt,
  createdAt: workspace.createdAt,
};
const messageId = n => `00000000-0000-4000-8000-00000000000${n}`;
const human = (n, text) => ({
  id: messageId(n),
  sequence: n,
  author: 'human',
  createdAt: workspace.createdAt,
  parts: [{ kind: 'text', text }],
  turn: { id: messageId(n), status: 'completed', generation: 0 },
  tools: [],
});
const report = (n, title, summary, body) => {
  const layout = { ...textLayout(body, messageId(n), { title }), placement: 'canvas', summary };
  return {
    id: messageId(n),
    sequence: n,
    author: 'assistant',
    createdAt: workspace.createdAt,
    parts: [{ kind: 'layout', text: summary, layout }],
    turn: { id: messageId(n - 1), status: 'completed', generation: 0 },
    tools: [],
  };
};
const messages = [
  human(1, 'Summarise Q3 pipeline by stage'),
  report(2, 'Q3 pipeline by stage', 'Q3 pipeline is $4.2M across 38 deals.', '- Negotiation: $1.7M'),
  human(3, 'Now compare win rates by region'),
  report(4, 'Win rates by region', 'EMEA leads at 34%.', '- APAC: 19%'),
];

test('an older Canvas report reopens from its reply, also after Canvas is closed', { timeout: 120000 }, async () => {
  const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    detached: true,
  });
  let browser;
  try {
    for (let attempt = 0; ; attempt++) {
      if (
        await fetch(origin).then(
          response => response.ok,
          () => false,
        )
      )
        break;
      assert.ok(attempt < 300 && server.exitCode === null, 'Vite starts');
      await delay(100);
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await context.route('**/v1/**', route => {
      const path = new URL(route.request().url()).pathname;
      let json;
      if (path === '/v1/user/visit') json = { firstSession: false };
      else if (path === '/v1/auth/get-session') json = session;
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: id,
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        };
      else if (path.endsWith('/model-catalog')) json = chatCatalog;
      else if (path.endsWith('/messages')) json = { messages, nextBefore: null, hasGitHubProposals: false };
      else if (/\/conversations\/[\w-]+$/.test(path)) json = chat;
      else return route.fulfill({ status: 404, json: { error: 'not-found' } });
      return route.fulfill({ json });
    });
    await page.goto(`${origin}/${workspace.slug}/chat/${id}`);
    const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
    const older = page.getByRole('button', { name: 'Open Q3 pipeline by stage in Canvas' });
    const latest = page.getByRole('button', { name: 'Open Win rates by region in Canvas' });

    await canvas.getByRole('tab', { name: 'Win rates by region' }).waitFor();
    assert.equal(await latest.getAttribute('aria-pressed'), 'true');
    assert.equal(await older.getAttribute('aria-pressed'), 'false');

    await older.click();
    await canvas.getByText('Negotiation: $1.7M').waitFor();
    assert.equal(await canvas.getByRole('tab', { name: 'Q3 pipeline by stage' }).getAttribute('aria-selected'), 'true');
    assert.equal(await canvas.getByRole('tab').count(), 2);
    assert.equal(await older.getAttribute('aria-pressed'), 'true');

    await canvas.getByRole('button', { name: 'Close Q3 pipeline by stage' }).click();
    await canvas.getByRole('button', { name: 'Close Win rates by region' }).click();
    await canvas.waitFor({ state: 'detached' });
    await older.click();
    await canvas.getByText('Negotiation: $1.7M').waitFor();
    assert.equal(await canvas.getByRole('tab').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    try {
      process.kill(-server.pid);
    } catch {}
  }
});
