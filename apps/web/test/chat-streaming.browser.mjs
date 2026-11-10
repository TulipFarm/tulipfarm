import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
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

test('chat reply streaming and polling fallback in Chromium', { timeout: 240000 }, async t => {
  const port = Number(process.env.CHAT_STREAMING_PORT ?? 5301);
  const origin = `http://127.0.0.1:${port}`;
  const vite = spawn(
    process.execPath,
    [
      new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
  );
  let browser;
  const streams = new Map();
  const eventServer = createServer(async (request, response) => {
    const state = streams.get(new URL(request.url, origin).searchParams.get('chat'));
    if (!state) {
      response.writeHead(404).end();
      return;
    }
    if (state.events.ready) await state.events.ready;
    response.writeHead(200, {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    response.write(state.events.body || ': connected\n\n');
    state.events.send = body => response.write(body);
    state.events.disconnect = () => response.end();
    response.on('close', () => response.end());
  });
  let eventOrigin;
  try {
    await new Promise(resolve => eventServer.listen(0, '127.0.0.1', resolve));
    eventOrigin = `http://127.0.0.1:${eventServer.address().port}`;
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
      if (process.env.CHAT_STREAMING_SCENARIO && !new RegExp(process.env.CHAT_STREAMING_SCENARIO).test(name)) return;
      await t.test(name, async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
        page.setDefaultTimeout(30000);
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
          historySnapshots: [],
          historyStatus: 200,
          eventRequests: 0,
          commands: [],
          question: null,
          sendGate: null,
        };
        streams.set(chatId, state);
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
          else if (path.endsWith('/system-package-installations')) json = { installations: [], nextCursor: null };
          else if (path.endsWith('/slack/status'))
            json = { state: 'active', teamId: 'T_TEST', canManage: false, linked: true, scopes: [] };
          else if (path.endsWith(`/conversations/${chatId}/events`)) {
            state.eventRequests++;
            if (state.events.status === 200) {
              await route.continue({ url: `${eventOrigin}/events?chat=${chatId}` });
              return;
            }
            status = state.events.status;
          } else if (state.question && path.includes(`/requests/${state.question.id}`)) {
            if (request.method() === 'GET') json = state.question;
            else {
              const responseId = path.split('/').at(-1);
              state.question.status = 'answered';
              state.question.response = {
                id: responseId,
                answer: request.postDataJSON().answer,
                createdAt: new Date().toISOString(),
              };
              history[0].turn = { id: turnId, generation: 1, status: 'queued' };
              json = { requestId: state.question.id, revision: 1, status: 'answered', responseId };
            }
          } else if (request.method() === 'PUT' && path.includes(`/conversations/${chatId}/messages/`)) {
            if (state.sendGate) await state.sendGate;
            const body = request.postDataJSON();
            const messageId = path.split('/').at(-1);
            const queued = { id: randomUUID(), generation: 0, status: 'queued' };
            history.push({
              id: messageId,
              sequence: history.length + 1,
              author: 'human',
              createdAt: new Date().toISOString(),
              parts: body.parts,
              turn: queued,
            });
            json = { messageId, turnId: queued.id, sequence: history.length };
          } else if (request.method() === 'GET' && path.endsWith(`/conversations/${chatId}/messages`)) {
            state.historyReads++;
            state.historySnapshots.push({ eventRequests: state.eventRequests });
            status = state.historyStatus;
            json = { messages: history, nextBefore: null, hasGitHubProposals: false };
          } else if (request.method() === 'POST' && /\/turns\/[^/]+\/cancel$/.test(path)) {
            state.commands.push(request.postDataJSON());
            const cancelled = history.find(message => message.turn?.id === path.split('/').at(-2)).turn;
            cancelled.status = 'cancelled';
            cancelled.generation++;
            json = { turnId: cancelled.id, generation: cancelled.generation, status: 'cancelled' };
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
          console.error('Reply failure:', error, errors, await page.locator('body').innerText());
          await screenshot(page, 'reply-failure');
          throw error;
        } finally {
          await page.close();
          streams.delete(chatId);
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
      'a lost stream recovers a completed denied step without reload or duplicate text',
      async ({ page, state, history, turnId, complete, open }) => {
        const answer = 'The action was denied. No records were changed.';
        const tool = {
          id: randomUUID(),
          tool: 'rows.delete',
          status: 'blocked',
          presentation: { label: 'Deleting a row', brand: null },
        };
        history[0].tools = [tool];
        state.events = {
          status: 200,
          body: `event: text\ndata: ${JSON.stringify({ turnId, generation: 0, epoch: 1, step: 0, seq: 0, offset: 0, text: answer, reset: true })}\n\n`,
        };
        await open();
        await page.getByText(answer, { exact: true }).waitFor();
        await delay(200);
        await screenshot(page, 'completion-before-resync');
        await page.evaluate(answer => {
          window.replyCopies = [];
          new MutationObserver(() => {
            window.replyCopies.push(document.body.innerText.split(answer).length - 1);
          }).observe(document.body, { childList: true, subtree: true, characterData: true });
        }, answer);
        const reads = state.historyReads;
        const connections = state.eventRequests;
        complete(answer);
        state.events.disconnect();
        await page.getByRole('button', { name: 'Stop reply' }).waitFor({ state: 'detached' });
        assert.equal(
          state.historySnapshots[reads].eventRequests,
          connections,
          'stream loss refreshes history before a reconnect can supply another open event',
        );
        assert.equal(await page.getByText(answer, { exact: true }).count(), 1);
        assert.equal(
          await page.getByRole('list', { name: 'Messages', exact: true }).locator('[aria-busy="true"]').count(),
          0,
        );
        assert.ok(
          await page.evaluate(() => window.replyCopies.length > 0 && window.replyCopies.every(count => count === 1)),
        );
        await screenshot(page, 'completion-after-resync');
        await page.reload();
        await page.getByText(answer, { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Stop reply' }).count(), 0);
        assert.equal(await page.getByText(answer, { exact: true }).count(), 1);
        await page.getByRole('button', { name: /Tool activity · 1 tool · Access denied/ }).waitFor();
      },
    );

    await scenario(
      'a quiet stream with no done event checks saved completion after one second',
      async ({ page, state, turnId, complete, open }) => {
        await page.clock.install();
        const answer = 'The saved reply is ready.';
        const beginning = 'The saved reply';
        state.events = {
          status: 200,
          body: `event: text\ndata: ${JSON.stringify({ turnId, generation: 0, epoch: 1, step: 0, seq: 0, offset: 0, text: beginning, reset: true })}\n\n`,
        };
        await open();
        await page.getByText(beginning, { exact: true }).waitFor();
        const now = await page.evaluate(() => Date.now());
        await page.clock.pauseAt(new Date(now + 1000));
        try {
          state.events.send(
            `event: text\ndata: ${JSON.stringify({ turnId, generation: 0, epoch: 1, step: 0, seq: 1, offset: 0, text: answer, reset: true })}\n\n`,
          );
          await page.getByText(answer, { exact: true }).waitFor();
          await delay(100);
          const reads = state.historyReads;
          complete(answer);
          await page.clock.fastForward(999);
          assert.equal(state.historyReads, reads, 'the quiet delay starts at the latest actual text');
          await page.clock.fastForward(1);
          for (let i = 0; i < 20 && state.historyReads === reads; i++) {
            await page.clock.runFor(1);
            await delay(25);
          }
          assert.equal(state.historyReads - reads, 1, 'one saved-history check starts after one quiet second');
        } finally {
          await page.clock.resume();
        }
        await page.getByRole('button', { name: 'Stop reply' }).waitFor({ state: 'detached' });
        assert.equal(state.eventRequests, 1);
        assert.equal(await page.getByText(answer, { exact: true }).count(), 1);
      },
    );

    await scenario(
      'thirty seconds of steady streamed text never shows an unconfirmed reply',
      async ({ page, state, turnId, complete, open }) => {
        await page.clock.install();
        let answer = 'The reply keeps growing';
        const text = seq =>
          `event: text\ndata: ${JSON.stringify({ turnId, generation: 0, epoch: 1, step: 0, seq, offset: 0, text: answer, reset: true })}\n\n`;
        state.events = { status: 200, body: text(0) };
        await open();
        await page.getByText(answer, { exact: true }).waitFor();
        const notice = page.getByRole('alert').filter({ hasText: "We couldn't confirm whether this reply finished." });
        const now = await page.evaluate(() => Date.now());
        await page.clock.pauseAt(new Date(now + 1000));
        try {
          for (let chunk = 1; chunk <= 6; chunk++) {
            for (let second = 0; second < 5; second++) {
              await page.clock.fastForward(1000);
              await delay(50);
              assert.equal(await notice.count(), 0, 'a steady stream is not an unconfirmed reply');
            }
            answer += `, part ${chunk}`;
            state.events.send(text(chunk));
            await page.getByText(answer, { exact: true }).waitFor();
          }
          await screenshot(page, 'steady-stream-running-after');
        } finally {
          await page.clock.resume();
        }
        complete(answer);
        await page.clock.fastForward(1000);
        await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor({ state: 'detached' });
        assert.equal(await page.getByText(answer, { exact: true }).count(), 1);
        await screenshot(page, 'steady-stream-after');
      },
    );

    await scenario(
      'unconfirmed completion keeps the answer and Stop, bounds checks, and recovers with Retry',
      async ({ page, state, turnId, complete, open }) => {
        await page.clock.install();
        const answer = 'This reply is still on screen.';
        state.events = {
          status: 200,
          body: `event: text\ndata: ${JSON.stringify({ turnId, generation: 0, epoch: 1, step: 0, seq: 0, offset: 0, text: answer, reset: true })}\n\n`,
        };
        await open();
        await page.getByText(answer, { exact: true }).waitFor();
        await page.clock.runFor(200);
        const reads = state.historyReads;
        await page.getByLabel('Message', { exact: true }).fill('Keep this draft');
        for (const ms of [1000, 2000, 5000]) {
          await page.clock.fastForward(ms);
          await delay(100);
        }
        const notice = page.getByRole('alert').filter({ hasText: "We couldn't confirm whether this reply finished." });
        await notice.waitFor();
        const recoveryReads = state.historyReads - reads;
        assert.ok(recoveryReads <= 3);
        assert.equal(await page.getByRole('button', { name: 'Stop reply', exact: true }).count(), 1);
        assert.equal(await page.getByText(answer, { exact: true }).count(), 1);
        assert.equal(
          await page.getByRole('list', { name: 'Messages', exact: true }).locator('[aria-busy="true"]').count(),
          0,
        );
        state.events.send(
          `event: text\ndata: ${JSON.stringify({ turnId, generation: 0, epoch: 2, step: 0, seq: 1, offset: 0, text: answer, reset: true })}\n\n`,
        );
        await delay(100);
        await page.clock.runFor(1);
        assert.equal(await notice.count(), 1, 'replaying the same answer does not renew the recovery budget');
        await page.clock.fastForward(60_000);
        assert.equal(state.historyReads - reads, recoveryReads, 'automatic checks stop at their budget');
        assert.equal(await page.getByLabel('Message', { exact: true }).innerText(), 'Keep this draft');
        await screenshot(page, 'completion-unconfirmed');
        await page.emulateMedia({ colorScheme: 'dark' });
        await screenshot(page, 'completion-unconfirmed-dark');
        await page.setViewportSize({ width: 390, height: 844 });
        await screenshot(page, 'completion-unconfirmed-mobile-dark');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        await page.emulateMedia({ colorScheme: 'light' });
        await screenshot(page, 'completion-unconfirmed-mobile');
        complete(answer);
        await notice.getByRole('button', { name: 'Retry', exact: true }).click();
        await notice.waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor({ state: 'detached' });
        assert.equal(await page.getByText(answer, { exact: true }).count(), 1);
        assert.equal(await page.getByLabel('Message', { exact: true }).innerText(), 'Keep this draft');
      },
    );

    await scenario(
      'returning from a hidden tab refreshes completion without a stream open or polling timer',
      async ({ page, state, turnId, complete, open }) => {
        await page.clock.install();
        const answer = 'This reply completed while the tab was hidden.';
        state.events = {
          status: 200,
          body: `event: text\ndata: ${JSON.stringify({ turnId, generation: 0, epoch: 1, step: 0, seq: 0, offset: 0, text: answer, reset: true })}\n\n`,
        };
        await open();
        await page.getByText(answer, { exact: true }).waitFor();
        const now = await page.evaluate(() => Date.now());
        await page.clock.pauseAt(new Date(now + 1000));
        const visibility = value =>
          page.evaluate(value => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, value });
            Object.defineProperty(document, 'hidden', { configurable: true, value: value === 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
          }, value);
        const reconnect = Promise.withResolvers();
        try {
          await visibility('hidden');
          await page.clock.runFor(1);
          await delay(100);
          const reads = state.historyReads;
          complete(answer);
          state.events.ready = reconnect.promise;
          await page.clock.fastForward(60_000);
          assert.equal(state.historyReads, reads, 'hidden tabs do not poll history');
          const returningAt = await page.evaluate(() => Date.now());
          await visibility('visible');
          for (let i = 0; i < 20 && state.historyReads === reads; i++) {
            await page.clock.runFor(10);
            await delay(25);
          }
          assert.ok(state.historyReads > reads, 'foreground return immediately requests durable history');
          assert.ok((await page.evaluate(() => Date.now())) - returningAt <= 200, 'the read starts within 200 ms');
          for (let i = 0; i < 50; i++) {
            await page.clock.runFor(1);
            await delay(25);
            if (!(await page.getByRole('button', { name: 'Stop reply', exact: true }).count())) break;
          }
          assert.equal(
            await page.getByRole('button', { name: 'Stop reply', exact: true }).count(),
            0,
            'foreground return reads saved completion without waiting for a stream open or a polling interval',
          );
          assert.equal(await page.getByText(answer, { exact: true }).count(), 1);
        } finally {
          reconnect.resolve();
          await page.clock.resume();
        }
        await page.getByRole('status', { name: 'Loading plans', exact: true }).waitFor({ state: 'detached' });
        await screenshot(page, 'completion-visibility-after');
      },
    );

    await scenario(
      'going offline keeps an explicit status notice and Retry cannot claim completion',
      async ({ page, state, turnId, complete, open }) => {
        const answer = 'This reply stays here while offline.';
        state.events = {
          status: 200,
          body: `event: text\ndata: ${JSON.stringify({ turnId, generation: 0, epoch: 1, step: 0, seq: 0, offset: 0, text: answer, reset: true })}\n\n`,
        };
        await open();
        await page.getByText(answer, { exact: true }).waitFor();
        await page.context().setOffline(true);
        const notice = page.getByRole('alert').filter({ hasText: "We couldn't confirm whether this reply finished." });
        await notice.waitFor();
        await notice.getByRole('button', { name: 'Retry', exact: true }).click();
        await notice.waitFor();
        assert.equal(await page.getByRole('button', { name: 'Stop reply', exact: true }).count(), 1);
        assert.equal(await page.getByText(answer, { exact: true }).count(), 1);
        complete(answer);
        await page.context().setOffline(false);
        await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor({ state: 'detached' });
        await notice.waitFor({ state: 'detached' });
        assert.equal(await page.getByText(answer, { exact: true }).count(), 1);
      },
    );

    await scenario(
      'a genuinely running tool does not trigger quiet-answer completion checks',
      async ({ page, state, history, turnId, open }) => {
        await page.clock.install();
        history[0].tools = [{ id: randomUUID(), tool: 'tables.list', status: 'running' }];
        state.events = {
          status: 200,
          body: `event: text\ndata: ${JSON.stringify({ turnId, generation: 0, epoch: 1, step: 0, seq: 0, offset: 0, text: 'I am checking the table.', reset: true })}\n\n`,
        };
        await open();
        await page.getByText('I am checking the table.', { exact: true }).waitFor();
        await page.clock.runFor(200);
        const reads = state.historyReads;
        await page.clock.fastForward(8000);
        assert.equal(state.historyReads, reads);
        assert.equal(await page.getByRole('button', { name: 'Stop reply', exact: true }).count(), 1);
        assert.equal(
          await page.getByText("We couldn't confirm whether this reply finished.", { exact: true }).count(),
          0,
        );
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
          state.historyReads - reads <= 2,
          `quiet-text recovery is backoff-spaced, not polled every 500 ms (${state.historyReads - reads} reads in 3 s)`,
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
      'a reply whose model is unavailable ends with a clear error and a retry, not a spinner',
      async ({ page, state, workspace, chatId, history, open }) => {
        await open();
        await page.getByRole('button', { name: 'Stop reply' }).waitFor();
        history[0].turn = { ...history[0].turn, status: 'failed', errorCode: 'model-configuration' };
        await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
        await page.getByRole('alert').filter({ hasText: "This model isn't available." }).waitFor();
        await page.getByRole('button', { name: 'Stop reply' }).waitFor({ state: 'detached' });
        await page.getByRole('button', { name: 'Retry reply', exact: true }).waitFor();
        assert.equal(state.commands.length, 0, 'a failed reply is not retried without the person asking');
        await screenshot(page, 'model-unavailable-reply');
      },
    );

    await scenario(
      'a reply answered by the fallback model shows which model answered',
      async ({ page, history, complete, open }) => {
        complete('Hello from the fallback model.');
        history[0].turn.errorCode = 'model-fallback:kimi';
        history[0].turn.stats = { model: 'deepseek-pro', firstTextMs: 900, durationMs: 1800 };
        await open();
        await page.getByText('Hello from the fallback model.', { exact: true }).waitFor();
        await page.getByText('Answered by Kimi because DeepSeek Pro was unavailable.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('alert').count(), 0);
        await screenshot(page, 'fallback-model-reply');
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
        const thinking = page.getByText(/(Thinking|Planning next step|Drafting|Working|Searching) · Step \d/);
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
      'a separate message waits for a choice through send, reload and answer before replying in order',
      async ({ page, state, workspace, chatId, turnId, history, complete, open }) => {
        await page.clock.install();
        history[0].turn.status = 'waiting';
        const requestId = randomUUID();
        state.question = {
          id: requestId,
          turnId,
          revision: 1,
          prompt: 'Which day works?',
          expiresAt: '2099-01-01T00:00:00Z',
          answerSchema: {
            kind: 'choices',
            multiple: false,
            choices: [
              { id: 'monday', label: 'Monday' },
              { id: 'tuesday', label: 'Tuesday' },
            ],
          },
          status: 'pending',
          response: null,
        };
        history.push({
          id: requestId,
          sequence: 2,
          author: 'assistant',
          createdAt: new Date().toISOString(),
          parts: [{ kind: 'request', requestId }],
          turn: null,
        });
        await open();
        const dock = page.getByRole('region', { name: 'Questions', exact: true });
        await dock.getByRole('radio', { name: /Tuesday/ }).waitFor();
        let accept;
        state.sendGate = new Promise(resolve => (accept = resolve));
        await page.getByLabel('Message', { exact: true }).fill('Also prepare the agenda.');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await page.getByText('Also prepare the agenda.', { exact: true }).waitFor();
        const queuedNotice = page.getByText('Waiting for your answer above. This message will be answered next.', {
          exact: true,
        });
        try {
          await queuedNotice.waitFor({ timeout: 1000 });
          assert.equal(await page.locator('[data-slot="reply-progress"]').count(), 0);
        } finally {
          await screenshot(page, 'queued-question');
          accept();
        }
        await page.getByRole('button', { name: 'Remove queued message', exact: true }).waitFor();
        const queued = history.at(-1);
        for (const reload of [false, true]) {
          if (reload) await page.reload();
          await queuedNotice.waitFor();
          await page.getByRole('button', { name: 'Remove queued message', exact: true }).waitFor();
          await page.clock.fastForward(120_001);
          assert.equal(await page.locator('[data-slot="reply-progress"]').count(), 0);
          assert.equal(await page.getByText('Reply is taking too long', { exact: true }).count(), 0);
          assert.equal(await page.getByText(/Cancel it, then send your message again/).count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Stop reply', exact: true }).count(), 0);
        }
        await screenshot(page, 'queued-question-reloaded');
        await dock.getByRole('radio', { name: /Tuesday/ }).check();
        await dock.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByText('This message will be answered after the reply above.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
        history[0].turn.status = 'processing';
        complete('Tuesday is confirmed.');
        history.at(-1).sequence = history.length;
        queued.turn.status = 'processing';
        await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
        await page.getByText('Tuesday is confirmed.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Remove queued message', exact: true }).waitFor({ state: 'detached' });
        queued.turn.status = 'completed';
        history.push({
          id: randomUUID(),
          sequence: history.length + 1,
          author: 'assistant',
          createdAt: new Date().toISOString(),
          parts: [{ kind: 'text', text: 'The agenda is ready.' }],
          turn: null,
        });
        await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
        await page.getByText('The agenda is ready.', { exact: true }).waitFor();
        const replies = await page.getByRole('list', { name: 'Messages' }).innerText();
        assert.ok(replies.indexOf('Tuesday is confirmed.') < replies.indexOf('The agenda is ready.'));
        assert.equal(await queuedNotice.count(), 0);
      },
    );

    await scenario(
      'removing a queued message leaves the waiting turn alone',
      async ({ page, state, history, turnId, open }) => {
        history[0].turn.status = 'waiting';
        const queuedTurn = { id: randomUUID(), generation: 4, status: 'queued' };
        history.push({
          id: randomUUID(),
          sequence: 2,
          author: 'human',
          createdAt: new Date().toISOString(),
          parts: [{ kind: 'text', text: 'Remove this follow-up.' }],
          turn: queuedTurn,
        });
        await open();
        await page.getByRole('button', { name: 'Remove queued message', exact: true }).click();
        await page.getByRole('button', { name: 'Remove queued message', exact: true }).waitFor({ state: 'detached' });
        assert.equal(state.commands.length, 1);
        assert.equal(state.commands[0].expectedGeneration, 4);
        assert.equal(queuedTurn.status, 'cancelled');
        assert.equal(history[0].turn.id, turnId);
        assert.equal(history[0].turn.status, 'waiting');
        assert.equal(await page.getByText('Reply is taking too long', { exact: true }).count(), 0);
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
    ).finally(() => new Promise(resolve => eventServer.close(resolve)));
  }
});
