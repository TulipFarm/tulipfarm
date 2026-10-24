import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';
import { openChatList } from './browser-controls.mjs';

const port = Number(process.env.CHAT_TITLE_BROWSER_PORT ?? 5297);
const origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      if (attempt === 100) throw new Error('Vite did not start');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const workspace = {
      id: randomUUID(),
      slug: 'acme',
      name: 'Acme',
      status: 'ready',
      createdAt: '2026-09-28T00:00:00Z',
      soulCommit: 'a'.repeat(40),
    };
    const chat = {
      id: randomUUID(),
      title: 'Help me track customer follow-ups',
      titleRevision: 1,
      titleManual: false,
      archived: false,
      activityAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    const messages = [
      {
        id: randomUUID(),
        sequence: 1,
        author: 'human',
        createdAt: new Date().toISOString(),
        parts: [{ kind: 'text', text: chat.title }],
        turn: { id: randomUUID(), status: 'processing', generation: 0 },
      },
    ];
    let historyStatus = 200;
    let readDelay = 200;
    let completeDuringHistory = false;
    // History reads the chat and its messages in parallel (conversation-api.ts:200-203), so whichever arrives first sees the completed reply.
    const complete = () => {
      if (!completeDuringHistory) return;
      completeDuringHistory = false;
      chat.title = 'Customer follow-up planning';
      chat.titleRevision++;
      messages[0].turn.status = 'completed';
      messages.push({
        id: randomUUID(),
        sequence: 2,
        author: 'assistant',
        createdAt: new Date().toISOString(),
        parts: [{ kind: 'text', text: 'Here is your follow-up plan.' }],
        turn: null,
      });
    };
    await page.route('**/v1/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let json;
      let status = 200;
      if (path === '/v1/auth/get-session')
        json = {
          session: { id: 'session-ada', userId: 'ada' },
          user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
        };
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === '/v1/workspaces/acme') json = workspace;
      else if (path.endsWith('/governance/me')) json = membership;
      else if (path.endsWith('/credits')) json = credits;
      else if (path.endsWith('/model-catalog')) json = chatCatalog;
      else if (path.endsWith(`/conversations/${chat.id}/messages`)) {
        complete();
        await setTimeout(readDelay);
        status = historyStatus;
        json = { messages, nextBefore: null };
      } else if (path.endsWith(`/conversations/${chat.id}`)) {
        if (request.method() === 'PATCH') {
          const body = request.postDataJSON();
          assert.equal(body.expectedRevision, chat.titleRevision);
          chat.title = body.title;
          chat.titleRevision++;
          chat.titleManual = true;
          json = { titleRevision: chat.titleRevision };
        } else {
          complete();
          json = chat;
        }
      } else if (path.endsWith('/conversations')) json = { chats: [chat], nextCursor: null };
      else {
        status = 404;
        json = { error: 'not-found' };
      }
      await route.fulfill({ status, json: status === 200 ? json : { error: 'unavailable' } });
    });
    const action = async name => {
      await page.getByRole('button', { name: 'Chat actions', exact: true }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    };
    const header = page.locator('header[aria-label="Workspace header"]');
    const visible = header.locator('h1 [aria-hidden="true"]');
    await page.goto(`${origin}/acme/chat/${chat.id}`);
    await header.getByText('Loading chat…', { exact: true }).waitFor();
    await header.getByRole('heading', { name: chat.title, exact: true }).waitFor();
    assert.equal(await visible.textContent(), chat.title);
    assert.equal(await page.title(), `${chat.title} · TulipFarm`);
    readDelay = 0;
    historyStatus = 503;
    await page.getByLabel('Message', { exact: true }).fill('Keep my draft');
    // A pending reply keeps polling on its own; the manual 'Check chat status' action is gone (cloud 58dcdcf6 #699).
    await page.getByRole('button', { name: 'Retry refresh', exact: true }).waitFor();
    assert.equal(await visible.textContent(), chat.title);
    assert.equal(await page.getByLabel('Message', { exact: true }).textContent(), 'Keep my draft');
    historyStatus = 200;
    completeDuringHistory = true;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
    await header.getByRole('heading', { name: 'Customer follow-up planning', exact: true }).waitFor();
    assert.equal(await page.title(), 'Customer follow-up planning · TulipFarm');
    const partial = await visible.textContent();
    assert.ok(
      partial.length > 0 && partial.length < chat.title.length,
      `Expected a partially typed title, got ${partial}`,
    );
    await page.waitForFunction(
      () => document.querySelector('h1 [aria-hidden="true"]')?.textContent === 'Customer follow-up planning',
    );
    assert.equal(
      await page.getByRole('list', { name: 'Messages', exact: true }).getByText(chat.title, { exact: true }).count(),
      0,
    );
    await page.getByLabel('Message', { exact: true }).fill('');
    await page.reload();
    await header.getByRole('heading', { name: chat.title, exact: true }).waitFor();
    assert.equal(await visible.textContent(), chat.title, 'Saved titles render immediately');
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      chat.title = `Follow-up schedule ${theme}`;
      chat.titleRevision++;
      // A settled chat no longer polls and has no manual status check (cloud 58dcdcf6 #699), so a reload shows the server's title.
      await page.reload();
      await header.getByRole('heading', { name: chat.title, exact: true }).waitFor();
      assert.equal(await visible.textContent(), chat.title);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.CHAT_TITLE_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.CHAT_TITLE_SCREENSHOT_DIR}/title-${viewport.width}-${theme}.png`,
        });
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await action('Edit title');
    await page.getByLabel('Chat title', { exact: true }).fill('a'.repeat(51));
    await page.getByText('Use at most 50 characters in the title.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save title', exact: true }).isDisabled(), true);
    await page.getByLabel('Chat title', { exact: true }).fill('My chosen title');
    await page.getByRole('button', { name: 'Save title', exact: true }).click();
    await header.getByRole('heading', { name: 'My chosen title', exact: true }).waitFor();
    assert.equal(await visible.textContent(), 'My chosen title', 'Manual titles render without typing');
    assert.equal(await page.title(), 'My chosen title · TulipFarm');
    await openChatList(page);
    await page.getByRole('button', { name: 'My chosen title', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'Chat titles passed: header-only typing, recovery, completion race, reload, manual rename, 50-character limit, desktop/mobile, themes, reduced motion.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
