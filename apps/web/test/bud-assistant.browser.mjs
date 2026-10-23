import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { budGreeting } from '@tulipfarm/conversations/bud-contracts';
import { fallbackRecommendations } from '@tulipfarm/recommendations';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits, notifyChange } from './chat-query.fixture.mjs';

test(
  'Bud has a compact drag-only popup, retaining chat, approvals and preference consent',
  { timeout: 180000 },
  async () => {
    const port = Number(process.env.BUD_PORT ?? 5327),
      origin = `http://127.0.0.1:${port}`;
    const screenshots = process.env.BUD_SCREENSHOTS,
      cdp = process.env.BUD_CDP_PORT;
    const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    });
    let browser, page;
    try {
      for (let attempt = 0; ; attempt++) {
        if (
          await fetch(origin).then(
            response => response.ok,
            () => false,
          )
        )
          break;
        assert.ok(attempt < 200 && vite.exitCode === null, 'Vite starts');
        await delay(100);
      }
      browser = await chromium.launch({
        headless: process.env.CHAT_BROWSER_HEADED !== '1',
        args: ['--enable-unsafe-swiftshader', ...(cdp ? [`--remote-debugging-port=${cdp}`] : [])],
      });
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(15000);
      const errors = [],
        commands = [],
        sends = [],
        decisions = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.addInitScript(() => {
        const streams = [];
        window.EventSource = class extends EventTarget {
          readyState = 0;
          constructor(url) {
            super();
            this.url = String(url);
            streams.push(this);
            setTimeout(() => {
              if (this.readyState !== 2) {
                this.readyState = 1;
                this.dispatchEvent(new Event('open'));
              }
            }, 0);
          }
          close() {
            this.readyState = 2;
          }
        };
        window.budEvent = data => {
          for (const stream of streams)
            if (stream.readyState === 1 && stream.url.endsWith('/recommendations/events')) {
              stream.dispatchEvent(new MessageEvent(data.kind, { data: JSON.stringify(data) }));
            }
        };
        window.budChatEvent = ({ event, data }) => {
          for (const stream of streams)
            if (stream.readyState === 1 && /\/conversations\/[^/]+\/events$/.test(stream.url)) {
              stream.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
            }
        };
      });
      const workspace = {
        id: randomUUID(),
        slug: 'acme',
        name: 'Acme',
        status: 'ready',
        createdAt: new Date().toISOString(),
        soulCommit: 'a'.repeat(40),
      };
      const chatId = randomUUID(),
        history = [];
      const chat = {
        id: chatId,
        title: 'Bud',
        titleRevision: 1,
        archived: false,
        activityAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      let state,
        failSave = false,
        failSend = false,
        failNudge = false,
        approval;
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        let json,
          status = 200;
        if (path === '/v1/auth/get-session')
          json = {
            session: { id: 'bud-session', userId: 'ada' },
            user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
          };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === '/v1/workspaces/acme') json = workspace;
        else if (path.endsWith('/governance/me')) json = membership;
        else if (path.endsWith('/credits')) json = credits;
        else if (path.endsWith('/model-catalog')) json = chatCatalog;
        else if (path.endsWith('/recommendations'))
          json = { onboarding: false, status: 'ready', version: 1, items: fallbackRecommendations };
        else if (path.endsWith('/bud')) {
          if (request.method() === 'POST') {
            const command = request.postDataJSON();
            commands.push(command);
            if (command.kind === 'bootstrap' && !state) {
              state = {
                conversationId: null,
                onboarding: 'active',
                bubblesEnabled: true,
                snoozedUntil: null,
                nudge: null,
                preferences: [],
              };
            } else if (command.kind === 'open' && !state.conversationId) {
              state.conversationId = chatId;
              if (state.onboarding === 'active')
                history.push({
                  id: randomUUID(),
                  sequence: 1,
                  author: 'assistant',
                  createdAt: new Date().toISOString(),
                  parts: [{ kind: 'text', text: budGreeting }],
                  turn: null,
                });
            } else if (command.kind === 'skip') state.onboarding = 'skipped';
            else if (command.kind === 'settings') {
              state.bubblesEnabled = command.enabled ?? state.bubblesEnabled;
              state.snoozedUntil = command.snoozedUntil ?? null;
            } else if (command.kind === 'present') state.nudge.presented = true;
            else if (command.kind === 'dismiss') state.nudge = null;
            else if (command.kind === 'open-nudge') {
              if (failNudge) return route.fulfill({ status: 503, json: { error: 'bud-unavailable' } });
              if (state.nudge?.action.kind === 'prompt') {
                history.push({
                  id: randomUUID(),
                  sequence: history.length + 1,
                  author: 'human',
                  createdAt: new Date().toISOString(),
                  parts: [{ kind: 'text', text: state.nudge.action.prompt }],
                  turn: { id: randomUUID(), generation: 0, status: 'queued' },
                });
              }
              state.nudge = null;
            } else if (command.kind === 'answer-preference') {
              if (failSave) return route.fulfill({ status: 503, json: { error: 'bud-unavailable' } });
              state.preferences[0] = {
                ...state.preferences[0],
                value: command.value,
                status: 'saved',
                savedRevision: 1,
              };
            } else if (command.kind === 'undo-preference') state.preferences = [];
          }
          json = state ?? { error: 'bud-not-initialized' };
          status = state ? 200 : 409;
        } else if (request.method() === 'PUT' && path.includes(`/conversations/${chatId}/messages/`)) {
          const command = request.postDataJSON();
          if (failSend) return route.fulfill({ status: 400, json: { error: 'invalid-input' } });
          sends.push(command);
          const messageId = path.split('/').at(-1),
            turnId = randomUUID();
          history.push({
            id: messageId,
            sequence: history.length + 1,
            author: 'human',
            createdAt: new Date().toISOString(),
            parts: command.parts,
            turn: { id: turnId, generation: 0, status: 'processing' },
          });
          json = { messageId, turnId, sequence: history.length };
        } else if (approval && path.endsWith(`/approvals/${approval.id}/decision`)) {
          const command = request.postDataJSON();
          decisions.push(command);
          approval.resolution = {
            requestId: approval.id,
            revision: 2,
            status: command.decision === 'approve' ? 'approved' : 'rejected',
            confirmationId: randomUUID(),
          };
          json = approval.resolution;
        } else if (approval && path.endsWith(`/approvals/${approval.id}`)) json = approval;
        else if (path.endsWith(`/conversations/${chatId}/messages`))
          json = { messages: history, nextBefore: null, hasGitHubProposals: false };
        else if (path.endsWith(`/conversations/${chatId}`)) json = chat;
        else if (path.endsWith('/conversations')) json = { chats: state ? [chat] : [], nextCursor: null };
        else status = 404;
        await route.fulfill({ status, json: json ?? { error: 'unavailable' } });
      });
      const shot = async name => {
        if (!screenshots) return;
        await mkdir(screenshots, { recursive: true });
        if (cdp) {
          execFileSync(
            'agent-browser',
            ['--session', 'bud-proof', '--cdp', cdp, 'screenshot', `${screenshots}/${name}.png`],
            { stdio: 'inherit' },
          );
        } else await page.screenshot({ path: `${screenshots}/${name}.png` });
      };
      const emit = kind =>
        page.evaluate(data => window.budEvent(data), {
          kind,
          workspaceId: workspace.id,
          membershipId: membership.membershipId,
          version: 1,
        });
      const composer = page.locator('[data-bud-conversation]').getByRole('textbox', { name: 'Message', exact: true });
      const popup = page.getByRole('dialog', { name: 'Bud quick chat', exact: true });
      const dock = page.getByRole('complementary', { name: 'Bud assistant' });
      const dragCorner = async (corner, persisted = true) => {
        const button = dock.getByRole('button', { name: /^(Open|Minimize) Bud$/ });
        const start = await button.boundingBox(),
          viewport = page.viewportSize();
        await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          corner.endsWith('left') ? 40 : viewport.width - 40,
          corner.startsWith('top') ? 40 : viewport.height - 40,
          { steps: 8 },
        );
        await page.mouse.up();
        await page.waitForFunction(
          value => document.querySelector('[aria-label="Bud assistant"]')?.getAttribute('data-corner') === value,
          corner,
        );
        await page.waitForFunction(value => {
          const anchor = document.querySelector('[aria-label="Bud assistant"]').getBoundingClientRect();
          const panel = document
            .querySelector('[data-slot="popover-content"][data-size="bud"]')
            .getBoundingClientRect();
          return value.startsWith('top') ? panel.y >= anchor.bottom : panel.bottom <= anchor.y;
        }, corner);
        if (persisted) assert.equal(await page.evaluate(() => localStorage.getItem('tulipfarm:bud-corner')), corner);
        const anchor = await dock.boundingBox(),
          panel = await popup.boundingBox();
        assert.ok(anchor && panel && viewport);
        assert.ok(
          panel.x >= 0 &&
            panel.y >= 0 &&
            panel.x + panel.width <= viewport.width &&
            panel.y + panel.height <= viewport.height,
          'popup stays inside the screen',
        );
        assert.ok(
          corner.startsWith('top') ? panel.y >= anchor.y + anchor.height : panel.y + panel.height <= anchor.y,
          'popup opens inward from its corner',
        );
      };
      await page.goto(`${origin}/acme`);
      await page.getByRole('button', { name: 'Open Bud', exact: true }).waitFor();
      while (!commands.some(command => command.kind === 'bootstrap')) await delay(50);
      await delay(1000);
      assert.equal(new URL(page.url()).pathname, '/acme', 'a new member is not sent to a Bud chat');
      assert.equal(history.length, 0, 'no greeting before the member opens Bud');
      assert.equal(state?.conversationId, null, 'no Bud thread before the member opens Bud');
      assert.equal(
        commands.filter(command => command.kind === 'sync').length,
        0,
        'no setup checks before the member opens Bud',
      );
      await page.getByRole('button', { name: 'Open Bud', exact: true }).click();
      await popup.waitFor();
      await popup.getByText(budGreeting, { exact: true }).waitFor();
      assert.equal(history.length, 1);
      await shot('bud-onboarding');
      await popup.getByRole('button', { name: 'Skip setup', exact: true }).click();
      await popup.getByRole('button', { name: 'Skip setup', exact: true }).waitFor({ state: 'hidden' });
      state.onboarding = 'completed';
      await emit('changed');
      await popup.getByRole('button', { name: 'Continue', exact: true }).click();
      await popup.waitFor({ state: 'hidden' });
      assert.equal(new URL(page.url()).pathname, '/acme', 'Continue in the popup keeps the current page');
      state.onboarding = 'skipped';
      await emit('changed');
      await page.getByRole('button', { name: 'Open Bud', exact: true }).click();
      await popup.waitFor();
      assert.equal(await popup.getByRole('combobox').count(), 0, 'no position selector');
      assert.equal(
        await popup.getByRole('button', { name: /canvas|Model:|Add files and more|Mode:|Chat actions/i }).count(),
        0,
        'full-chat controls are absent',
      );
      assert.equal(await popup.locator('[data-slot="canvas"]').count(), 0);
      assert.equal(await popup.getByText('TulipFarm can make mistakes.', { exact: false }).count(), 0);
      const compactBounds = await popup.boundingBox();
      assert.ok(compactBounds.width <= 384 && compactBounds.height <= 416, 'desktop quick chat is small');
      assert.equal(
        await popup.getByRole('button', { name: /Snooze|Turn bubbles/ }).count(),
        0,
        'bubble settings do not clutter the conversation',
      );
      assert.ok(
        (await popup.getByRole('form', { name: 'Message composer' }).boundingBox()).height < 80,
        'compact input is not the full composer',
      );
      await shot('bud-popup-desktop');
      await composer.fill('Keep this draft while I look around');
      const backgroundComposer = page
        .getByRole('textbox', { name: 'Message', exact: true })
        .filter({ visible: true })
        .first();
      await backgroundComposer.click();
      await popup.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Open Bud', exact: true }).click();
      await popup.waitFor();
      assert.equal(
        await composer.innerText(),
        'Keep this draft while I look around',
        'outside click preserves the draft',
      );
      await dock.getByRole('button', { name: 'Minimize Bud', exact: true }).click();
      await popup.waitFor({ state: 'hidden' });
      await dock.getByRole('button', { name: 'Open Bud', exact: true }).click();
      assert.notEqual(await popup.getAttribute('aria-modal'), 'true', 'the page stays usable behind Bud');
      await composer.click();
      await emit('invalidated');
      assert.equal(await composer.innerText(), 'Keep this draft while I look around');
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Open Bud', exact: true }).click();
      assert.equal(await composer.innerText(), 'Keep this draft while I look around');
      await page.getByRole('button', { name: 'Open full chat', exact: true }).click();
      await page.waitForURL(`**/acme/chat/${chatId}`);
      assert.equal(await composer.innerText(), 'Keep this draft while I look around');
      assert.equal(await page.getByText(budGreeting, { exact: true }).count(), 1);
      assert.equal(
        await page.getByRole('button', { name: /^(Show|Hide) canvas/ }).count(),
        0,
        'full chat has no empty Canvas',
      );
      await page.getByRole('combobox', { name: /^Model:/ }).waitFor();
      await page.getByRole('button', { name: 'Add files and more', exact: true }).waitFor();
      await composer.fill('');
      await page.goBack();
      await page.getByRole('button', { name: 'Open Bud', exact: true }).click();
      state.preferences = [
        {
          id: randomUUID(),
          conversationId: chatId,
          topic: 'reply-style',
          question: 'How should I reply?',
          value: null,
          status: 'asking',
          expectedRevision: 0,
          savedRevision: null,
        },
      ];
      await emit('changed');
      await page.getByText('How should I reply?', { exact: true }).waitFor();
      await popup.getByRole('radio', { name: 'Short answers', exact: true }).check();
      assert.equal(
        commands.filter(command => command.kind === 'answer-preference').length,
        0,
        'selecting a style is not saving',
      );
      await popup.getByRole('radio', { name: 'Detailed answers', exact: true }).check();
      await shot('bud-reply-styles');
      await popup.getByRole('radio', { name: 'Custom', exact: true }).check();
      await page.getByLabel('Your preference').fill('Keep replies short.');
      failSave = true;
      await page.getByRole('button', { name: 'Save answer', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Your input is still here' }).first().waitFor();
      assert.equal(await page.getByLabel('Your preference').inputValue(), 'Keep replies short.');
      failSave = false;
      await page.getByRole('button', { name: 'Save answer', exact: true }).click();
      await page.getByText('Remembered for this workspace', { exact: true }).waitFor();
      for (const corner of ['top-right', 'top-left', 'bottom-left', 'bottom-right']) {
        await dragCorner(corner);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByText(budGreeting, { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const popup = document.querySelector('[role="dialog"][data-slot="popover-content"]');
        if (!popup) return false;
        const bounds = popup.getBoundingClientRect();
        return (
          bounds.width <= 374 &&
          bounds.height <= 480 &&
          bounds.x > 0 &&
          bounds.y > 0 &&
          bounds.right <= 390 &&
          bounds.bottom <= 844
        );
      });
      const bounds = await page.getByRole('dialog').boundingBox();
      await shot('bud-popup-phone-bounds');
      assert.ok(
        bounds &&
          bounds.width <= 374 &&
          bounds.height <= 480 &&
          bounds.x > 0 &&
          bounds.y > 0 &&
          bounds.x + bounds.width <= 390 &&
          bounds.y + bounds.height <= 844,
        `phone popup leaves the page visible and stays inside it: ${JSON.stringify(bounds)}`,
      );
      await shot('bud-popup-phone');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.getByText('Remembered for this workspace', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(state.bubblesEnabled, true, 'closing chat does not change bubble settings');
      await page.emulateMedia({ colorScheme: 'dark' });
      await shot('bud-popup-phone-dark');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      const homeComposer = page.getByRole('textbox', { name: 'Message', exact: true });
      await homeComposer.fill('I am still typing');
      state.nudge = {
        fingerprint: 'a'.repeat(64),
        suggestionId: 'index-github',
        question: 'Choose GitHub repositories for knowledge?',
        presented: false,
        action: { kind: 'open', destination: 'integrations', sourcePicker: 'github' },
      };
      await emit('changed');
      await delay(1200);
      assert.equal(
        commands.some(command => command.kind === 'present'),
        false,
        'typing holds the proactive bubble',
      );
      await homeComposer.evaluate(element => element.blur());
      await page.getByRole('region', { name: 'Bud suggestion' }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0, 'the question never opens chat by itself');
      await shot('bud-nudge');
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await page.getByRole('region', { name: 'Bud suggestion' }).waitFor({ state: 'hidden' });
      state.nudge = {
        fingerprint: 'b'.repeat(64),
        suggestionId: 'personalize-bud',
        question: 'Would you like to set how Bud replies to you?',
        presented: true,
        action: {
          kind: 'prompt',
          prompt:
            'Ask me how I want you to reply, using bud.preference.ask for reply-style. Ask only one short question.',
        },
      };
      await emit('changed');
      failNudge = true;
      await page.getByRole('button', { name: "Let's do it", exact: true }).click();
      await dock.getByRole('alert').waitFor();
      assert.equal(await popup.count(), 0, 'failed acceptance does not pretend to start chat');
      failNudge = false;
      await page.getByRole('button', { name: "Let's do it", exact: true }).click();
      await popup.waitFor();
      await popup.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
      assert.equal(history.at(-1).author, 'human');
      const preferenceTurn = history.at(-1).turn;
      preferenceTurn.status = 'completed';
      state.preferences = [
        {
          id: randomUUID(),
          conversationId: chatId,
          topic: 'reply-style',
          question: 'Which reply style works for you?',
          value: null,
          status: 'asking',
          expectedRevision: 2,
          savedRevision: null,
        },
      ];
      await emit('changed');
      await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
      await popup.getByRole('radio', { name: 'Short answers', exact: true }).waitFor();
      for (const width of [320, 375, 414, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: width === 375 ? 'dark' : 'light' });
        await page.waitForFunction(async width => {
          for (let frame = 0; frame < 3; frame++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            const element = document.querySelector('[data-slot="popover-content"][data-size="bud"]');
            const panel = element.getBoundingClientRect();
            if (
              panel.width !== Math.min(384, width - 32) ||
              panel.left < 0 ||
              panel.right > width ||
              panel.top < 0 ||
              panel.bottom > innerHeight
            )
              return false;
            if (document.documentElement.scrollWidth > innerWidth) return false;
            if (getComputedStyle(element).color !== (width === 375 ? 'rgb(255, 255, 255)' : 'rgb(27, 27, 27)'))
              return false;
          }
          return true;
        }, width);
        const layout = await page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          overflowing: [...document.body.querySelectorAll('*')]
            .filter(
              element =>
                element.getBoundingClientRect().right > innerWidth &&
                element.getClientRects().length &&
                getComputedStyle(element).visibility !== 'hidden',
            )
            .slice(0, 12)
            .map(element => ({
              tag: element.tagName,
              slot: element.getAttribute('data-slot'),
              class: element.className,
              right: element.getBoundingClientRect().right,
            })),
        }));
        assert.ok(layout.scrollWidth <= layout.width, JSON.stringify(layout));
        await shot(`bud-styles-${width}`);
      }
      await popup.getByRole('radio', { name: 'Short answers', exact: true }).check();
      await popup.getByRole('button', { name: 'Save answer', exact: true }).click();
      await popup.getByText('Remembered for this workspace', { exact: true }).waitFor();
      assert.equal(state.preferences[0].value, 'Keep replies short and direct. Lead with the answer.');
      await popup.getByRole('button', { name: 'Undo', exact: true }).click();
      await popup.getByText('Remembered for this workspace', { exact: true }).waitFor({ state: 'hidden' });
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      const launcher = page.getByRole('button', { name: 'Open Bud', exact: true });
      await launcher.hover();
      await page.mouse.down();
      await page.mouse.move(40, 40, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(async () => {
        const element = document.querySelector('[aria-label="Bud assistant"]');
        if (element?.getAttribute('data-corner') !== 'top-left') return false;
        const before = element.getBoundingClientRect();
        await new Promise(requestAnimationFrame);
        const after = element.getBoundingClientRect();
        return (
          getComputedStyle(element).transform === 'none' &&
          ['x', 'y', 'width', 'height'].every(key => before[key] === after[key]) &&
          after.width > 0 &&
          after.height > 0 &&
          after.x >= 0 &&
          after.y >= 0 &&
          after.right <= innerWidth &&
          after.bottom <= innerHeight
        );
      });
      assert.equal(await dock.getAttribute('data-corner'), 'top-left', 'drag snaps to the closest corner');
      assert.equal(await popup.count(), 0, 'drag does not open chat');
      await page.reload();
      await launcher.waitFor();
      assert.equal(await dock.getAttribute('data-corner'), 'top-left', 'corner survives a page reload');
      await launcher.click();
      await popup.waitFor();
      await page.getByText(budGreeting, { exact: true }).waitFor();
      await shot('bud-popup-top-left');
      await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        window.restoreBudStorage = () => {
          Storage.prototype.setItem = original;
        };
        Storage.prototype.setItem = function (key, value) {
          if (key === 'tulipfarm:bud-corner')
            throw new DOMException('Fixture storage unavailable', 'QuotaExceededError');
          return original.call(this, key, value);
        };
      });
      await dragCorner('bottom-left', false);
      await page.getByRole('alert').filter({ hasText: 'could not save its position' }).waitFor();
      assert.equal(await dock.getAttribute('data-corner'), 'bottom-left');
      await page.evaluate(() => window.restoreBudStorage());
      await page.getByRole('button', { name: 'Save position again' }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem('tulipfarm:bud-corner')), 'bottom-left');
      await page.getByRole('alert').filter({ hasText: 'could not save its position' }).waitFor({ state: 'hidden' });
      await composer.fill('Give me one quick next step');
      failSend = true;
      await popup.getByRole('button', { name: 'Send message', exact: true }).click();
      await popup.getByRole('alert').filter({ hasText: 'server rejected this input' }).waitFor();
      assert.equal(await composer.innerText(), 'Give me one quick next step', 'failed sends retain the draft');
      failSend = false;
      await popup.getByRole('button', { name: 'Refresh before editing', exact: true }).click();
      await popup.getByRole('button', { name: 'Review retained input', exact: true }).click();
      await popup.getByRole('button', { name: 'Send message', exact: true }).click();
      await popup.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
      assert.equal(sends.length, 1);
      assert.equal(sends[0].parts[0].text, 'Give me one quick next step');
      const turn = history.at(-1).turn;
      await page.evaluate(
        ({ turnId, toolId }) =>
          window.budChatEvent({
            event: 'tool',
            data: {
              turnId,
              generation: 0,
              epoch: 1,
              id: toolId,
              tool: 'rows.get',
              sequence: 1,
              status: 'running',
              presentation: { label: 'Reading a row', brand: null },
            },
          }),
        { turnId: turn.id, toolId: randomUUID() },
      );
      await popup.getByRole('button', { name: /Working… Reading a row/ }).click();
      await popup.getByText('Reading a row', { exact: true }).waitFor();
      assert.equal(await popup.locator('[data-slot="canvas"]').count(), 0, 'tool activity cannot open Canvas');
      assert.equal(new URL(page.url()).pathname, '/acme', 'background work stays in the popup');
      await page.evaluate(
        turnId =>
          window.budChatEvent({
            event: 'text',
            data: {
              turnId,
              generation: 0,
              epoch: 1,
              step: 0,
              seq: 0,
              offset: 0,
              text: 'Start with your next task.',
              reset: true,
            },
          }),
        turn.id,
      );
      await popup.getByText('Start with your next task.', { exact: true }).waitFor();
      turn.status = 'completed';
      history.push({
        id: randomUUID(),
        sequence: history.length + 1,
        author: 'assistant',
        createdAt: new Date().toISOString(),
        parts: [{ kind: 'text', text: 'Start with your next task.' }],
        turn: null,
      });
      await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
      await popup.getByRole('button', { name: 'Stop reply', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await popup.getByText('Start with your next task.', { exact: true }).count(), 1);
      approval = {
        id: randomUUID(),
        turnId: turn.id,
        revision: 1,
        prompt: 'Remove the unused field?',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        resolution: null,
        action: {
          kind: 'table-migration',
          migrationId: randomUUID(),
          tableId: randomUUID(),
          planDigest: 'a'.repeat(64),
          expectedAppliedRevision: null,
          effect: { kind: 'drop-field', tableId: randomUUID(), fieldId: randomUUID(), rowCount: 4 },
        },
      };
      history.push({
        id: randomUUID(),
        sequence: history.length + 1,
        author: 'assistant',
        createdAt: new Date().toISOString(),
        parts: [{ kind: 'approval', approvalId: approval.id }],
        turn: null,
      });
      await notifyChange(page, workspace.id, 'ada', 'detail', chatId);
      await popup.getByRole('button', { name: 'Approve action', exact: true }).waitFor();
      assert.equal(decisions.length, 0, 'showing a proposal never approves it');
      await popup.getByRole('button', { name: 'Decline', exact: true }).click();
      assert.equal(decisions.length, 1, 'decline submits one decision');
      await popup.getByText('The proposed action was declined.', { exact: true }).waitFor();
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].decision, 'reject');
      assert.equal(decisions[0].expectedRevision, 1);
      assert.equal(new URL(page.url()).pathname, '/acme', 'approval is handled inline');
      history.push({
        id: randomUUID(),
        sequence: history.length + 1,
        author: 'assistant',
        createdAt: new Date().toISOString(),
        parts: [
          {
            kind: 'text',
            text: Array.from(
              { length: 30 },
              (_, index) => `Example step ${index + 1}: review the saved workflow before making changes.`,
            ).join('\n\n'),
          },
        ],
        turn: null,
      });
      await page.evaluate(() => localStorage.setItem('tulipfarm:bud-corner', 'invalid-corner'));
      await page.reload();
      await launcher.click();
      await page.getByRole('alert').filter({ hasText: 'Saved Bud position is invalid' }).waitFor();
      await page.getByRole('button', { name: 'Save position again' }).click();
      const transcript = popup.getByRole('region', { name: 'Conversation', exact: true });
      await page
        .getByText('Example step 30: review the saved workflow before making changes.', { exact: true })
        .waitFor();
      assert.ok(
        await transcript.evaluate(element => element.scrollHeight > element.clientHeight),
        'long chat scrolls inside the popup',
      );
      await transcript.evaluate(element => {
        element.scrollTop = 0;
      });
      assert.equal(await transcript.evaluate(element => element.scrollTop), 0);
      const composerBounds = await composer.boundingBox(),
        popupBounds = await popup.boundingBox();
      assert.ok(
        composerBounds.y >= popupBounds.y &&
          composerBounds.y + composerBounds.height <= popupBounds.y + popupBounds.height,
        'composer stays inside the popup while history scrolls',
      );
      assert.equal(commands.filter(command => command.kind === 'bootstrap').length, 1);
      await composer.fill('Keep this draft on the calendar');
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'hidden' });
      const savedCorner = await dock.getAttribute('data-corner');
      await page.locator('a[href="/acme/calendar"]').click();
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Bud assistant"]')?.getAttribute('data-corner') === 'header',
      );
      assert.equal(await page.locator('[aria-label="Workspace header"] [aria-label="Bud assistant"]').count(), 1);
      await launcher.click();
      await popup.waitFor();
      assert.equal(
        await composer.innerText(),
        'Keep this draft on the calendar',
        'docking keeps the same conversation and draft',
      );
      await shot('bud-calendar-docked');
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'hidden' });
      await page.locator('a[href="/acme"]').first().click();
      await page.waitForFunction(
        corner => document.querySelector('[aria-label="Bud assistant"]')?.getAttribute('data-corner') === corner,
        savedCorner,
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem('tulipfarm:bud-corner')),
        savedCorner,
        'calendar docking never overwrites the saved floating corner',
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      if (page && screenshots) await page.screenshot({ path: `${screenshots}/failure.png` });
      throw error;
    } finally {
      try {
        if (cdp) execFileSync('agent-browser', ['--session', 'bud-proof', 'close'], { stdio: 'inherit' });
      } finally {
        try {
          await browser?.close();
        } finally {
          vite.kill('SIGTERM');
        }
      }
    }
  },
);
