import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { conversationPages } from '../../api/src/conversation-pages.ts';

const { workspace, session } = createWorkspaceFixture();
const chatId = randomUUID();
const now = new Date().toISOString();
const chats = Array.from({ length: 500 }, (_, index) => ({
  id: index ? randomUUID() : chatId,
  title: `Customer review ${index}`,
  titleRevision: 0,
  archived: false,
  activityAt: now,
  createdAt: now,
}));
const messages = Array.from({ length: 250 }, (_, index) => ({
  id: randomUUID(),
  sequence: index + 1,
  author: 'assistant',
  createdAt: now,
  turn: null,
  parts: [
    {
      kind: 'text',
      text: `## Review ${index + 1}\n\nCheck **customer ownership** and [the source](https://example.test/source).\n\n| Customer | Next action |\n| --- | --- |\n| Cedar | Review the proposal |\n| Northstar | Confirm the owner |\n\n- Retain the original request.\n- Ask for approval before sending.\n\n\`\`\`json\n{"customer":"Cedar","send":false}\n\`\`\``,
    },
  ],
}));
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/v1/**', async route => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      let json;
      const listPage = (cursor, query) => {
        const start = Number(cursor ?? 0);
        const filtered = chats.filter(chat => chat.title.includes(query ?? ''));
        return {
          chats: filtered.slice(start, start + 50),
          nextCursor: start + 50 < filtered.length ? String(start + 50) : null,
        };
      };
      const historyPage = before => {
        const older = messages.filter(message => message.sequence < (before ?? Infinity));
        return {
          messages: older.slice(-50),
          nextBefore: older.length > 50 ? older.at(-50).sequence : null,
          hasGitHubProposals: false,
        };
      };
      if (path.endsWith('/conversations/pages')) {
        const body = route.request().postDataJSON();
        await route.fulfill({
          json: await conversationPages(
            body.count,
            body.cursor,
            body.known,
            async cursor => listPage(cursor, body.query),
            page => page.nextCursor,
          ),
        });
        return;
      }
      if (path.endsWith(`/conversations/${chatId}/messages/pages`)) {
        const body = route.request().postDataJSON();
        await route.fulfill({
          json: {
            chat: chats[0],
            ...(await conversationPages(
              body.count,
              body.before,
              body.known,
              async before => historyPage(before),
              page => page.nextBefore,
            )),
          },
        });
        return;
      }
      if (path.endsWith('/get-session')) json = session;
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
      else if (path.endsWith('/projects')) json = [];
      else if (path.endsWith('/conversations'))
        json = listPage(url.searchParams.get('cursor'), url.searchParams.get('query'));
      else if (path.endsWith(`/conversations/${chatId}`)) json = chats[0];
      else if (path.endsWith(`/conversations/${chatId}/messages`))
        json = historyPage(url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null);
      else {
        await route.fulfill({ status: 404, json: { error: 'not-found' } });
        return;
      }
      await route.fulfill({ json });
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Performance.enable');
    await page.goto(`${origin}/${workspace.slug}/chat`);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="table"][aria-label="Chats"] button')].some(
        button => button.textContent === 'Customer review 49',
      ),
    );
    const listStarted = performance.now();
    for (let count = 100; count <= 500; count += 50) {
      await page.getByRole('button', { name: 'Load more chats', exact: true }).click();
      await page.waitForFunction(
        count =>
          document.querySelectorAll('[role="table"][aria-label="Chats"] [role="rowgroup"] > [role="row"]').length ===
          count,
        count,
      );
    }
    const listLoadMs = Math.round(performance.now() - listStarted);
    const searchStarted = performance.now();
    await page.getByRole('textbox', { name: 'Search chat titles' }).fill('Customer review 499');
    await page.getByRole('textbox', { name: 'Search chat titles' }).press('Enter');
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[role="table"][aria-label="Chats"] [role="rowgroup"] > [role="row"]').length === 1,
    );
    const listSearchMs = Math.round(performance.now() - searchStarted);
    await page.goto(`${origin}/${workspace.slug}/chat/${chatId}`);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('h2')].some(heading => heading.textContent === 'Review 250'),
    );
    const historyStarted = performance.now();
    for (let count = 100; count <= 250; count += 50) {
      await page.getByRole('button', { name: 'Load older messages', exact: true }).click();
      await page.waitForFunction(
        count => document.querySelectorAll('ol[aria-label="Messages"] > li').length === count,
        count,
      );
    }
    const historyLoadMs = Math.round(performance.now() - historyStarted);
    assert.equal(await page.getByRole('table').count(), 250);
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await input.focus();
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    const before = (await cdp.send('Performance.getMetrics')).metrics;
    const typingStarted = performance.now();
    await input.pressSequentially('Keep this draft');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const typingMs = Math.round(performance.now() - typingStarted);
    const after = (await cdp.send('Performance.getMetrics')).metrics;
    const { profile } = await cdp.send('Profiler.stop');
    const hotFunctions = profile.nodes
      .filter(node => node.hitCount)
      .sort((a, b) => b.hitCount - a.hitCount)
      .slice(0, 8)
      .map(node => ({
        function: node.callFrame.functionName,
        file: node.callFrame.url.split('/').pop(),
        hits: node.hitCount,
      }));
    const delta = name =>
      Math.round(
        1000 * (after.find(metric => metric.name === name).value - before.find(metric => metric.name === name).value),
      );
    assert.equal(await input.innerText(), 'Keep this draft');
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
    const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
    await conversation.evaluate(element => {
      element.scrollTop = 0;
    });
    await page.getByRole('button', { name: 'Jump to latest' }).waitFor();
    await input.pressSequentially(' safely');
    assert.equal(await conversation.evaluate(element => element.scrollTop), 0);
    await page.getByRole('button', { name: 'Jump to latest' }).click();
    await page.waitForFunction(() => {
      const element = document.querySelector('[aria-label="Conversation"]');
      return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
    });
    results.push({
      run,
      listLoadMs,
      listSearchMs,
      historyLoadMs,
      typingMs,
      typingScriptMs: delta('ScriptDuration'),
      typingTaskMs: delta('TaskDuration'),
      typingLayoutMs: delta('LayoutDuration'),
      typingStyleMs: delta('RecalcStyleDuration'),
      hotFunctions,
    });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    JSON.stringify(
      {
        method:
          'Production build, 4x CPU, local API fixtures, 500 chats in ten pages, 250 markdown messages in five pages. Typing sends 15 sequential keys and waits two animation frames.',
        results,
      },
      null,
      2,
    ),
  );
  if (process.env.PERF_BASELINE !== '1')
    assert.ok(
      results.every(result => result.typingMs < 2500),
      'Typing through retained history stays below 2.5 seconds for 15 keys at 4x CPU',
    );
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
