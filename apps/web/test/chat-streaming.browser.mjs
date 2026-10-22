import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits, notifyChange } from './chat-query.fixture.mjs';

const screenshots =
  process.env.CHAT_STREAMING_SCREENSHOTS ?? new URL('../../../reports/check/chat-streaming/', import.meta.url).pathname;
const cdpPort = process.env.CHAT_STREAMING_CDP_PORT;

async function closeFixture(closeAgent, browser, vite) {
  try {
    closeAgent();
  } finally {
    try {
      await browser?.close();
    } finally {
      vite.kill('SIGTERM');
    }
  }
}

test('browser fixture cleanup releases owned resources even when a close fails', async () => {
  for (const failure of ['agent', 'browser']) {
    const calls = [];
    const error = new Error(`${failure} close failed`);
    await assert.rejects(
      closeFixture(
        () => {
          calls.push('agent');
          if (failure === 'agent') throw error;
        },
        {
          close: async () => {
            calls.push('browser');
            if (failure === 'browser') throw error;
          },
        },
        {
          kill: signal => {
            calls.push(signal);
          },
        },
      ),
      error,
    );
    assert.deepEqual(calls, ['agent', 'browser', 'SIGTERM']);
  }
});

test('chat reply streaming and polling fallback in Chromium', { timeout: 180000 }, async t => {
  const port = Number(process.env.CHAT_STREAMING_PORT ?? 5301);
  const origin = `http://127.0.0.1:${port}`;
  const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  let browser;
  try {
    for (let i = 0; ; i++) {
      if (
        await fetch(origin).then(
          response => response.ok,
          () => false,
        )
      )
        break;
      assert.ok(i < 600 && vite.exitCode === null, 'Vite must start');
      await delay(100);
    }
    await mkdir(screenshots, { recursive: true });
    browser = await chromium.launch({
      headless: process.env.CHAT_BROWSER_HEADED !== '1',
      ...(cdpPort ? { args: [`--remote-debugging-port=${cdpPort}`] } : {}),
    });
    const screenshot = async (page, name) => {
      await page.screenshot({ path: `${screenshots}${name}.png`, fullPage: true });
      if (cdpPort)
        execFileSync(
          'agent-browser',
          ['--session', 'current-reply', '--cdp', cdpPort, 'screenshot', `${screenshots}${name}-agent-browser.png`],
          { stdio: 'inherit' },
        );
    };
    async function scenario(name, run) {
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
        const chatId = randomUUID(),
          turnId = randomUUID();
        const chat = {
          id: chatId,
          title: 'Say hello',
          titleRevision: 1,
          archived: false,
          activityAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        const history = [
          {
            id: randomUUID(),
            sequence: 1,
            author: 'human',
            createdAt: new Date().toISOString(),
            parts: [{ kind: 'text', text: 'Say hello' }],
            turn: { id: turnId, generation: 0, status: 'processing' },
          },
        ];
        const state = {
          events: { status: 503, body: '' },
          historyReads: 0,
          historyStatus: 200,
          eventRequests: 0,
          commands: [],
        };
        const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' };
        await page.route('**/v1/**', async route => {
          const request = route.request(),
            url = new URL(request.url()),
            path = url.pathname;
          let json,
            status = 200;
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
          else if (path.endsWith('/slack/status'))
            json = { state: 'active', teamId: 'T_TEST', canManage: false, linked: true, scopes: [] };
          else if (path.endsWith(`/conversations/${chatId}/events`)) {
            state.eventRequests++;
            if (state.events.status === 200) {
              if (state.events.ready) await state.events.ready;
              await route.fulfill({
                status: 200,
                headers: { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
                body: state.events.body,
              });
              return;
            }
            status = state.events.status;
          } else if (request.method() === 'GET' && path.endsWith(`/conversations/${chatId}/messages`)) {
            state.historyReads++;
            status = state.historyStatus;
            json = { messages: history, nextBefore: null, hasGitHubProposals: false };
          } else if (request.method() === 'POST' && path.endsWith(`/turns/${turnId}/cancel`)) {
            state.commands.push(request.postDataJSON());
            history[0].turn.status = 'cancelled';
            json = { turnId, generation: history[0].turn.generation, status: 'cancelled' };
          } else if (request.method() === 'POST' && path.endsWith(`/turns/${turnId}/retry`)) {
            state.commands.push(request.postDataJSON());
            history[0].turn = { id: turnId, generation: history[0].turn.generation + 1, status: 'queued' };
            json = { turnId, generation: history[0].turn.generation, status: 'queued' };
          } else if (request.method() === 'GET' && path.endsWith(`/conversations/${chatId}`)) json = chat;
          else if (request.method() === 'GET' && path.endsWith('/conversations'))
            json = { chats: [chat], nextCursor: null };
          else status = 404;
          await route.fulfill({ status, json: status === 200 ? json : { error: 'unavailable' }, headers: cors });
        });
        const complete = text => {
          history[0].turn.status = 'completed';
          history.push({
            id: randomUUID(),
            sequence: 2,
            author: 'assistant',
            createdAt: new Date().toISOString(),
            parts: [{ kind: 'text', text }],
            turn: null,
          });
        };
        try {
          await run({
            page,
            state,
            workspace,
            chat,
            chatId,
            turnId,
            history,
            complete,
            open: () => page.goto(`${origin}/acme/chat/${chatId}`),
          });
          assert.deepEqual(errors, []);
        } catch (error) {
          console.error('Reply failure:', errors, await page.locator('body').innerText());
          await screenshot(page, 'reply-failure');
          throw error;
        } finally {
          await page.close();
        }
      });
    }

    await scenario(
      'quick real SSE call start-complete and the next call render without a history snapshot',
      async ({ page, state, turnId, open }) => {
        const first = randomUUID(),
          second = randomUUID();
        const call = {
          turnId,
          generation: 0,
          epoch: 1,
          id: first,
          tool: 'slack.resolve',
          sequence: 1,
          presentation: { label: 'Finding a Slack channel', brand: 'slack' },
        };
        const frame = data => `event: tool\ndata: ${JSON.stringify(data)}\n\n`;
        const ready = Promise.withResolvers();
        state.events = {
          status: 200,
          ready: ready.promise,
          body:
            frame({ ...call, status: 'running' }) +
            frame({ ...call, status: 'completed' }) +
            frame({
              ...call,
              id: second,
              tool: 'rows.get',
              sequence: 2,
              status: 'running',
              presentation: { label: 'Reading a row', brand: null },
            }),
        };
        await page.addInitScript(() => {
          window.activityHeadings = [];
          new MutationObserver(() => {
            window.activityHeadings.push(
              [...document.querySelectorAll('[data-slot="tool-activity"] > button')]
                .map(element => element.textContent)
                .join(' | '),
            );
          }).observe(document, { subtree: true, childList: true, characterData: true });
        });
        await open();
        await page.getByRole('list', { name: 'Messages', exact: true }).waitFor();
        ready.resolve();
        const activity = page
          .getByRole('region', { name: 'Conversation', exact: true })
          .locator('[data-slot="tool-activity"]');
        await activity.getByRole('button', { name: /Working… Reading a row/ }).click();
        await activity.locator(`[data-tool-id="${second}"][data-status="running"]`).waitFor();
        assert.equal(await activity.locator(`[data-tool-id="${first}"][data-status="completed"]`).count(), 1);
        assert.equal(await activity.locator('[data-tool-id]').count(), 2);
        assert.ok(
          await page.evaluate(() => window.activityHeadings.some(text => text.includes('Finding a Slack channel'))),
          'the short call was visible in collapsed chat progress before the next call',
        );
        assert.equal(await activity.getByText(/Planning next step|Step \d/).count(), 0);
        assert.equal(await page.getByRole('region', { name: 'Canvas', exact: true }).count(), 0);
      },
    );

    await scenario(
      'expanded provisional activity survives its saved message arriving',
      async ({ page, state, workspace, chatId, history, open }) => {
        history.length = 0;
        const turnId = randomUUID(),
          id = randomUUID();
        const tool = {
          turnId,
          generation: 0,
          epoch: 1,
          id,
          tool: 'rows.get',
          sequence: 1,
          status: 'running',
          presentation: { label: 'Reading a row', brand: null },
        };
        state.events = { status: 200, body: `event: tool\ndata: ${JSON.stringify(tool)}\n\n` };
        await open();
        const activity = page.getByRole('button', { name: /Working… Reading a row/ });
        await activity.click();
        await page.locator(`[data-tool-id="${id}"]`).waitFor();
        history.push({
          id: randomUUID(),
          sequence: 2,
          author: 'human',
          createdAt: new Date().toISOString(),
          parts: [{ kind: 'text', text: 'Read the next row' }],
          turn: { id: turnId, generation: 0, status: 'processing' },
          tools: [tool],
        });
        await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
        await page.getByText('Read the next row', { exact: true }).waitFor();
        assert.equal(
          await activity.getAttribute('aria-expanded'),
          'true',
          'history catch-up preserves the same expanded activity',
        );
        assert.equal(await page.locator(`[data-tool-id="${id}"]`).count(), 1);
      },
    );

    await scenario(
      'streamed text shows before the saved reply, without fast polling, and is replaced exactly once',
      async ({ page, state, workspace, chatId, turnId, complete, open }) => {
        const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        const identity = { turnId, generation: 0, epoch: 1, step: 0 };
        state.events = {
          status: 200,
          body: `retry: 60000\n\n${frame('text', { ...identity, seq: 0, offset: 0, text: 'Hello from', reset: true })}: keepalive\n\n${frame('text', { ...identity, seq: 1, offset: 10, text: ' the stream', reset: false })}`,
        };
        await open();
        await page.getByText('Hello from the stream', { exact: true }).waitFor();
        await screenshot(page, 'streaming-reply');
        const reads = state.historyReads;
        await delay(3000);
        assert.ok(
          state.historyReads - reads <= 1,
          `history is not polled every 500 ms while the stream is open (${state.historyReads - reads} reads in 3 s)`,
        );
        assert.equal(state.eventRequests, 1, 'one event stream per open chat');
        complete('Hello from the stream');
        await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
        await page.getByRole('button', { name: 'Stop reply' }).waitFor({ state: 'detached' });
        assert.equal(
          await page.getByText('Hello from the stream', { exact: true }).count(),
          1,
          'the saved reply replaces the streamed text',
        );
      },
    );

    await scenario(
      'an unfinished reply shows a clear failure and requires one explicit retry',
      async ({ page, state, workspace, chat, chatId, history, complete, open }) => {
        chat.title = 'Create a workflow';
        history[0].parts = [{ kind: 'text', text: 'Create a workflow that sends pull request summaries to Slack.' }];
        history[0].turn = {
          ...history[0].turn,
          generation: 1,
          status: 'failed',
          errorCode: 'model-incomplete-response',
        };
        await open();
        await page
          .getByRole('alert')
          .filter({ hasText: 'The agent stopped without finishing your request.' })
          .waitFor();
        await screenshot(page, 'unfinished-reply');
        assert.equal(state.commands.length, 0, 'opening the failed chat must not retry it');
        await page.getByRole('button', { name: 'Retry reply', exact: true }).click();
        await page.getByRole('button', { name: 'Stop reply' }).waitFor();
        assert.equal(state.commands.length, 1);
        assert.equal(state.commands[0].expectedGeneration, 1);
        assert.equal(
          await page.getByText('The agent stopped without finishing your request.', { exact: false }).count(),
          0,
        );
        complete('The requested work is now complete.');
        await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
        await page.getByText('The requested work is now complete.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Retry reply', exact: true }).count(), 0);
        await screenshot(page, 'unfinished-reply-recovered');
      },
    );

    await scenario(
      'an unavailable stream falls back to polling that shows the reply without user action',
      async ({ page, state, complete, open }) => {
        state.events = { status: 503, body: '' };
        await open();
        await page.getByRole('button', { name: 'Stop reply' }).waitFor();
        complete('Reply found by polling.');
        await page.getByText('Reply found by polling.', { exact: true }).waitFor({ timeout: 8000 });
        assert.ok(state.eventRequests >= 1, 'the chat tried the event stream first');
        assert.equal(await page.getByText('Automatic checks stopped', { exact: false }).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Check chat status' }).count(), 0);
        await page.getByRole('button', { name: 'Chat actions' }).click();
        await page.getByRole('menuitem', { name: 'Edit title', exact: true }).waitFor();
        assert.equal(await page.getByRole('menuitem', { name: 'Check chat status' }).count(), 0);
        await page.keyboard.press('Escape');
        await screenshot(page, 'polling-fallback');
      },
    );

    await scenario(
      'working narration, slow-step recovery, and refresh errors keep the current reply',
      async ({ page, state, workspace, chatId, turnId, history, complete, open }) => {
        await page.clock.install();
        const identity = { turnId, generation: 0, epoch: 1, step: 0 };
        state.events = {
          status: 200,
          body: `retry: 60000\n\nevent: text\ndata: ${JSON.stringify({ ...identity, seq: 0, offset: 0, text: 'I am checking the table.', reset: true })}\n\nevent: progress\ndata: ${JSON.stringify({ ...identity, step: 1, round: 2 })}\n\n`,
        };
        history[0].tools = [{ id: randomUUID(), tool: 'tables.list', status: 'running' }];
        await open();
        const thinking = page.locator('[data-slot="thinking-state"]');
        await page
          .getByRole('region', { name: 'Conversation', exact: true })
          .getByRole('button', { name: /Working… Listing business tables/ })
          .click();
        await page
          .getByRole('region', { name: 'Conversation', exact: true })
          .locator(`[data-tool-id="${history[0].tools[0].id}"][data-status="running"]`)
          .waitFor();
        assert.equal(await thinking.count(), 0, 'the actual running call replaces generic searching/step narration');
        await page.getByText('I am checking the table.', { exact: true }).waitFor();
        assert.equal(
          await page.getByText('TulipFarm said', { exact: true }).count(),
          0,
          'narration is not shown as the final answer',
        );
        await screenshot(page, 'working-narration');
        const slow = page.getByText('This step is taking longer than usual. The reply continues, or you can stop it.', {
          exact: true,
        });
        await page.clock.fastForward(20_001);
        await slow.waitFor();
        history[0].tools[0].status = 'completed';
        await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
        await page.getByRole('button', { name: /Planning next step · Step 2/ }).waitFor();
        await slow.waitFor({ state: 'detached' });
        await page.getByLabel('Message', { exact: true }).fill('Keep my draft');
        state.historyStatus = 503;
        await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
        await page.getByRole('button', { name: 'Retry refresh', exact: true }).waitFor();
        assert.equal(await page.getByLabel('Message', { exact: true }).innerText(), 'Keep my draft');
        assert.equal(await page.getByText('I am checking the table.', { exact: true }).count(), 1);
        state.historyStatus = 200;
        await page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
        await page.getByRole('button', { name: 'Retry refresh', exact: true }).waitFor({ state: 'detached' });
        complete('The table is ready.');
        await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
        await page.getByText('The table is ready.', { exact: true }).waitFor();
        assert.equal(await page.getByText('I am checking the table.', { exact: true }).count(), 0);
        assert.equal(await thinking.count(), 0);
        assert.equal(await slow.count(), 0);
      },
    );

    await scenario(
      'queued delay resets on a new generation and cancels only that generation',
      async ({ page, state, workspace, chatId, history, open }) => {
        await page.clock.install();
        history[0].turn.status = 'queued';
        await open();
        await page.locator('[data-slot="reply-progress"]').waitFor();
        await page.clock.fastForward(60_001);
        await page.getByText('Reply is taking too long', { exact: true }).waitFor();
        history[0].turn.generation = 1;
        await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
        await page.getByText('Reply is taking too long', { exact: true }).waitFor({ state: 'detached' });
        await page.clock.fastForward(59_000);
        assert.equal(await page.getByText('Reply is taking too long', { exact: true }).count(), 0);
        await page.clock.fastForward(1_001);
        await page.getByRole('button', { name: 'Cancel reply', exact: true }).click();
        await page.locator('[data-slot="reply-progress"]').waitFor({ state: 'detached' });
        assert.equal(state.commands.length, 1);
        assert.equal(state.commands[0].expectedGeneration, 1);
      },
    );
  } finally {
    await closeFixture(
      () => {
        if (cdpPort) execFileSync('agent-browser', ['--session', 'current-reply', 'close'], { stdio: 'inherit' });
      },
      browser,
      vite,
    );
  }
});
