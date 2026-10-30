import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';

test(
  'choice questions live above the composer and retain answers through retries, reload and skip',
  { timeout: 90000 },
  async () => {
    const port = 5778,
      origin = `http://127.0.0.1:${port}`;
    const { workspace, session } = createWorkspaceFixture({ slug: 'choices-qa', name: 'Choices QA' });
    const membershipId = randomUUID(),
      chatId = randomUUID(),
      turnId = randomUUID(),
      requestId = randomUUID();
    const view = {
      id: requestId,
      turnId,
      revision: 1,
      prompt: 'Who should send the Slack message?',
      expiresAt: '2099-10-11T00:00:00Z',
      answerSchema: {
        kind: 'choices',
        multiple: false,
        allowText: true,
        choices: [
          { id: 'app', label: 'TulipFarm app (Recommended)' },
          { id: 'personal', label: 'My personal Slack account' },
        ],
      },
      status: 'pending',
      response: null,
    };
    const tools = ['skills.read', 'skills.read', 'workflows.list', 'slack.resolve', 'present.choice'].map(tool => ({
      id: randomUUID(),
      tool,
      status: 'completed',
    }));
    const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
    });
    let browser;
    try {
      for (
        let attempt = 0;
        !(await fetch(origin).then(
          response => response.ok,
          () => false,
        ));
        attempt++
      ) {
        assert.ok(attempt < 150 && server.exitCode === null, 'Vite starts');
        await delay(100);
      }
      browser = await chromium.launch({
        args: process.env.CHOICES_CDP_PORT ? [`--remote-debugging-port=${process.env.CHOICES_CDP_PORT}`] : [],
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      const errors = [],
        answers = [];
      let failRead = true,
        failWrite = 'lost';
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        let json;
        if (path === '/v1/auth/get-session') json = session;
        else if (path === '/v1/user/visit') json = { firstSession: false };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path.endsWith('/governance/me'))
          json = { membershipId, role: 'member', teams: [], capabilities: { manageGovernance: false, canLeave: true } };
        else if (path.endsWith('/model-catalog')) json = chatCatalog;
        else if (path.endsWith('/slack/status'))
          json = { state: 'active', teamId: 'TCHOICES', canManage: false, linked: true, scopes: [] };
        else if (path.includes(`/requests/${requestId}`)) {
          if (request.method() === 'GET') {
            if (failRead) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
            json = view;
          } else {
            const body = request.postDataJSON();
            answers.push(body);
            await delay(300);
            if (failWrite) {
              const failure = failWrite;
              failWrite = null;
              return failure === 'lost' ? route.abort() : route.fulfill({ status: 409, json: { error: 'conflict' } });
            }
            view.status = path.endsWith('/cancel') ? 'cancelled' : 'answered';
            view.response =
              view.status === 'answered'
                ? { id: path.split('/').at(-1), answer: body.answer, createdAt: workspace.createdAt }
                : null;
            json = { requestId, revision: 1, status: view.status, responseId: view.response?.id ?? null };
          }
        } else if (path.endsWith('/messages'))
          json = {
            messages: [
              {
                id: turnId,
                sequence: 1,
                author: 'human',
                createdAt: workspace.createdAt,
                parts: [{ kind: 'text', text: 'Set up my Slack workflow.' }],
                turn: { id: turnId, status: view.status === 'pending' ? 'waiting' : 'completed', generation: 0 },
                tools,
              },
              {
                id: requestId,
                sequence: 2,
                author: 'assistant',
                createdAt: workspace.createdAt,
                parts: [{ kind: 'request', requestId }],
                turn: null,
                tools: [],
              },
              ...(view.response
                ? [
                    {
                      id: view.response.id,
                      sequence: 3,
                      author: 'human',
                      createdAt: workspace.createdAt,
                      parts: [{ kind: 'response', responseId: view.response.id }],
                      turn: null,
                      tools: [],
                    },
                  ]
                : []),
            ],
            nextBefore: null,
            hasGitHubProposals: false,
          };
        else if (path.endsWith(`/conversations/${chatId}`))
          json = {
            id: chatId,
            title: 'Set up Slack messages',
            titleRevision: 1,
            archived: false,
            activityAt: workspace.createdAt,
            createdAt: workspace.createdAt,
          };
        else if (path.endsWith('/tables')) json = { tables: [], nextCursor: null };
        else return route.fulfill({ status: 404, json: { error: 'not-found' } });
        return route.fulfill({ json });
      });
      const load = () => page.goto(`${origin}/${workspace.slug}/chat/${chatId}`);
      const dock = page.getByRole('region', { name: 'Questions', exact: true });
      const answered = text => page.locator('[data-slot="choice-summary"]').getByText(text, { exact: true }).waitFor();
      await load();
      await dock.getByRole('button', { name: 'Retry loading request' }).waitFor();
      failRead = false;
      await dock.getByRole('button', { name: 'Retry loading request' }).click();
      const recommended = dock.getByRole('radio', { name: /TulipFarm app.*Recommended/ });
      await recommended.waitFor();
      const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
      assert.equal(await canvas.count(), 0, 'questions do not open a result view');
      const activity = page
        .getByRole('region', { name: 'Conversation', exact: true })
        .locator('[data-slot="tool-activity"]');
      await activity.getByRole('button', { expanded: false }).click();
      assert.equal(await activity.locator('[data-tool-id]').count(), 3, 'chat activity excludes both skill reads');
      assert.equal(await page.getByRole('button', { name: /Hide canvas/ }).count(), 0);
      assert.equal(
        await page
          .getByRole('region', { name: 'Conversation', exact: true })
          .getByRole('radio', { name: /TulipFarm app/ })
          .count(),
        0,
      );
      assert.equal(await recommended.isChecked(), false, 'recommendation does not choose an answer');
      assert.equal(await dock.getByRole('button', { name: 'Continue', exact: true }).isEnabled(), true);
      await dock.getByRole('button', { name: 'Continue', exact: true }).click();
      await dock.getByText('Choose an answer.', { exact: true }).waitFor();
      assert.equal(
        await recommended.evaluate(element => element === document.activeElement),
        true,
        'invalid submit focuses the first answer',
      );
      assert.equal(answers.length, 0, 'validation does not send a command');
      assert.equal(await dock.getByText('Response needed', { exact: true }).count(), 0);
      assert.equal(
        await dock.getByRole('button', { name: 'Details', exact: true }).count(),
        0,
        'routine request details are absent',
      );
      const rows = dock.locator(
        '[data-slot="choice-list"] label[data-recommended], [data-slot="choice-list"] label:has(input[type="radio"])',
      );
      assert.equal(await rows.count(), 2, 'custom answer does not take a row until requested');
      assert.equal(await dock.getByRole('textbox', { name: 'Your answer' }).count(), 0);
      const rowStyle = await rows.evaluateAll(elements =>
        elements.map(element => {
          const style = getComputedStyle(element);
          return {
            border: style.borderTopColor,
            radius: style.borderRadius,
            width: element.getBoundingClientRect().width,
          };
        }),
      );
      assert.equal(rowStyle[0].border, rowStyle[1].border, 'recommendation does not imitate a selection');
      assert.equal(rowStyle[0].radius, rowStyle[1].radius);
      assert.equal(rowStyle[0].width, rowStyle[1].width, 'answer rows share one reading edge');
      assert.equal(
        await rows.first().locator('[data-slot="badge"][data-variant="info"]').textContent(),
        'Recommended',
        'recommendation has a distinct info badge',
      );
      const input = page.locator('[contenteditable="true"]').first();
      const questionBox = await dock.boundingBox(),
        inputBox = await input.boundingBox();
      assert.ok(questionBox.y + questionBox.height <= inputBox.y, 'options are immediately above composer');
      if (process.env.CHOICES_SCREENSHOT) {
        if (process.env.CHOICES_CDP_PORT)
          await promisify(execFile)('agent-browser', [
            '--cdp',
            process.env.CHOICES_CDP_PORT,
            'screenshot',
            process.env.CHOICES_SCREENSHOT,
          ]);
        else await page.screenshot({ path: process.env.CHOICES_SCREENSHOT });
      }
      const custom = dock.getByRole('textbox', { name: 'Your answer', exact: true });
      await dock.getByRole('button', { name: 'Other answer', exact: true }).click();
      assert.equal(
        await custom.evaluate(element => element === document.activeElement),
        true,
        'opening Other focuses its input',
      );
      await custom.fill('Keep this draft.');
      await recommended.check();
      assert.equal(await custom.count(), 0, 'switching to a choice collapses the custom input');
      await dock.getByRole('button', { name: 'Other answer', exact: true }).click();
      assert.equal(await custom.inputValue(), 'Keep this draft.', 'reopening Other retains the draft');
      assert.equal(await recommended.count(), 1, 'listed options remain available while typing a custom answer');
      assert.equal(await recommended.isChecked(), false, 'typing is an alternative to the selected choices');
      await custom.fill('   ');
      await dock.getByRole('button', { name: 'Continue', exact: true }).click();
      await dock.getByText('Enter your answer.', { exact: true }).waitFor();
      assert.equal(answers.length, 0, 'blank custom answer is not submitted');
      await recommended.check();
      await dock.getByRole('button', { name: 'Continue', exact: true }).click();
      assert.equal(await recommended.isDisabled(), true, 'pending writes lock the answer options');
      await dock.getByRole('button', { name: 'Retry same response' }).click();
      await answered('TulipFarm app (Recommended)');
      assert.deepEqual(answers[0], answers[1], 'retry keeps command and answer');
      assert.deepEqual(answers[1].answer, { kind: 'choices', choiceIds: ['app'] });
      await load();
      await answered('TulipFarm app (Recommended)');
      assert.equal(await dock.getByRole('button', { name: 'Continue', exact: true }).count(), 0);
      assert.equal(await page.getByText('Your answer was recorded.', { exact: true }).count(), 0);
      assert.equal(
        await page.getByText('A response was recorded', { exact: false }).count(),
        0,
        'a response-only message is not rendered',
      );
      view.status = 'pending';
      view.response = null;
      await load();
      await dock.getByRole('button', { name: 'Other answer', exact: true }).click();
      await dock.getByRole('textbox', { name: 'Your answer' }).fill('Use a different channel first.');
      failRead = true;
      await dock.getByText('Could not refresh this request.', { exact: false }).waitFor();
      assert.equal(await custom.inputValue(), 'Use a different channel first.');
      assert.equal(await dock.getByRole('button', { name: 'Continue', exact: true }).isDisabled(), true);
      await dock
        .locator('[data-slot="request-status"]')
        .getByText('Could not check this request', { exact: true })
        .waitFor();
      failRead = false;
      await dock.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('[data-slot="choice-text"] textarea')?.disabled);
      await dock.getByRole('button', { name: 'Continue', exact: true }).click();
      await answered('Use a different channel first.');
      assert.deepEqual(answers.at(-1).answer, { kind: 'text', text: 'Use a different channel first.' });
      view.status = 'pending';
      view.response = null;
      await load();
      await recommended.check();
      failWrite = 'rejected';
      await dock.getByRole('button', { name: 'Continue', exact: true }).click();
      await dock.getByText('This request or proposal changed.', { exact: false }).waitFor();
      await dock.getByRole('button', { name: 'Review retained response' }).click();
      assert.equal(await recommended.isChecked(), true, 'rejected answers survive status review without Details');
      await dock.getByRole('button', { name: 'Continue', exact: true }).click();
      await answered('TulipFarm app (Recommended)');
      view.status = 'pending';
      view.response = null;
      await page.clock.install();
      await load();
      await recommended.waitFor();
      await page.clock.runFor(61_000);
      await dock.getByText('Automatic status checks paused', { exact: true }).waitFor();
      const footer = dock.locator('[data-slot="form-footer"]');
      assert.equal(
        await footer.getByRole('button', { name: 'Details', exact: true }).count(),
        0,
        'request details stay outside answer controls',
      );
      assert.equal(
        await footer.getByRole('button', { name: 'Try again', exact: true }).count(),
        0,
        'polling recovery stays outside answer controls',
      );
      assert.equal(
        await dock
          .locator('[data-slot="request-status"]')
          .getByText('Automatic status checks paused', { exact: true })
          .isVisible(),
        true,
      );
      assert.equal(
        await dock.locator('[data-slot="request-status"]').getByRole('button', { name: 'Try again' }).isVisible(),
        true,
      );
      assert.equal(
        await dock.getByRole('button', { name: 'Continue', exact: true }).isEnabled(),
        true,
        'paused polling does not block an answer',
      );
      assert.equal(await dock.getByRole('button', { name: 'Details', exact: true }).count(), 0);
      assert.equal(await canvas.count(), 0);
      await page.setViewportSize({ width: 375, height: 844 });
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.clock.runFor(1000);
      assert.equal(await custom.count(), 0, 'custom answer also starts collapsed on mobile');
      assert.equal(
        await rows.nth(1).evaluate(element => getComputedStyle(element).borderTopColor),
        await rows.first().evaluate(element => getComputedStyle(element).borderTopColor),
        'recommendation does not imitate selection in dark mode',
      );
      assert.equal(
        await rows
          .first()
          .evaluate(element => getComputedStyle(element).color === getComputedStyle(element.closest('section')).color),
        true,
        'option text retains the card foreground in dark mode',
      );
      if (process.env.CHOICES_SCREENSHOT) {
        const path = process.env.CHOICES_SCREENSHOT.replace(/\.png$/, '-mobile-dark.png');
        if (process.env.CHOICES_CDP_PORT)
          await promisify(execFile)('agent-browser', ['--cdp', process.env.CHOICES_CDP_PORT, 'screenshot', path]);
        else await page.screenshot({ path });
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await dock.getByRole('button', { name: 'Try again', exact: true }).click();
      await dock.getByRole('button', { name: 'Skip', exact: true }).click();
      await page.clock.runFor(1000);
      await page.getByText('This request was cancelled without an answer.', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      server.kill('SIGTERM');
    }
  },
);
