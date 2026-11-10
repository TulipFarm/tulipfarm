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
        const state = { outcome: 'success', historyStatus: 200, writes: [], reads: [], receipts: new Map() };
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
          else if (path.endsWith(`/conversations/${chat.id}/events`)) status = 503;
          else if (request.method() === 'GET' && path.endsWith(`/conversations/${chat.id}/messages`)) {
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
          await route.fulfill({
            status,
            json: status === 200 || status === 409 ? json : { error: 'unavailable' },
            headers: cors,
          });
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
