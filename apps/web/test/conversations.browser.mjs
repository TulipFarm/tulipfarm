import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits, notifyChange } from './chat-query.fixture.mjs';
import { conversationPages } from '../../api/src/conversation-pages.ts';

const port = Number(process.env.CONVERSATION_BROWSER_PORT ?? 5293);
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
      if (attempt === 600) throw new Error('Vite did not start');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const chatAction = async name => {
    const direct = page.getByRole('button', { name, exact: true });
    if (await direct.isVisible()) {
      await direct.click();
      return;
    }
    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(60000);
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
  const second = { ...workspace, id: randomUUID(), slug: 'other', name: 'Other' };
  const chats = [];
  const messages = new Map();
  const receipts = new Map();
  const writes = [];
  let userId = 'ada';
  let listStatus = 503;
  let historyStatus = 200;
  let writeStatus = 200;
  let delay = 0;
  let dropWrite = false;
  let historyRequests = 0;
  const api = async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    let status = 200;
    let json;
    if (path === '/v1/auth/get-session')
      json = {
        session: { id: `session-${userId}`, userId },
        user: { id: userId, name: userId, email: `${userId}@example.com` },
      };
    else if (path === '/v1/workspaces') json = [workspace, second];
    else if (path === '/v1/workspaces/acme') json = workspace;
    else if (path === '/v1/workspaces/other') json = second;
    else if (path.endsWith('/governance/me')) json = membership;
    else if (path.endsWith('/credits')) json = credits;
    else if (path.endsWith('/model-catalog')) json = chatCatalog;
    else if (path.endsWith('/events')) status = 503;
    else if (path.includes('/conversations')) {
      const suffix = path.split('/conversations')[1];
      const id = suffix.split('/')[1];
      const chat = chats.find(item => item.id === id);
      await setTimeout(delay);
      const listPage = (archived, query, cursor) => {
        const filtered =
          path.includes(second.id) || userId !== 'ada'
            ? []
            : chats.filter(
                item => item.archived === archived && item.title.toLowerCase().includes(query.toLowerCase()),
              );
        const start = Number(cursor ?? 0);
        return {
          chats: filtered.slice(start, start + 50),
          nextCursor: filtered.length > start + 50 ? String(start + 50) : null,
        };
      };
      const historyPage = before => {
        const older = messages.get(id).filter(message => message.sequence < (before ?? Infinity));
        return {
          messages: older.slice(-50),
          nextBefore: older.length > 50 ? older.at(-50).sequence : null,
          hasGitHubProposals: false,
        };
      };
      // Loaded list and history windows are re-read in one POST since cloud 26c5e10b (#1007), features/chat/conversation-api.ts:176 and :210.
      if (method === 'POST' && suffix === '/pages') {
        const body = request.postDataJSON();
        status = listStatus;
        json = await conversationPages(
          body.count,
          body.cursor,
          body.known,
          async cursor => listPage(body.archived, body.query, cursor),
          page => page.nextCursor,
        );
      } else if (method === 'POST' && suffix === `/${id}/messages/pages`) {
        historyRequests++;
        const body = request.postDataJSON();
        status = historyStatus;
        if (!chat || userId !== 'ada') status = 404;
        else
          json = {
            chat,
            ...(await conversationPages(
              body.count,
              body.before,
              body.known,
              async before => historyPage(before),
              page => page.nextBefore,
            )),
          };
      } else if (method === 'GET' && !suffix) {
        status = listStatus;
        json = listPage(
          url.searchParams.get('archived') === 'true',
          url.searchParams.get('query') ?? '',
          url.searchParams.get('cursor'),
        );
      } else if (method === 'GET') {
        historyRequests++;
        status = historyStatus;
        if (!chat || userId !== 'ada') status = 404;
        else if (suffix.endsWith('/messages')) {
          json = historyPage(url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null);
        } else json = chat;
      } else {
        const body = request.postDataJSON();
        writes.push({ path, method, body });
        status = writeStatus;
        await setTimeout(150);
        if (status === 200) {
          json = receipts.get(body.commandId);
          if (!json) {
            if (method === 'PUT' && !suffix.includes('/messages/')) {
              chats.unshift({
                id,
                title: 'New chat',
                titleRevision: 0,
                archived: false,
                activityAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
              });
              messages.set(id, []);
              json = { id };
            } else if (method === 'PUT') {
              const history = messages.get(id);
              const message = {
                id: suffix.split('/').at(-1),
                sequence: history.length + 1,
                author: 'human',
                createdAt: new Date().toISOString(),
                parts: body.parts,
                turn: { id: randomUUID(), generation: 0, status: 'queued' },
              };
              history.push(message);
              if (history.length === 1) {
                chat.title = body.parts[0].text;
                chat.titleRevision++;
              }
              json = { messageId: message.id, turnId: message.turn.id, sequence: message.sequence };
            } else if (method === 'PATCH') {
              if ('title' in body) {
                if (chat.titleRevision !== body.expectedRevision) status = 409;
                else {
                  chat.title = body.title;
                  chat.titleRevision++;
                  json = { titleRevision: chat.titleRevision };
                }
              } else {
                chat.archived = body.archived;
                json = { archived: chat.archived };
              }
            } else {
              const message = messages.get(id).find(message => message.turn?.id === suffix.split('/')[3]);
              assert.equal(body.expectedGeneration, message.turn.generation);
              message.turn.generation++;
              message.turn.status = suffix.endsWith('/retry') ? 'queued' : 'cancelled';
              json = { turnId: message.turn.id, generation: message.turn.generation, status: message.turn.status };
            }
            if (status === 200) receipts.set(body.commandId, json);
          }
          if (dropWrite) {
            dropWrite = false;
            await route.abort('failed');
            return;
          }
        }
      }
    } else {
      status = 404;
    }
    await route.fulfill({
      status,
      json: status === 200 ? json : { error: 'unavailable' },
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
    });
  };
  await page.route('**/v1/**', api);
  await page.goto(`${origin}/acme`);
  await page.getByRole('region', { name: 'Conversation', exact: true }).getByRole('heading', { level: 2 }).waitFor();
  assert.equal(page.url(), `${origin}/acme`);
  assert.equal(writes.length, 0, 'Opening a workspace does not create a chat');
  assert.equal(await page.getByRole('region', { name: 'Chat list', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Model: Claude Sonnet', exact: true }).click();
  for (const name of ['DeepSeek Pro', 'DeepSeek Flash', 'Kimi', 'Kimi Code']) {
    const option = page.getByRole('option', { name: name, exact: true });
    assert.equal(
      await option.locator(name.startsWith('Kimi') ? '[data-brand="kimi"]' : '[data-brand="deepseek"]').count(),
      1,
    );
  }
  await page.getByRole('option', { name: 'Kimi', exact: true }).click();
  await page.getByRole('button', { name: 'Model: Kimi', exact: true }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const send = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
    assert.ok(send && send.y >= 0 && send.y + send.height <= 844);
    if (process.env.CONVERSATION_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/new-chat-mobile-${theme}.png`,
        fullPage: true,
      });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  if (process.env.CONVERSATION_SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/new-chat-desktop.png`, fullPage: true });
  await page.getByRole('link', { name: 'Chats', exact: true }).click();
  assert.equal(page.url(), `${origin}/acme/chat`);
  await page.getByRole('heading', { name: 'Could not load chats' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'No chats yet' }).count(), 0);
  await page.getByRole('button', { name: 'Retry loading chats' }).click();
  await page.getByRole('status', { name: 'Loading chats' }).waitFor();
  await page.getByRole('heading', { name: 'Could not load chats' }).waitFor();
  listStatus = 200;
  delay = 300;
  await page.getByRole('button', { name: 'Retry loading chats' }).click();
  await page.getByRole('status', { name: 'Loading chats' }).waitFor();
  await page.getByRole('heading', { name: 'No chats yet' }).waitFor();
  delay = 0;
  await page.getByRole('link', { name: 'Start a chat', exact: true }).click();
  await page.getByRole('region', { name: 'Chat list', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('region', { name: 'Conversation', exact: true }).getByRole('heading', { level: 2 }).waitFor();
  assert.equal(
    await page.getByRole('complementary', { name: 'Chat history' }).count(),
    0,
    'Chat history sidebar is removed from the DOM',
  );
  assert.equal(await page.getByRole('region', { name: 'Chat list', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Search chats', exact: true }).count(), 0);
  assert.equal(writes.length, 0);
  await page.getByLabel('Message', { exact: true }).fill('  ');
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  assert.equal(await page.getByText('Enter a message.', { exact: true }).count(), 0);
  if (process.env.CONVERSATION_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/whitespace-only-composer.png`,
      fullPage: true,
    });
  await page.getByLabel('Message', { exact: true }).press('Enter');
  assert.equal(writes.length, 0, 'Whitespace-only messages do not create a chat');
  await page.getByLabel('Message', { exact: true }).fill('x'.repeat(65537));
  await page.getByText('Keep this message under 64 KiB of text.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  await page.getByLabel('Message', { exact: true }).fill('Hello 🌱');
  await page.getByRole('link', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await page.getByLabel('Message', { exact: true }).innerText(), 'Hello 🌱');
  dropWrite = true;
  await page.getByRole('button', { name: 'Send message', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Retry same operation' }).waitFor();
  const createRequest = writes[0];
  const chatId = chats[0].id;
  assert.equal(writes.length, 1, 'A double send creates only one chat');
  await page.getByRole('button', { name: 'Retry same operation' }).click();
  await page.waitForURL(`${origin}/acme/chat/${chatId}`);
  await page.getByRole('button', { name: 'Stop reply' }).waitFor();
  assert.deepEqual(writes[1], createRequest, 'A lost create response retries the same chat and command');
  assert.equal(chats.length, 1);
  messages.get(chatId).length = 0;
  await page.reload();
  await page.getByRole('region', { name: 'Conversation', exact: true }).getByRole('heading', { level: 2 }).waitFor();
  await page.getByLabel('Message', { exact: true }).fill('Hello 🌱');
  dropWrite = true;
  await page.getByRole('button', { name: 'Send message', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Retry same operation' }).waitFor();
  assert.equal(await page.getByLabel('Message', { exact: true }).innerText(), 'Hello 🌱');
  assert.equal(await page.getByLabel('Message', { exact: true }).isDisabled(), true);
  const sent = writes.at(-1);
  await page.getByRole('button', { name: 'Retry same operation' }).click();
  await page.getByRole('button', { name: 'Stop reply' }).waitFor();
  assert.deepEqual(writes.at(-1), sent);
  assert.equal(sent.body.model, 'claude-sonnet');
  assert.equal(messages.get(chatId).length, 1);
  await page.getByRole('button', { name: 'Model: Claude Sonnet', exact: true }).click();
  assert.equal(await page.getByRole('option', { name: /Gemini Pro/ }).count(), 0);
  await page.getByRole('option', { name: 'Claude Haiku', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Second');
  await page.getByLabel('Message', { exact: true }).press('Shift+Enter');
  assert.equal(
    await page
      .getByLabel('Message', { exact: true })
      .evaluate(element => element.editor.getText({ blockSeparator: '\n' })),
    'Second\n',
  );
  await page.getByLabel('Message', { exact: true }).fill('Second');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByRole('list', { name: 'Messages', exact: true }).getByText('Second', { exact: true }).waitFor();
  assert.equal(writes.at(-1).body.model, 'claude-haiku');
  const uploaded = new Map();
  let failUpload = true;
  await page.route('**/uploads/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const id = path.split('/uploads/')[1].split('/')[0];
    if (path.endsWith('/content')) {
      if (failUpload) {
        failUpload = false;
        await route.fulfill({ status: 503, json: { error: 'upload-failed' } });
        return;
      }
      uploaded.get(id).state = 'ready';
    } else if (route.request().method() === 'PUT' && !uploaded.has(id)) {
      uploaded.set(id, {
        id,
        ...route.request().postDataJSON(),
        state: 'reserved',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    await route.fulfill({ json: uploaded.get(id) });
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add a file', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Store a private file/ }).click();
  await (await chooser).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Customer notes') });
  await page.getByRole('button', { name: 'Retry notes.txt' }).waitFor();
  await page.getByLabel('Message', { exact: true }).fill('Keep this upload draft');
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Retry notes.txt' }).click();
  await page.getByText('notes.txt: Ready to send · Storage only, not read by this chat', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Message', { exact: true }).innerText(), 'Keep this upload draft');
  await page.getByRole('button', { name: 'Remove notes.txt' }).click();
  // Editor keys keep ProseMirror's state in step; a DOM fill('') can empty the text while the draft stays dirty.
  await page.getByLabel('Message', { exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => document.querySelector('button[aria-label="Send message"]')?.disabled ?? true);
  const history = messages.get(chatId);
  history[0].tools = [{ id: randomUUID(), tool: 'tables.list', status: 'running' }];
  await notifyChange(page, workspace.id, userId, 'detail', chatId);
  // Transcript activity stays collapsed until opened (cloud 856d6a73, #1026).
  const toolActivity = page.locator('[data-slot="tool-activity"]').first();
  const openToolActivity = async () => {
    if (!(await page.getByRole('list', { name: 'Tool activity' }).isVisible()))
      await toolActivity.locator('.sprout-tool-activity-trigger').click();
  };
  await page.getByRole('button', { name: 'Working… Listing business tables', exact: true }).click();
  await page
    .getByRole('list', { name: 'Tool activity' })
    .getByText('Listing business tables', { exact: true })
    .waitFor();
  assert.match(await page.getByRole('list', { name: 'Tool activity' }).textContent(), /In progress/);
  history[0].tools[0].status = 'completed';
  history[0].tools.push(
    { id: randomUUID(), tool: 'rows.update', status: 'blocked' },
    { id: randomUUID(), tool: 'web.fetch', status: 'failed' },
  );
  await notifyChange(page, workspace.id, userId, 'detail', chatId);
  await page.getByText('Access denied. Ask an administrator to review your permissions.', { exact: false }).waitFor();
  await openToolActivity();
  assert.match(await page.getByRole('list', { name: 'Tool activity' }).textContent(), /Completed/);
  // Cloud baac8cab (#1001) labels a failed page read by its outcome (tool-labels.tsx:50).
  await page.getByRole('list', { name: 'Tool activity' }).getByText('Page read failed', { exact: true }).waitFor();
  await page
    .getByRole('list', { name: 'Tool activity' })
    .getByText('Public web retrieval failed. Retry or paste the text.', { exact: true })
    .waitFor();
  history[0].turn.status = 'completed';
  history.push({
    id: randomUUID(),
    sequence: 3,
    author: 'assistant',
    createdAt: new Date().toISOString(),
    parts: [
      { kind: 'text', text: '🌱 olleH' },
      { kind: 'text', text: 'Part two' },
    ],
    turn: null,
  });
  await page.getByText('🌱 olleH', { exact: true }).waitFor();
  const messageList = page.getByRole('list', { name: 'Messages', exact: true });
  assert.deepEqual(await messageList.locator('[data-slot="message-bubble"]').allTextContents(), [
    'Hello 🌱',
    'Second',
    '🌱 olleH',
    'Part two',
  ]);
  assert.equal(await messageList.locator('[data-slot="message-header"]').count(), 0);
  assert.equal(await messageList.getByText('TulipFarm said', { exact: true }).count(), 1);
  await page.reload();
  await page.getByText('🌱 olleH', { exact: true }).waitFor();
  history[1].turn.status = 'failed';
  await notifyChange(page, workspace.id, userId, 'detail', chatId);
  await page.getByRole('button', { name: 'Retry reply' }).click();
  await page.getByRole('button', { name: 'Stop reply' }).waitFor();
  assert.equal(writes.at(-1).body.expectedGeneration, 0);
  await page.getByRole('button', { name: 'Stop reply' }).click();
  await page.getByText('Reply cancelled', { exact: true }).waitFor();
  assert.equal(writes.at(-1).body.expectedGeneration, 1);
  await chatAction('Edit title');
  await page.getByLabel('Chat title', { exact: true }).fill('Saved conversation');
  await page.getByRole('button', { name: 'Save title' }).click();
  await page.getByRole('heading', { name: 'Saved conversation', exact: true }).waitFor();
  const chatHeader = page.locator('header[aria-label="Workspace header"]');
  assert.equal(await chatHeader.getByRole('heading', { name: 'Saved conversation', exact: true }).count(), 1);
  assert.equal(await chatHeader.evaluate(element => element.getBoundingClientRect().height), 44);
  assert.equal(await page.locator('main header').count(), 1, 'The chat title and navigation share a single top bar');
  await chatAction('Archive chat');
  await page.getByText('This chat is archived.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
  await page.getByRole('heading', { name: 'Chats', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Archived chats', exact: true }).click();
  await page.getByRole('button', { name: 'Saved conversation', exact: true }).click();
  await chatAction('Restore chat');
  await page.getByText('This chat is archived.', { exact: false }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
  await page.getByRole('button', { name: 'Archived chats', exact: true }).click();
  await page.getByRole('heading', { name: 'No archived chats', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Active chats', exact: true }).click();
  await page.getByLabel('Search chat titles').fill('absent');
  await page.getByLabel('Search chat titles').press('Enter');
  await page.getByRole('heading', { name: 'No matching chats' }).waitFor();
  await page.getByRole('button', { name: 'Clear search' }).first().click();
  await page.getByRole('button', { name: 'Saved conversation', exact: true }).waitFor();
  listStatus = 503;
  await notifyChange(page, workspace.id, userId, 'list');
  await page.getByRole('button', { name: 'Retry refresh', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Saved conversation', exact: true }).isVisible(), true);
  listStatus = 200;
  await page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Retry refresh', exact: true }).waitFor({ state: 'detached' });
  for (let index = 0; index < 51; index++) {
    const id = randomUUID();
    chats.push({ ...chats[0], id, title: `Older chat ${index}` });
    messages.set(id, []);
  }
  await notifyChange(page, workspace.id, userId, 'list');
  await page.getByRole('button', { name: 'Load more chats' }).click();
  await page.getByRole('button', { name: 'Older chat 50', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Saved conversation', exact: true }).click();
  assert.equal(await page.getByRole('complementary', { name: 'Chat history' }).count(), 0);
  for (let index = 4; index <= 54; index++)
    history.push({
      id: randomUUID(),
      sequence: index,
      author: 'assistant',
      createdAt: new Date().toISOString(),
      parts: [{ kind: 'text', text: `Older page test ${index}` }],
      turn: null,
    });
  await notifyChange(page, workspace.id, userId, 'detail', chatId);
  await page.getByRole('button', { name: 'Load older messages' }).click();
  await page.getByText('🌱 olleH', { exact: true }).waitFor();
  assert.equal(await page.getByRole('list', { name: 'Messages', exact: true }).locator(':scope > li').count(), 54);
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
  await conversation.evaluate(element => {
    element.scrollTop = 0;
  });
  await page.getByRole('button', { name: 'Jump to latest' }).waitFor();
  history.push({
    id: randomUUID(),
    sequence: 55,
    author: 'assistant',
    createdAt: new Date().toISOString(),
    parts: [{ kind: 'text', text: 'A new reply while reading history.' }],
    turn: null,
  });
  await notifyChange(page, workspace.id, userId, 'detail', chatId);
  await page.getByText('A new reply while reading history.', { exact: true }).waitFor();
  assert.equal(await conversation.evaluate(element => element.scrollTop), 0);
  await page.getByRole('button', { name: 'Jump to latest' }).click();
  assert.equal(
    await conversation.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 2),
    true,
  );
  history.splice(3);
  await notifyChange(page, workspace.id, userId, 'detail', chatId);
  await page.getByText('Older page test 54', { exact: true }).waitFor({ state: 'detached' });
  await page.getByLabel('Message', { exact: true }).fill('Retain my draft');
  historyStatus = 503;
  await notifyChange(page, workspace.id, userId, 'detail', chatId);
  await page.getByRole('button', { name: 'Retry refresh' }).waitFor();
  assert.equal(await page.getByLabel('Message', { exact: true }).innerText(), 'Retain my draft');
  assert.equal(await page.getByText('🌱 olleH', { exact: true }).count(), 1);
  historyStatus = 200;
  await page.getByRole('button', { name: 'Retry refresh' }).click();
  writeStatus = 409;
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh before editing' }).click();
  await page.getByRole('button', { name: 'Review retained input' }).click();
  assert.equal(await page.getByLabel('Message', { exact: true }).innerText(), 'Retain my draft');
  writeStatus = 200;
  // Editor keys keep ProseMirror's state in step; a DOM fill('') can empty the text while the draft stays dirty.
  await page.getByLabel('Message', { exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => document.querySelector('button[aria-label="Send message"]')?.disabled ?? true);
  await chatAction('Edit title');
  await page.getByLabel('Chat title', { exact: true }).fill('Retained title');
  chats[0].titleRevision++;
  await page.getByRole('button', { name: 'Save title' }).click();
  await page.getByRole('button', { name: 'Refresh before editing' }).click();
  await page.getByRole('button', { name: 'Review retained input' }).click();
  assert.equal(await page.getByLabel('Chat title', { exact: true }).inputValue(), 'Retained title');
  await page.getByRole('button', { name: 'Save title' }).click();
  await page.getByRole('heading', { name: 'Retained title', exact: true }).waitFor();
  assert.equal(writes.at(-1).body.expectedRevision, 4);
  await chatAction('Edit title');
  await page.getByLabel('Chat title', { exact: true }).fill('Long title '.repeat(8));
  assert.equal(await page.getByRole('button', { name: 'Save title' }).isDisabled(), true);
  await page.getByLabel('Chat title', { exact: true }).fill('Long title '.repeat(4));
  await page.getByRole('button', { name: 'Save title' }).click();
  await page.getByRole('heading', { name: 'Long title '.repeat(4).trim(), exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.waitForFunction(() => {
    const button = document.querySelector('[aria-label="Send message"]');
    const box = button?.getBoundingClientRect();
    return box && box.y >= 0 && box.bottom <= innerHeight;
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const sendBox = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  assert.ok(sendBox && sendBox.y >= 0 && sendBox.y + sendBox.height <= 844, JSON.stringify(sendBox));
  assert.equal(await page.getByRole('complementary', { name: 'Chat history' }).count(), 0);
  await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
  await page.getByRole('region', { name: 'Chat list', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Conversation', exact: true }).count(), 0);
  assert.equal(
    await page
      .getByRole('region', { name: 'Chat list', exact: true })
      .evaluate(element => element.scrollWidth <= element.clientWidth),
    true,
  );
  await page.getByLabel('Search chat titles').waitFor();
  if (process.env.CONVERSATION_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/chat-list-mobile-dark.png`,
      fullPage: true,
    });
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    if (process.env.CONVERSATION_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/chat-list-desktop-${theme}.png`,
        fullPage: true,
      });
  }
  const row = page.getByRole('button', { name: 'Long title '.repeat(4).trim(), exact: true });
  assert.equal(
    await row.evaluate(
      element => element.getBoundingClientRect().width === element.parentElement.getBoundingClientRect().width,
    ),
    true,
    'Chat rows fill their reading column',
  );
  // The activity time sits beside the title button and shows the day then the time (cloud 1f8cf59a #1028, pages/workspace-chats.tsx:135-138).
  assert.equal(await page.getByRole('row').filter({ has: row }).locator('time > span').first().textContent(), 'Today');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Long title '.repeat(4).trim(), exact: true }).click();
  await page.goBack();
  await page.getByRole('heading', { name: 'Chats', exact: true }).waitFor();
  await page.goForward();
  await page.getByRole('heading', { name: 'Long title '.repeat(4).trim(), exact: true }).waitFor();
  await page.getByLabel('Message', { exact: true }).waitFor();
  await page.getByLabel('Message', { exact: true }).fill('A long draft\n'.repeat(30));
  const draftSendBox = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
  assert.ok(draftSendBox && draftSendBox.y + draftSendBox.height <= 844);
  // Editor keys keep ProseMirror's state in step; a DOM fill('') can empty the text while the draft stays dirty.
  await page.getByLabel('Message', { exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => document.querySelector('button[aria-label="Send message"]')?.disabled ?? true);
  if (process.env.CONVERSATION_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/private-chat-mobile-dark.png`,
      fullPage: true,
    });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  if (process.env.CONVERSATION_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/private-chat-desktop-light.png`,
      fullPage: true,
    });
  const originalTitle = chats[0].title;
  chats[0].title = 'Planning customer follow-ups';
  history.push({
    id: randomUUID(),
    sequence: 4,
    author: 'human',
    createdAt: new Date().toISOString(),
    parts: [
      {
        kind: 'text',
        text: 'Help me plan a thoughtful follow-up process for our customers. What should we track, and how should the team review it?',
      },
    ],
    turn: null,
  });
  history.push({
    id: randomUUID(),
    sequence: 5,
    author: 'assistant',
    createdAt: new Date().toISOString(),
    parts: [
      {
        kind: 'text',
        text: '## A follow-up process your team can use\n\nStart with a small customer row and a clear next action. That gives everyone enough context to pick up the conversation.\n\n### Keep the essentials together\n\n| Track | Why it matters |\n| --- | --- |\n| Customer and owner | Make responsibility clear |\n| Last conversation | Keep the next message relevant |\n| Next action and due date | Know what needs attention |\n\n### Review before reaching out\n\n1. Check the latest conversation and any open questions.\n2. Draft a short message with a specific next step.\n3. Let the owner review the draft before sending.\n\nA useful first step is to agree on what **needs a follow-up** means for your team. Is it an unanswered proposal, a quiet account, or an upcoming renewal?',
      },
    ],
    turn: null,
  });
  await notifyChange(page, workspace.id, userId, 'detail', chatId);
  await page.getByRole('heading', { name: 'A follow-up process your team can use' }).waitFor();
  assert.equal(await page.getByRole('table').count(), 1);
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    if (process.env.CONVERSATION_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/chat-redesign-desktop-${theme}.png`,
        fullPage: true,
      });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
  );
  if (process.env.CONVERSATION_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/chat-redesign-mobile-dark.png`,
      fullPage: true,
    });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
    ),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  history.splice(3);
  chats[0].title = originalTitle;
  history[1].turn.status = 'queued';
  await notifyChange(page, workspace.id, userId, 'detail', chatId);
  await page.getByRole('button', { name: 'Stop reply' }).waitFor();
  const later = await browser.newPage();
  await later.clock.install();
  await later.route('**/v1/**', api);
  let laterReads = 0;
  later.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith(`/conversations/${chatId}/messages`))
      laterReads++;
  });
  await later.goto(`${origin}/acme/chat/${chatId}`);
  await later.getByRole('button', { name: 'Stop reply' }).waitFor();
  const advance = async ms => {
    for (let elapsed = 0; elapsed < ms; elapsed += 500) {
      await later.clock.fastForward(500);
      await setTimeout(20);
    }
  };
  await advance(115_000);
  const readsBeforeTwoMinutes = laterReads;
  await advance(10_000);
  assert.ok(laterReads > readsBeforeTwoMinutes, 'the chat still checks a pending reply after two minutes');
  history[1].turn.status = 'completed';
  history.push({
    id: randomUUID(),
    sequence: 4,
    author: 'assistant',
    createdAt: new Date().toISOString(),
    parts: [{ kind: 'text', text: 'Finished after two minutes.' }],
    turn: null,
  });
  await advance(6000);
  await later.getByText('Finished after two minutes.', { exact: true }).waitFor();
  assert.equal(await later.getByText('Automatic checks stopped', { exact: false }).count(), 0);
  assert.equal(await later.getByRole('button', { name: 'Check chat status' }).count(), 0);
  await later.getByRole('button', { name: 'Chat actions' }).click();
  await later.getByRole('menuitem', { name: 'Edit title', exact: true }).waitFor();
  assert.equal(await later.getByRole('menuitem', { name: 'Check chat status' }).count(), 0);
  if (process.env.CONVERSATION_SCREENSHOT_DIR)
    await later.screenshot({
      path: `${process.env.CONVERSATION_SCREENSHOT_DIR}/long-reply-without-check.png`,
      fullPage: true,
    });
  await later.close();
  history.pop();
  history[1].turn.status = 'queued';
  await notifyChange(page, workspace.id, userId, 'detail', chatId);
  await page.getByRole('button', { name: 'Stop reply' }).waitFor();
  historyStatus = 404;
  await page.getByRole('heading', { name: 'Personal chats unavailable' }).waitFor();
  assert.equal(await page.getByText('🌱 olleH', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Message', { exact: true }).count(), 0);
  const stoppedAt = historyRequests;
  await setTimeout(2200);
  assert.equal(historyRequests, stoppedAt);
  historyStatus = 200;
  await page.goto(`${origin}/other`);
  await page.getByRole('region', { name: 'Conversation', exact: true }).getByRole('heading', { level: 2 }).waitFor();
  assert.equal(await page.getByText('Saved conversation', { exact: true }).count(), 0);
  userId = 'grace';
  await page.goto(`${origin}/acme`);
  await page.getByRole('region', { name: 'Conversation', exact: true }).getByRole('heading', { level: 2 }).waitFor();
  assert.equal(await page.getByText('🌱 olleH', { exact: true }).count(), 0);
  userId = 'ada';
  await page.goto(`${origin}/acme`);
  await page.getByRole('region', { name: 'Conversation', exact: true }).getByRole('heading', { level: 2 }).waitFor();
  const beforeAttachment = chats.length;
  const draftChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add a file', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Store a private file/ }).click();
  await (
    await draftChooser
  ).setFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Draft attachment') });
  await page.getByText('draft.txt: Ready to send · Storage only, not read by this chat', { exact: true }).waitFor();
  assert.equal(chats.length, beforeAttachment + 1);
  const attachmentChatId = chats[0].id;
  assert.equal(page.url(), `${origin}/acme`);
  await page.getByLabel('Message', { exact: true }).fill('An attachment-first chat');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForURL(`${origin}/acme/chat/${attachmentChatId}`);
  assert.equal(chats.length, beforeAttachment + 1, 'Sending reuses the chat created for the attachment');
  assert.equal(writes.at(-1).body.parts[1].kind, 'attachment');
  // Leaving while the send is still in flight asks first (cloud private-conversations.tsx:377); an enabled Stop reply means it was accepted.
  await page.getByRole('button', { name: 'Stop reply', exact: true, disabled: false }).waitFor();
  await page.getByRole('link', { name: 'New chat', exact: true }).click();
  await page.getByRole('region', { name: 'Conversation', exact: true }).getByRole('heading', { level: 2 }).waitFor();
  assert.equal(await page.getByLabel('Message', { exact: true }).textContent(), '');
  assert.equal(chats.length, beforeAttachment + 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS private conversation browser recovery, ordered parts, queued sends, controls, archive, search, themes, access concealment and workspace isolation',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
