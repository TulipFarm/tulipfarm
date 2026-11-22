import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

test(
  'compaction dividers preserve history, saved recaps stay quiet, and Knowledge recovery still works',
  { timeout: 120000 },
  async () => {
    const { workspace, session } = createWorkspaceFixture({ slug: 'chat-recap-qa', name: 'Chat recap QA' });
    const chatId = randomUUID(),
      compactionId = randomUUID();
    const now = new Date().toISOString();
    const chat = {
      id: chatId,
      title: 'Support handoff',
      titleRevision: 1,
      titleManual: true,
      archived: false,
      isClosed: true,
      activityAt: now,
      createdAt: now,
      projectId: null,
    };
    let maintenance = {
      id: randomUUID(),
      generation: 1,
      coveredThrough: 1,
      state: 'blocked',
      errorCode: 'credits-exhausted',
      retryAt: null,
      compactionId,
      embeddingStatus: null,
    };
    const recap =
      '## Decisions\n\nUse the support inbox for new requests.\n\n## Open work\n\nReview the first week of response times.';
    const detail = {
      id: compactionId,
      trigger: 'inactivity',
      state: 'compacted',
      createdAt: now,
      coveredThrough: 1,
      beforeTokens: 1200,
      afterTokens: 200,
      windowTokens: 10000,
      triggerPercent: 70,
      targetPercent: 30,
      modelFamilyId: null,
      fallbackFromFamilyId: null,
      errorCode: null,
      cleanedMessages: 0,
      handoff: {
        status: 'completed',
        text: recap,
        prompt: null,
        modelFamilyId: null,
        fallbackFromFamilyId: null,
        errorCode: null,
        attempts: 1,
      },
    };
    const messages = [
      {
        id: randomUUID(),
        sequence: 1,
        author: 'human',
        createdAt: now,
        parts: [{ kind: 'text', text: 'Plan the support handoff.' }],
        turn: { id: randomUUID(), status: 'completed', generation: 0 },
        tools: [],
      },
      {
        id: randomUUID(),
        sequence: 2,
        author: 'assistant',
        createdAt: now,
        parts: [
          {
            kind: 'compaction',
            compactionId,
            trigger: 'inactivity',
            state: 'compacted',
            beforeTokens: 1200,
            afterTokens: 200,
            windowTokens: 10000,
            errorCode: null,
            handoffStatus: 'completed',
          },
        ],
        turn: null,
        tools: [],
      },
    ];
    for (const trigger of ['automatic', 'manual'])
      messages.push({
        ...messages[1],
        id: randomUUID(),
        sequence: messages.length + 1,
        parts: [{ ...messages[1].parts[0], compactionId: randomUUID(), trigger }],
      });
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const browser = await chromium.launch({
      args: process.env.CHAT_MAINTENANCE_CDP_PORT
        ? [`--remote-debugging-port=${process.env.CHAT_MAINTENANCE_CDP_PORT}`]
        : [],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    const errors = [],
      commands = [],
      sends = [];
    const browserSession = `chat-maintenance-${chatId}`;
    let captured = false;
    let failRead = true,
      failWrite = true,
      detailReads = 0,
      holdRead = null;
    try {
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        let json;
        if (path === '/v1/auth/get-session') json = session;
        else if (path === '/v1/user/visit') json = { firstSession: false };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path.endsWith('/governance/me')) json = membership;
        else if (path.endsWith('/credits')) json = credits;
        else if (path.endsWith('/model-catalog')) json = chatCatalog;
        else if (path.endsWith('/google-workspace/availability')) json = { configured: false };
        else if (path.endsWith('/google-workspace')) json = { status: 'disconnected' };
        else if (path.endsWith('/projects') || path.endsWith('/candidates')) json = [];
        else if (path.endsWith('/conversations')) json = { chats: [chat], nextCursor: null };
        else if (path.endsWith(`/conversations/${chatId}/messages`))
          json = { messages, nextBefore: null, hasGitHubProposals: false };
        else if (path.includes(`/conversations/${chatId}/messages/`) && request.method() === 'PUT') {
          sends.push(request.postDataJSON());
          return route.fulfill({ status: 400, json: { error: 'unexpected-user-turn' } });
        } else if (path.endsWith(`/conversations/${chatId}`)) json = chat;
        else if (path.endsWith(`/compactions/${compactionId}`)) {
          detailReads++;
          json = detail;
        } else if (path.endsWith(`/conversations/${chatId}/maintenance`)) {
          if (request.method() === 'PUT') {
            commands.push(request.postDataJSON());
            if (failWrite) {
              failWrite = false;
              return route.abort();
            }
            maintenance = { ...maintenance, state: 'queued', errorCode: null };
          } else if (failRead) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
          else if (holdRead) await holdRead;
          json = { maintenance };
        } else return route.fulfill({ status: 404, json: { error: 'not-found' } });
        return route.fulfill({ json });
      });
      const load = () => page.goto(`${server.resolvedUrls.local[0]}${workspace.slug}/chat/${chatId}`);
      await load();
      const history = page.getByRole('list', { name: 'Messages' });
      const status = page.getByRole('region', { name: 'Chat Knowledge status' });
      const automatic = history.getByRole('separator', { name: 'Auto compacted', exact: true });
      const manual = history.getByRole('separator', { name: 'Compacted', exact: true });
      await history.getByText('Plan the support handoff.', { exact: true }).waitFor();
      await manual.waitFor();
      assert.equal(
        await automatic.count(),
        2,
        'inactivity and context-triggered compactions share the automatic label',
      );
      assert.equal(await manual.count(), 1);
      assert.equal(await history.getByText('Use the support inbox for new requests.').count(), 0);
      assert.equal(await history.getByRole('button', { name: /View handoff|View details/ }).count(), 0);
      assert.equal(detailReads, 0, 'completed dividers do not fetch recap content');
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme });
        for (const width of [375, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          const geometry = await manual.evaluate(element => {
            const rect = element.getBoundingClientRect(),
              label = element.querySelector('span').getBoundingClientRect();
            return {
              height: rect.height,
              centered: Math.abs((rect.left + rect.right) / 2 - (label.left + label.right) / 2),
              before: getComputedStyle(element, '::before').backgroundImage,
              after: getComputedStyle(element, '::after').backgroundImage,
              overflow: document.documentElement.scrollWidth > window.innerWidth,
            };
          });
          assert.ok(geometry.height <= 24, 'divider remains a single quiet line');
          assert.ok(geometry.centered < 1, 'label is centered between equal rules');
          assert.match(geometry.before, /linear-gradient/);
          assert.match(geometry.after, /linear-gradient/);
          assert.equal(geometry.overflow, false);
        }
        const shine = manual.locator('.sprout-separator-fade-shine');
        await manual.hover();
        assert.equal(
          await shine.evaluate(element => getComputedStyle(element).animationName),
          'none',
          'reduced motion disables the hover shine',
        );
        await page.mouse.move(0, 0);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await manual.hover();
        const animation = await shine.evaluate(element => {
          const style = getComputedStyle(element);
          return {
            name: style.animationName,
            duration: style.animationDuration,
            iterations: style.animationIterationCount,
          };
        });
        assert.deepEqual(animation, { name: 'sprout-separator-fade-shine', duration: '0.65s', iterations: '1' });
        await page.waitForFunction(() => {
          const element = document.querySelector('[aria-label="Compacted"] .sprout-separator-fade-shine');
          return (
            element &&
            element.getAnimations().every(animation => animation.playState === 'finished') &&
            getComputedStyle(element).opacity === '0'
          );
        });
        await page.mouse.move(0, 0);
        await manual.hover();
        // :hover restarts the animation on a later style recalculation, so wait for it instead of reading once.
        await shine.evaluate(
          element =>
            new Promise((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('leaving and hovering again replays the shine')), 2000);
              const check = () => {
                if (element.getAnimations().some(animation => animation.playState === 'running')) {
                  clearTimeout(timeout);
                  resolve();
                } else requestAnimationFrame(check);
              };
              check();
            }),
        );
        await page.mouse.move(0, 0);
        await page.emulateMedia({ reducedMotion: 'reduce' });
      }
      const saved = page.getByRole('separator', { name: 'Saved to Knowledge', exact: true });
      const silent = async reason => {
        await history.getByText('Plan the support handoff.', { exact: true }).waitFor();
        assert.equal(await status.count(), 0, reason);
        assert.equal(await saved.count(), 0, reason);
      };
      await status.getByRole('button', { name: 'Check Knowledge status' }).waitFor();
      assert.equal(await status.getByRole('status').count(), 1, 'a status-check failure is one quiet line');
      assert.equal(await page.getByRole('alert').count(), 0);
      failRead = false;
      await status.getByRole('button', { name: 'Check Knowledge status' }).click();
      await status
        .getByText('Workspace credits are unavailable. Work will continue when credits are available.')
        .waitFor();
      await status.getByRole('button', { name: 'Resume Knowledge update' }).click();
      await status.getByRole('button', { name: 'Try again', exact: true }).waitFor();
      await status.getByRole('button', { name: 'Try again', exact: true }).click();
      await status.waitFor({ state: 'detached' });
      assert.equal(commands.length, 2);
      assert.equal(commands[0].commandId, commands[1].commandId, 'an uncertain resume keeps its command identity');
      assert.equal(sends.length, 0, 'resuming maintenance never creates a human chat turn');
      await silent('a queued recap shows nothing');
      maintenance = { ...maintenance, state: 'publishing' };
      await page.waitForTimeout(500);
      await silent('a publishing recap shows nothing');
      maintenance = { ...maintenance, state: 'ready', embeddingStatus: 'disabled' };
      await saved.waitFor();
      assert.equal(
        await saved.evaluate(divider => {
          const list = document.querySelector('[aria-label="Messages"]');
          return !!(list.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING);
        }),
        true,
        'the saved divider sits after the last message',
      );
      assert.equal(await page.getByText(/You can keep replying here/).count(), 0);
      if (process.env.CHAT_MAINTENANCE_SCREENSHOT) {
        if (process.env.CHAT_MAINTENANCE_CDP_PORT) {
          await promisify(execFile)('agent-browser', [
            '--session',
            browserSession,
            '--cdp',
            process.env.CHAT_MAINTENANCE_CDP_PORT,
            'screenshot',
            process.env.CHAT_MAINTENANCE_SCREENSHOT,
          ]);
          captured = true;
        } else await page.screenshot({ path: process.env.CHAT_MAINTENANCE_SCREENSHOT });
      }
      maintenance = { ...maintenance, state: 'ready', embeddingStatus: 'credits-blocked' };
      await load();
      await status.getByText('Saved to Knowledge. Semantic search is paused; keyword search works.').waitFor();
      await status.getByRole('button', { name: 'Resume semantic search' }).click();
      await status.waitFor({ state: 'detached' });
      assert.equal(commands.length, 3, 'semantic recovery uses the maintenance command rather than a chat turn');
      maintenance = { ...maintenance, state: 'failed', errorCode: null, embeddingStatus: null };
      await load();
      await status.getByText('Could not save this chat to Knowledge yet. It will retry in the background.').waitFor();
      assert.equal(await page.getByRole('alert').count(), 0, 'a failed recap is a quiet line, not an alert');
      await status.getByRole('button', { name: 'Resume Knowledge update' }).click();
      await status.waitFor({ state: 'detached' });
      assert.equal(commands.length, 4, 'resume works from the failed line');
      maintenance = { ...maintenance, state: 'blocked', errorCode: 'generation-unconfirmed' };
      await load();
      await status.getByText(/Automatic retries are paused to avoid charging twice/).waitFor();
      assert.equal(await status.getByRole('button', { name: 'Resume Knowledge update' }).count(), 0);
      maintenance = { ...maintenance, state: 'running', errorCode: null };
      await load();
      await silent('a running recap shows nothing');
      const job = maintenance;
      maintenance = null;
      await load();
      await silent('a chat without a recap job shows nothing');
      let release;
      holdRead = new Promise(resolve => {
        release = resolve;
      });
      maintenance = { ...job, state: 'ready', embeddingStatus: 'ready' };
      await load();
      await silent('nothing shows while the status loads');
      release();
      holdRead = null;
      await saved.waitFor();
      chat.isClosed = false;
      maintenance = { ...maintenance, state: 'stale', errorCode: null };
      await load();
      await automatic.first().waitFor();
      await silent('an active chat shows no Knowledge status');
      assert.equal(await page.getByText(/This chat is active/).count(), 0);
      detail.handoff.text = null;
      await load();
      await automatic.first().waitFor();
      assert.equal(await history.getByText('Use the support inbox for new requests.').count(), 0);
      assert.equal(detailReads, 0, 'source-restricted recaps remain unread and undisclosed');
      assert.equal(await history.getByText('Plan the support handoff.', { exact: true }).count(), 1);
      await page.setViewportSize({ width: 375, height: 812 });
      await page.emulateMedia({ colorScheme: 'dark' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      messages[1].parts[0].handoffStatus = 'pending';
      detail.handoff.status = 'pending';
      await load();
      await automatic.first().waitFor();
      await page.waitForTimeout(500);
      assert.equal(await automatic.count(), 1, 'pending inactivity recap is not marked complete');
      assert.equal(await history.getByText('Preparing recap...', { exact: true }).count(), 0);
      detail.handoff.status = 'completed';
      await automatic.nth(1).waitFor();
      assert.equal(await automatic.count(), 2, 'pending recap becomes a divider when completion is confirmed');
      messages[1].parts[0].state = 'failed';
      messages[1].parts[0].handoffStatus = 'failed';
      detail.state = 'failed';
      detail.handoff.status = 'failed';
      await load();
      await history
        .getByRole('status')
        .filter({ hasText: 'The automatic recap could not be completed. Your messages are unchanged.' })
        .waitFor();
      assert.equal(await automatic.count(), 1, 'failed attempt is not shown as a successful compaction');
      assert.deepEqual(errors, []);
    } finally {
      try {
        if (captured) await promisify(execFile)('agent-browser', ['--session', browserSession, 'close']);
      } finally {
        await browser.close();
        await server.close();
      }
    }
  },
);
