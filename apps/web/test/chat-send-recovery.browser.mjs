import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits, notifyChange } from './chat-query.fixture.mjs';
import { conversationPages } from '../../api/src/conversation-pages.ts';

test('chat sends reconcile transport failures and recover without reloading', { timeout: 240000 }, async t => {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser;
  let agentConnected = false;
  try {
    await server.listen();
    const cdpPort = process.env.CHAT_SEND_CDP_PORT;
    browser = await chromium.launch({
      headless: true,
      ...(cdpPort ? { args: [`--remote-debugging-port=${cdpPort}`] } : {}),
    });
    const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
    async function scenario(name, run) {
      if (process.env.CHAT_SEND_SCENARIO && !name.includes(process.env.CHAT_SEND_SCENARIO)) return;
      await t.test(name, async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(60000);
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        const workspace = {
          id: randomUUID(),
          slug: 'acme',
          name: 'Acme',
          status: 'ready',
          createdAt: '2026-10-09T00:00:00Z',
          soulCommit: 'a'.repeat(40),
        };
        const chat = {
          id: randomUUID(),
          title: 'Follow-up messages',
          titleRevision: 1,
          archived: false,
          activityAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        const history = [];
        const state = {
          outcome: 'success',
          historyStatus: 200,
          writes: [],
          reads: [],
          receipts: new Map(),
          // Chats created from a new-chat draft, by id, and the writes sent to them.
          created: new Map(),
          newChatWrites: [],
          dropCreate: false,
          accessReads: null,
        };
        const add = (author, text, id = randomUUID()) => {
          const message = {
            id,
            sequence: history.length + 1,
            author,
            createdAt: new Date().toISOString(),
            parts: [{ kind: 'text', text }],
            turn: author === 'human' ? { id: randomUUID(), generation: 0, status: 'completed' } : null,
          };
          history.push(message);
          return message;
        };
        add('human', 'Say hello');
        add('assistant', 'Hello');
        const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' };
        const historyPage = before => {
          state.reads.push(before ?? Infinity);
          const older = history.filter(message => message.sequence < (before ?? Infinity));
          return {
            messages: older.slice(-50),
            nextBefore: older.length > 50 ? older.at(-50).sequence : null,
            hasGitHubProposals: false,
          };
        };
        await page.route('**/v1/**', async route => {
          const request = route.request();
          const url = new URL(request.url());
          const path = url.pathname;
          let json;
          let status = 200;
          const other = path.match(/\/conversations\/([0-9a-f-]{36})(\/.*)?$/);
          const newChat = other && other[1] !== chat.id ? { id: other[1], suffix: other[2] ?? '' } : null;
          if ((path === '/v1/workspaces' || path.endsWith('/governance/me')) && state.accessReads)
            await state.accessReads;
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
          else if (path.endsWith('/system-package-installations')) json = { installations: [], nextCursor: null };
          else if (path.endsWith('/slack/status'))
            json = { state: 'active', teamId: 'T_TEST', canManage: false, linked: true, scopes: [] };
          else if (path.endsWith('/events')) status = 503;
          else if (newChat && request.method() === 'PUT' && newChat.suffix === '') {
            state.newChatWrites.push({ kind: 'create', id: newChat.id });
            if (state.dropCreate) {
              state.dropCreate = false;
              return route.abort('failed');
            }
            if (!state.created.has(newChat.id)) state.created.set(newChat.id, []);
            json = { id: newChat.id };
          } else if (newChat && request.method() === 'PUT' && newChat.suffix.startsWith('/messages/')) {
            const body = request.postDataJSON();
            const messages = state.created.get(newChat.id);
            const id = newChat.suffix.split('/').at(-1);
            state.newChatWrites.push({ kind: 'send', id, chatId: newChat.id });
            if (!messages) status = 404;
            else {
              const turn = { id: randomUUID(), generation: 0, status: 'completed' };
              const at = new Date().toISOString();
              const text = body.parts.find(part => part.kind === 'text').text;
              messages.push({ id, sequence: 1, author: 'human', createdAt: at, parts: [{ kind: 'text', text }], turn });
              messages.push({
                id: randomUUID(),
                sequence: 2,
                author: 'assistant',
                createdAt: at,
                parts: [{ kind: 'text', text: 'Reply in the new chat' }],
                turn: null,
              });
              json = { messageId: id, turnId: turn.id, sequence: 1 };
            }
          } else if (newChat && request.method() === 'GET') {
            const messages = state.created.get(newChat.id);
            if (!messages) status = 404;
            else if (newChat.suffix === '/messages') json = { messages, nextBefore: null, hasGitHubProposals: false };
            else json = { ...chat, id: newChat.id, title: 'New chat' };
          } else if (request.method() === 'GET' && path.endsWith(`/conversations/${chat.id}/messages`)) {
            const before = Number(url.searchParams.get('before') ?? Infinity);
            status = state.historyStatus;
            json = historyPage(before);
          } else if (request.method() === 'POST' && path.endsWith(`/conversations/${chat.id}/messages/pages`)) {
            const body = request.postDataJSON();
            status = state.historyStatus;
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
          } else if (request.method() === 'PUT' && path.includes(`/conversations/${chat.id}/messages/`)) {
            const body = request.postDataJSON();
            const id = path.split('/').at(-1);
            state.writes.push({ id, body });
            if (state.outcome === 'conflict') {
              status = 409;
              json = { error: 'command-conflict' };
            } else {
              json = state.receipts.get(body.commandId);
              if (!json && state.outcome !== 'drop-before-save') {
                const message = add('human', body.parts.find(part => part.kind === 'text').text, id);
                add('assistant', `Reply ${state.receipts.size + 1}`);
                json = { messageId: id, turnId: message.turn.id, sequence: message.sequence };
                state.receipts.set(body.commandId, json);
              }
              if (state.outcome.startsWith('drop')) return route.abort('failed');
              if (state.outcome === 'conflict-after-save') {
                status = 409;
                json = { error: 'identity-conflict' };
              }
            }
          } else if (request.method() === 'GET' && path.endsWith(`/conversations/${chat.id}`)) json = chat;
          else if (request.method() === 'GET' && path.endsWith('/conversations'))
            json = { chats: [chat], nextCursor: null };
          else status = 404;
          // The page may have cancelled a held read while it waited.
          await route
            .fulfill({
              status,
              json: status === 200 || status === 409 ? json : { error: 'unavailable' },
              headers: cors,
            })
            .catch(() => {});
        });
        try {
          await page.goto(`${origin}/acme/chat/${chat.id}`);
          const composer = page.getByLabel('Message', { exact: true });
          const send = page.getByRole('button', { name: 'Send message', exact: true });
          const transcript = page.getByRole('list', { name: 'Messages', exact: true });
          await composer.waitFor();
          await page.getByText('Hello', { exact: true }).waitFor({ timeout: 60000 });
          await run({ page, state, history, add, composer, send, transcript, workspace, chat });
          assert.deepEqual(errors, []);
        } catch (error) {
          console.error(error, errors, await page.locator('body').innerText());
          if (process.env.CHAT_SEND_SCREENSHOTS) {
            await mkdir(process.env.CHAT_SEND_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: `${process.env.CHAT_SEND_SCREENSHOTS}/failure.png`, fullPage: true });
          }
          throw error;
        } finally {
          await page.close();
        }
      });
    }

    await scenario(
      'a send conflict has no approval copy and refresh restores the retained draft',
      async ({ page, state, composer, send }) => {
        state.outcome = 'conflict';
        await composer.fill('Keep this follow-up');
        await send.click();
        await page.getByRole('button', { name: 'Refresh before editing', exact: true }).waitFor();
        if (process.env.CHAT_SEND_SCREENSHOTS) {
          await mkdir(process.env.CHAT_SEND_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: `${process.env.CHAT_SEND_SCREENSHOTS}/send-conflict.png`, fullPage: true });
        }
        assert.equal(await page.getByText('This request or proposal changed.', { exact: false }).count(), 0);
        await page.getByRole('button', { name: 'Refresh before editing', exact: true }).click();
        await page.waitForFunction(
          () => document.querySelector('[aria-label="Message"]').getAttribute('aria-disabled') !== 'true',
        );
        assert.equal(await composer.innerText(), 'Keep this follow-up');
        assert.equal(await send.isEnabled(), true);
        if (process.env.CHAT_SEND_SCREENSHOTS) {
          const path = `${process.env.CHAT_SEND_SCREENSHOTS}/composer-restored.png`;
          await page.screenshot({ path, fullPage: true });
          if (cdpPort) {
            agentConnected = true;
            execFileSync('pnpm', [
              'dlx',
              'agent-browser',
              '--session',
              'chat-send-recovery',
              '--cdp',
              cdpPort,
              'snapshot',
              '-i',
            ]);
            execFileSync('pnpm', [
              'dlx',
              'agent-browser',
              '--session',
              'chat-send-recovery',
              '--cdp',
              cdpPort,
              'screenshot',
              path,
            ]);
          }
        }
        state.outcome = 'success';
        await send.click();
        await page.getByText('Reply 1', { exact: true }).waitFor();
        assert.equal(state.writes.length, 2);
      },
    );

    await scenario(
      'a lost success response is confirmed from history without sending twice',
      async ({ page, state, composer, send }) => {
        state.outcome = 'drop-after-save';
        await composer.fill('Accepted follow-up');
        await send.click();
        await page.getByText('Reply 1', { exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('[aria-label="Message"]').innerText.trim() === '');
        assert.equal(state.writes.length, 1);
        assert.equal(await send.isDisabled(), true);
        assert.equal(await page.getByText('Accepted follow-up', { exact: true }).count(), 1);
        assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
      },
    );

    await scenario(
      'a conflicting send already present in history is confirmed instead of rejected',
      async ({ page, state, composer, send }) => {
        state.outcome = 'conflict-after-save';
        await composer.fill('Saved before conflict');
        await send.click();
        await page.getByText('Reply 1', { exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('[aria-label="Message"]').innerText.trim() === '');
        assert.equal(await page.getByRole('button', { name: 'Refresh before editing', exact: true }).count(), 0);
        assert.equal(state.writes.length, 1);
      },
    );

    await scenario(
      'unavailable history keeps an unconfirmed bubble and a status check recovers it',
      async ({ page, state, composer, send }) => {
        state.outcome = 'drop-after-save';
        state.historyStatus = 409;
        await composer.fill('Do not lose this message');
        await send.click();
        await page.getByRole('button', { name: 'Check message status', exact: true }).waitFor();
        assert.equal(await page.getByText('Do not lose this message', { exact: true }).count(), 2);
        assert.equal(await composer.innerText(), 'Do not lose this message');
        await page.getByText('Not confirmed sent', { exact: true }).waitFor();
        assert.equal(await page.getByText('This request or proposal changed.', { exact: false }).count(), 0);
        if (process.env.CHAT_SEND_SCREENSHOTS)
          await page.screenshot({ path: `${process.env.CHAT_SEND_SCREENSHOTS}/send-unconfirmed.png`, fullPage: true });
        state.historyStatus = 200;
        await page.getByRole('button', { name: 'Check message status', exact: true }).click();
        await page.getByText('Reply 1', { exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('[aria-label="Message"]').innerText.trim() === '');
        assert.equal(await page.getByText('Do not lose this message', { exact: true }).count(), 1);
        assert.equal(state.writes.length, 1);
        if (process.env.CHAT_SEND_SCREENSHOTS)
          await page.screenshot({ path: `${process.env.CHAT_SEND_SCREENSHOTS}/send-recovered.png`, fullPage: true });
      },
    );

    await scenario(
      'a missing uncertain send reuses the exact command and message on recovery',
      async ({ page, state, composer, send }) => {
        state.outcome = 'drop-before-save';
        await composer.fill('Retry this exact send');
        await send.click();
        await page.getByRole('button', { name: 'Check message status', exact: true }).waitFor();
        state.outcome = 'success';
        await page.getByRole('button', { name: 'Check message status', exact: true }).click();
        await page.getByText('Reply 1', { exact: true }).waitFor();
        assert.equal(state.writes.length, 2);
        assert.deepEqual(state.writes[0], state.writes[1]);
      },
    );

    await scenario(
      'history arriving after the first status check clears the notice without resending',
      async ({ page, state, composer, send, add, workspace, chat }) => {
        state.outcome = 'drop-before-save';
        await composer.fill('Accepted a little later');
        await send.click();
        await page.getByRole('button', { name: 'Check message status', exact: true }).waitFor();
        add('human', 'Accepted a little later', state.writes[0].id);
        add('assistant', 'A delayed reply');
        await notifyChange(page, workspace.id, 'ada', 'history', chat.id);
        await page.getByText('A delayed reply', { exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('[aria-label="Message"]').innerText.trim() === '');
        assert.equal(await page.getByRole('button', { name: 'Check message status', exact: true }).count(), 0);
        assert.equal(state.writes.length, 1);
      },
    );

    await scenario(
      'an offline draft stays visible and reconnect sends the same message only once',
      async ({ page, state, composer, send }) => {
        await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
        await composer.fill('Send when back online');
        await send.click();
        await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
        assert.equal(await composer.innerText(), 'Send when back online');
        assert.equal(state.writes.length, 0);
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
          window.dispatchEvent(new Event('online'));
        });
        await page.getByText('Reply 1', { exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('[aria-label="Message"]').innerText.trim() === '');
        assert.equal(state.writes.length, 1);
      },
    );

    await scenario(
      'reconciliation follows older history pages and preserves send order',
      async ({ page, state, composer, send, add }) => {
        state.outcome = 'drop-after-save';
        state.historyStatus = 409;
        await composer.fill('Find this saved message');
        await send.click();
        await page.getByRole('button', { name: 'Check message status', exact: true }).waitFor();
        for (let index = 0; index < 60; index++) add('assistant', `Later reply ${index}`);
        state.historyStatus = 200;
        state.reads.length = 0;
        await page.getByRole('button', { name: 'Check message status', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[aria-label="Message"]').innerText.trim() === '');
        assert.ok(
          state.reads.some(before => before !== Infinity),
          'older pages must be checked before declaring a send missing',
        );
        assert.equal(state.writes.length, 1);
        await page.getByText('Later reply 0', { exact: true }).waitFor();
        await page.getByText('Find this saved message', { exact: true }).waitFor();
        const shown = await page.getByRole('list', { name: 'Messages', exact: true }).innerText();
        assert.ok(shown.indexOf('Find this saved message') < shown.indexOf('Later reply 0'));
      },
    );

    await scenario(
      'a status check reads at most two pages even when a long history continues',
      async ({ page, state, add, workspace, chat }) => {
        for (let index = 0; index < 160; index++) add('assistant', `Older history ${index}`);
        state.reads.length = 0;
        const found = await page.evaluate(
          async ({ workspaceId, chatId, messageId }) => {
            const { conversationApi } = await import('/src/features/chat/conversation-api.ts');
            return conversationApi(workspaceId, () => {}).findMessage(chatId, messageId, AbortSignal.timeout(15000));
          },
          { workspaceId: workspace.id, chatId: chat.id, messageId: randomUUID() },
        );
        assert.equal(found, null);
        assert.deepEqual(state.reads, [Infinity, 113]);
        assert.equal(state.writes.length, 0);
      },
    );

    await scenario(
      "a new chat's first message is sent after a newer page load cancels the previous access check",
      async ({ page, state, composer, send }) => {
        let release;
        state.accessReads = new Promise(resolve => (release = resolve));
        await page.getByRole('link', { name: 'New chat', exact: true }).click();
        await page.waitForURL(url => url.pathname === '/acme');
        await composer.fill('First message in a new chat');
        await send.click();
        // Sending moves the draft to its chat page, a newer load that cancels the reads the new-chat page started.
        await page.waitForURL(url => /^\/acme\/chat\/[0-9a-f-]{36}$/.test(url.pathname));
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.deepEqual(state.newChatWrites, [], 'Writes wait for the access check');
        state.accessReads = null;
        release();
        await page.getByText('Reply in the new chat', { exact: true }).waitFor();
        assert.deepEqual(
          state.newChatWrites.map(write => write.kind),
          ['create', 'send'],
        );
        assert.equal(await page.getByText('Could not confirm your workspace access', { exact: false }).count(), 0);
      },
    );

    await scenario(
      'a new chat that was never created shows its first message as not sent, and trying again sends it once',
      async ({ page, state, composer, send }) => {
        await page.getByRole('link', { name: 'New chat', exact: true }).click();
        await page.waitForURL(url => url.pathname === '/acme');
        state.dropCreate = true;
        await composer.fill('Send this when the chat exists');
        await send.click();
        await page.getByText("Your message hasn't been sent. Try again.", { exact: true }).waitFor();
        await page.getByText('Not sent', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Check message status', exact: true }).count(), 0);
        assert.equal(await page.getByText("We couldn't confirm your message was sent", { exact: false }).count(), 0);
        assert.deepEqual(
          state.newChatWrites.map(write => write.kind),
          ['create'],
        );
        await page.getByRole('button', { name: 'Try again', exact: true }).click();
        await page.getByText('Reply in the new chat', { exact: true }).waitFor();
        assert.deepEqual(
          state.newChatWrites.map(write => write.kind),
          ['create', 'create', 'send'],
        );
      },
    );

    await scenario(
      'twenty sends immediately after a completed reply stay visible in stored order',
      async ({ page, state, composer, send, history }) => {
        for (let index = 0; index < 20; index++) {
          await composer.fill(`Follow-up ${index}`);
          await page.evaluate(text => {
            window.sendVisibleMs = null;
            let started;
            const observer = new MutationObserver(() => {
              if (!document.querySelector('ol[aria-label="Messages"]')?.innerText.includes(text)) return;
              window.sendVisibleMs = performance.now() - started;
              observer.disconnect();
            });
            document.querySelector('[aria-label="Send message"]').addEventListener(
              'click',
              () => {
                started = performance.now();
                observer.observe(document.querySelector('ol[aria-label="Messages"]'), {
                  subtree: true,
                  childList: true,
                });
              },
              { once: true },
            );
          }, `Follow-up ${index}`);
          await send.click();
          await page.getByText(`Follow-up ${index}`, { exact: true }).waitFor();
          const visibleMs = await page.evaluate(() => window.sendVisibleMs);
          assert.ok(
            visibleMs !== null && visibleMs < 1000,
            `the sent message must appear within one second (${visibleMs}ms)`,
          );
          await page.getByText(`Reply ${index + 1}`, { exact: true }).waitFor();
          await page.waitForFunction(() => document.querySelector('[aria-label="Message"]').innerText.trim() === '');
        }
        assert.equal(state.writes.length, 20);
        assert.deepEqual(
          history
            .filter(message => message.author === 'human')
            .slice(1)
            .map(message => message.parts[0].text),
          Array.from({ length: 20 }, (_, index) => `Follow-up ${index}`),
        );
        assert.equal(await page.getByText('This request or proposal changed.', { exact: false }).count(), 0);
      },
    );
  } finally {
    try {
      if (agentConnected) execFileSync('pnpm', ['dlx', 'agent-browser', '--session', 'chat-send-recovery', 'close']);
    } finally {
      await browser?.close();
      await server.close();
    }
  }
});
