import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits, notifyChange } from './chat-query.fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const port = Number(process.env.CHAT_READINESS_PORT ?? 5392);
const origin = `http://127.0.0.1:${port}`;
const id = '11111111-1111-4111-8111-111111111111';
const toolId = '22222222-2222-4222-8222-222222222222';
// Text parts carry the composer's rich document beside the plain text (cloud ff619e47 #554, conversation-api.ts:22).
const textPart = text => ({
  kind: 'text',
  text,
  content: { version: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } },
});
const { workspace, session } = createWorkspaceFixture();
const chat = {
  id,
  title: 'Google-only chat',
  titleRevision: 1,
  archived: false,
  activityAt: workspace.createdAt,
  createdAt: workspace.createdAt,
};
const message = {
  id,
  sequence: 1,
  author: 'assistant',
  createdAt: workspace.createdAt,
  parts: [{ kind: 'text', text: 'Your Google documents are ready.' }],
  turn: null,
  tools: [],
};
const batch = {
  snapshot: {
    id,
    workspaceId: id,
    membershipId: id,
    commandId: id,
    accountId: id,
    generation: 1,
    selectionVersion: 1,
    origin: { kind: 'chat', conversationId: id, turnId: id, generation: 0 },
    sources: [],
    actions: [{ kind: 'issue.create', owner: 'octocat', repo: 'private', title: 'Exact approved issue', body: 'Body' }],
    configurationDigest: 'a'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
  digest: 'b'.repeat(64),
  expired: false,
  decision: null,
  actions: [{ ordinal: 0, status: 'unattempted', result: null, reconciliation: null }],
};

test('chat readiness and relevant GitHub approvals', async t => {
  const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  let browser;
  try {
    for (let attempt = 0; ; attempt++) {
      if (
        await fetch(origin).then(
          response => response.ok,
          () => false,
        )
      )
        break;
      assert.ok(attempt < 100, 'Vite starts');
      await delay(100);
    }
    browser = await chromium.launch({ headless: true });
    for (const mobile of [false, true]) {
      async function fixture() {
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
          colorScheme: mobile ? 'dark' : 'light',
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.setDefaultNavigationTimeout(30000);
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        const state = {
          historyGate: null,
          historyReads: 0,
          modelGate: null,
          modelStatus: 200,
          createGate: null,
          createStatus: 200,
          creates: 0,
          batchGate: null,
          batchStatus: 503,
          batches: [],
          tools: [],
          turn: null,
          hasGitHubProposals: false,
          nextBefore: null,
          sends: [],
          batchReads: 0,
        };
        await page.route('**/v1/**', async route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          let json;
          if (path === '/v1/auth/get-session') json = session;
          else if (path === '/v1/workspaces') json = [workspace];
          else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
          else if (path.endsWith('/governance/me')) json = membership;
          else if (path.endsWith('/credits')) json = credits;
          else if (path.endsWith('/github/accounts')) json = { configured: true, accounts: [] };
          else if (path.endsWith('/selection')) json = { accountId: null, generation: null, version: 0 };
          else if (path.endsWith('/google-workspace/availability')) json = { configured: true };
          else if (path.endsWith('/google-workspace'))
            json = {
              status: 'connected',
              integrationId: id,
              generation: 1,
              accountId: 'google-account',
              email: 'ada@example.test',
              scopes: [],
            };
          else if (path.endsWith('/atlassian/accounts'))
            json = {
              accounts: [],
              providers: [
                { protocol: 'atlassian-rest', configured: true },
                { protocol: 'trello', configured: true },
              ],
            };
          else if (path.endsWith('/model-catalog')) {
            await state.modelGate?.promise;
            return route.fulfill({
              status: state.modelStatus,
              json: state.modelStatus === 200 ? chatCatalog : { error: 'unavailable' },
            });
          } else if (path.endsWith('/batches')) {
            state.batchReads++;
            await state.batchGate?.promise;
            return route.fulfill({
              status: state.batchStatus,
              json: state.batchStatus === 200 ? { batches: state.batches } : { error: 'batch-unavailable' },
            });
          } else if (/\/messages\/[\w-]+$/.test(path)) {
            state.sends.push(request.postDataJSON());
            json = { messageId: path.split('/').at(-1), turnId: toolId, sequence: 2 };
          } else if (path.endsWith('/messages')) {
            state.historyReads++;
            await state.historyGate?.promise;
            json = {
              messages: [{ ...message, tools: state.tools, turn: state.turn }],
              nextBefore: state.nextBefore,
              hasGitHubProposals: state.hasGitHubProposals,
            };
          } else if (/\/conversations\/[\w-]+$/.test(path)) {
            if (request.method() === 'PUT') {
              state.creates++;
              await state.createGate?.promise;
              if (state.createStatus !== 200)
                return route.fulfill({ status: state.createStatus, json: { error: 'create-unavailable' } });
              json = { id: path.split('/').at(-1) };
            } else json = { ...chat, id: path.split('/').at(-1) };
          } else if (path.endsWith('/conversations')) json = { chats: [chat], nextCursor: null };
          else return route.fulfill({ status: 404, json: { error: 'not-found' } });
          return route.fulfill({ json });
        });
        return {
          page,
          state,
          async close() {
            assert.deepEqual(errors, []);
            await context.close();
          },
        };
      }

      await t.test(
        `${mobile ? 'mobile' : 'desktop'} tool progress stays collapsed until opened and keeps the reader's choice`,
        async () => {
          const f = await fixture();
          try {
            f.state.turn = { id, status: 'processing', generation: 0 };
            await f.page.goto(`${origin}/${workspace.slug}/chat/${id}`);
            await f.page.getByText(message.parts[0].text, { exact: true }).waitFor();
            assert.equal(await f.page.locator('[data-slot="tool-activity"]').count(), 0);
            f.state.tools = [
              { id: toolId, tool: 'google.read', status: 'running', activity: 'Searching Gmail messages' },
            ];
            // Cloud 856d6a73 (#1026) keeps transcript activity collapsed until the reader opens it, even while running; sprout's
            // transcript ToolActivity (tool-activity.js) titles it "Working… <label>", then "Tool activity · N tools" with any attention.
            const activity = f.page.locator('[data-slot="tool-activity"]');
            const trigger = activity.locator('.sprout-tool-activity-trigger');
            await activity.getByRole('button', { name: 'Working… Searching Gmail messages', exact: true }).waitFor();
            assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
            assert.equal(await activity.locator('[data-slot="spinner"]').count(), 1);
            await trigger.click();
            await activity.getByText('Searching Gmail messages', { exact: true }).waitFor();
            // Sprout draws brand marks as inline SVG glyphs rather than images (sprout components/brand-icon.js Glyph).
            assert.equal(
              await activity
                .locator('[data-brand="gmail"] svg')
                .evaluate(svg => svg.querySelectorAll('path').length > 0 && svg.getBoundingClientRect().width > 0),
              true,
            );
            assert.match(await activity.getByRole('listitem').textContent(), /In progress/);
            if (process.env.CHAT_READINESS_SCREENSHOTS)
              await f.page.screenshot({
                path: `${process.env.CHAT_READINESS_SCREENSHOTS}/tool-running-${mobile ? 'mobile' : 'desktop'}.png`,
                fullPage: true,
              });
            f.state.tools[0].status = 'completed';
            await activity.getByRole('listitem').getByText('· Completed', { exact: true }).waitFor();
            assert.equal(
              await trigger.getAttribute('aria-expanded'),
              'true',
              'stay open between calls while the model decides the next action',
            );
            f.state.tools.push({ id, tool: 'google.read', status: 'running', activity: 'Reading a Gmail message' });
            await activity.getByText('Reading a Gmail message', { exact: true }).waitFor();
            f.state.tools[1].status = 'completed';
            f.state.turn.status = 'completed';
            await activity.getByRole('button', { name: 'Tool activity · 2 tools', exact: true }).waitFor();
            assert.equal(await activity.locator('[data-slot="spinner"]').count(), 0);
            await trigger.press('Enter');
            await f.page.waitForFunction(
              () =>
                document
                  .querySelector('[data-slot="tool-activity"] .sprout-tool-activity-trigger')
                  ?.getAttribute('aria-expanded') === 'false',
            );
            await trigger.press('Enter');
            await activity.getByText('Reading a Gmail message', { exact: true }).waitFor();
            await notifyChange(f.page, workspace.id, 'ada', 'chat', id);
            assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'refresh preserves a manual expansion');
            await f.page.reload();
            await activity.getByRole('button', { name: 'Tool activity · 2 tools', exact: true }).waitFor();
            assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'completed history starts collapsed');
            f.state.tools[1].status = 'failed';
            f.state.turn.status = 'failed';
            await notifyChange(f.page, workspace.id, 'ada', 'chat', id);
            await activity
              .getByRole('button', { name: 'Tool activity · 2 tools · Some work failed', exact: true })
              .click();
            await activity
              .getByText('Failed or interrupted. Check current rows before sending a new request.', { exact: true })
              .waitFor();
            f.state.tools[1].status = 'blocked';
            await notifyChange(f.page, workspace.id, 'ada', 'chat', id);
            await activity
              .getByText('Access denied. Ask an administrator to review your permissions.', { exact: true })
              .waitFor();
            f.state.tools = [
              {
                id: toolId,
                tool: 'github.personal.read',
                status: 'completed',
                presentation: { label: 'Search GitHub issues', brand: 'github' },
              },
              {
                id,
                tool: 'atlassian.read',
                status: 'completed',
                presentation: { label: 'Read a Trello card', brand: 'trello' },
              },
              {
                id: '33333333-3333-4333-8333-333333333333',
                tool: 'mcp.call',
                status: 'running',
                activityStatus: 'waiting',
                presentation: { label: 'Calling search_documents', brand: null },
              },
            ];
            await notifyChange(f.page, workspace.id, 'ada', 'chat', id);
            await activity.getByText('Calling search_documents', { exact: true }).waitFor();
            assert.equal(await activity.locator('[data-brand="trello"]').count(), 1);
            await activity.locator('[data-brand="github"]').waitFor();
            assert.equal(
              await activity.locator('[data-slot="spinner"]').count(),
              0,
              'waiting for approval does not spin',
            );
            f.state.tools[2].activityStatus = 'unknown';
            await notifyChange(f.page, workspace.id, 'ada', 'chat', id);
            await activity.getByText('· Outcome unknown', { exact: true }).waitFor();
            f.state.tools[2].activityStatus = 'cancelled';
            f.state.tools[2].status = 'failed';
            await notifyChange(f.page, workspace.id, 'ada', 'chat', id);
            await activity
              .getByRole('button', { name: 'Tool activity · 3 tools · Work cancelled', exact: true })
              .waitFor();
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          } finally {
            await f.close();
          }
        },
      );

      for (const navigation of [false, true])
        await t.test(
          `${mobile ? 'mobile' : 'desktop'} first keystrokes survive delayed history after ${navigation ? 'navigation' : 'page load'}`,
          async () => {
            const f = await fixture();
            try {
              f.state.historyGate = Promise.withResolvers();
              f.state.modelGate = Promise.withResolvers();
              if (navigation) {
                await f.page.goto(`${origin}/${workspace.slug}/chat`);
                await f.page.getByRole('button', { name: chat.title, exact: true }).click();
              } else await f.page.goto(`${origin}/${workspace.slug}/chat/${id}`);
              const input = f.page.getByRole('textbox', { name: 'Message', exact: true });
              await input.click();
              await f.page.keyboard.type('First ');
              assert.equal(await input.textContent(), 'First ');
              f.state.historyGate.resolve();
              await f.page.getByRole('heading', { name: chat.title, exact: true }).waitFor();
              await f.page.getByText('Checking available models…', { exact: true }).waitFor();
              await f.page.keyboard.type('message');
              assert.equal(
                await input.textContent(),
                'First message',
                'history completion must not steal composer focus',
              );
              assert.equal(await input.evaluate(element => element === document.activeElement), true);
              await f.page.keyboard.press('Enter');
              assert.equal(f.state.sends.length, 0, 'models must be checked before sending');
              assert.equal(await input.textContent(), 'First message');
              if (process.env.CHAT_READINESS_SCREENSHOTS)
                await f.page.screenshot({
                  path: `${process.env.CHAT_READINESS_SCREENSHOTS}/qa-chat-272-${mobile ? 'mobile' : 'desktop'}-${navigation ? 'navigation' : 'load'}.png`,
                  fullPage: true,
                });
              f.state.modelGate.resolve();
              await f.page.waitForFunction(() => !document.querySelector('button[aria-label="Send message"]').disabled);
              await f.page.keyboard.press('Enter');
              await f.page.waitForFunction(
                () => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent === '',
              );
              assert.equal(f.state.sends.length, 1);
              assert.deepEqual(f.state.sends[0].parts, [textPart('First message')]);
            } finally {
              f.state.historyGate?.resolve();
              f.state.modelGate?.resolve();
              await f.close();
            }
          },
        );

      await t.test(
        `${mobile ? 'mobile' : 'desktop'} new chat retains the first draft through model failure and retry`,
        async () => {
          const f = await fixture();
          try {
            f.state.modelGate = Promise.withResolvers();
            f.state.modelStatus = 503;
            await f.page.goto(`${origin}/${workspace.slug}`);
            const input = f.page.getByRole('textbox', { name: 'Message', exact: true });
            await input.click();
            await f.page.keyboard.type('My first business task');
            await f.page.keyboard.press('Enter');
            assert.equal(f.state.sends.length, 0);
            assert.equal(await input.textContent(), 'My first business task');
            f.state.modelGate.resolve();
            await f.page.getByText('Could not check model availability. Try again.', { exact: true }).waitFor();
            await f.page.getByRole('button', { name: 'Retry models', exact: true }).click();
            await f.page.getByText('Checking available models…', { exact: true }).waitFor();
            await f.page.getByText('Could not check model availability. Try again.', { exact: true }).waitFor();
            assert.equal(await input.textContent(), 'My first business task');
            f.state.modelStatus = 200;
            await f.page.getByRole('button', { name: 'Retry models', exact: true }).click();
            await f.page.getByRole('button', { name: 'Model: Claude Sonnet', exact: true }).waitFor();
            await input.click();
            await f.page.keyboard.press('Enter');
            await f.page.waitForURL(/\/chat\/[\w-]+$/);
            await f.page.waitForFunction(
              () => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent === '',
            );
            assert.equal(f.state.sends.length, 1);
            assert.deepEqual(f.state.sends[0].parts, [textPart('My first business task')]);
            assert.equal(await input.textContent(), '');
          } finally {
            f.state.modelGate?.resolve();
            await f.close();
          }
        },
      );

      await t.test(
        `${mobile ? 'mobile' : 'desktop'} first send changes the URL without remounting or reloading history`,
        async () => {
          const f = await fixture();
          try {
            f.state.createGate = Promise.withResolvers();
            await f.page.goto(`${origin}/${workspace.slug}`);
            await f.page.getByRole('button', { name: 'Model: Claude Sonnet', exact: true }).waitFor();
            const input = f.page.getByRole('textbox', { name: 'Message', exact: true });
            await input.click();
            await f.page.keyboard.type('Keep this pending');
            await input.evaluate(element => element.setAttribute('data-transition-marker', 'preserved'));
            if (process.env.CHAT_TRANSITION_SCREENSHOTS)
              await f.page.screenshot({
                path: `${process.env.CHAT_TRANSITION_SCREENSHOTS}/before-${mobile ? 'mobile' : 'desktop'}.png`,
                fullPage: true,
              });
            await f.page.keyboard.press('Enter');
            await f.page.waitForURL(/\/chat\/[\w-]+$/);
            assert.equal(
              await input.getAttribute('data-transition-marker'),
              'preserved',
              'the composer remains mounted',
            );
            assert.equal(
              await input.evaluate(element => element === document.activeElement),
              true,
              'the composer retains focus',
            );
            assert.equal(f.state.creates, 1);
            assert.equal(f.state.historyReads, 0, 'the routed chat reuses the draft history while creation is pending');
            assert.equal(await f.page.getByRole('status', { name: 'Loading chats', exact: true }).count(), 0);
            await f.page.getByText('Keep this pending', { exact: true }).waitFor();
            if (process.env.CHAT_TRANSITION_SCREENSHOTS)
              await f.page.screenshot({
                path: `${process.env.CHAT_TRANSITION_SCREENSHOTS}/after-${mobile ? 'mobile' : 'desktop'}.png`,
                fullPage: true,
              });
            f.state.createGate.resolve();
            await f.page.waitForFunction(
              () => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent === '',
            );
            await f.page.goBack();
            await f.page.waitForURL(new RegExp(`/${workspace.slug}$`));
            await f.page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
          } finally {
            f.state.createGate?.resolve();
            await f.close();
          }
        },
      );

      await t.test(`${mobile ? 'mobile' : 'desktop'} failed first creation retries on its routed chat`, async () => {
        const f = await fixture();
        try {
          f.state.createStatus = 503;
          await f.page.goto(`${origin}/${workspace.slug}`);
          await f.page.getByRole('button', { name: 'Model: Claude Sonnet', exact: true }).waitFor();
          const input = f.page.getByRole('textbox', { name: 'Message', exact: true });
          await input.click();
          await f.page.keyboard.type('Retry this chat');
          await f.page.keyboard.press('Enter');
          await f.page.waitForURL(/\/chat\/[\w-]+$/);
          f.state.createStatus = 200;
          await f.page.getByRole('button', { name: 'Retry same operation', exact: true }).click();
          await f.page
            .getByRole('button', { name: 'Retry same operation', exact: true })
            .waitFor({ state: 'detached' });
          await f.page.waitForFunction(
            () => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent === '',
          );
          assert.equal(f.state.creates, 2);
          assert.equal(f.state.sends.length, 1);
          assert.deepEqual(f.state.sends[0].parts, [textPart('Retry this chat')]);
        } finally {
          await f.close();
        }
      });

      await t.test(
        `${mobile ? 'mobile' : 'desktop'} unrelated chats do not show GitHub approval failures`,
        async () => {
          const f = await fixture();
          try {
            await f.page.goto(`${origin}/${workspace.slug}/chat/${id}`);
            await f.page.getByText(message.parts[0].text, { exact: true }).waitFor();
            await f.page.getByRole('button', { name: 'Model: Claude Sonnet', exact: true }).waitFor();
            await delay(100);
            assert.equal(
              await f.page.getByText('GitHub approvals unavailable', { exact: true }).count(),
              0,
              'Google-only chat has no GitHub approval error',
            );
            assert.equal(f.state.batchReads, 0, 'unrelated chats do not request GitHub approvals');
            if (process.env.CHAT_READINESS_SCREENSHOTS)
              await f.page.screenshot({
                path: `${process.env.CHAT_READINESS_SCREENSHOTS}/qa-chat-274-${mobile ? 'mobile' : 'desktop'}.png`,
                fullPage: true,
              });
            f.state.tools = [{ id: toolId, tool: 'github.personal.propose', status: 'completed' }];
            f.state.hasGitHubProposals = true;
            f.state.batchGate = Promise.withResolvers();
            await notifyChange(f.page, workspace.id, 'ada', 'chat', id);
            await f.page.getByText('Checking GitHub approvals…', { exact: true }).waitFor();
            f.state.batchGate.resolve();
            await f.page.getByText('GitHub approvals unavailable', { exact: true }).waitFor();
            await f.page.getByRole('button', { name: 'Check approvals', exact: true }).click();
            await f.page.getByText('Checking GitHub approvals…', { exact: true }).waitFor();
            await f.page.getByText('GitHub approvals unavailable', { exact: true }).waitFor();
            f.state.batchStatus = 200;
            f.state.batches = [batch];
            await f.page.getByRole('button', { name: 'Check approvals', exact: true }).click();
            // A pending batch is a chat card whose review opens in Canvas (cloud 51d9a255 #1053, features/chat/github-batches.tsx:96).
            await f.page.getByRole('button', { name: 'View GitHub changes', exact: true }).click();
            await f.page.getByRole('button', { name: 'Approve exact batch', exact: true }).waitFor();
            await f.page
              .getByRole('region', { name: 'Canvas', exact: true })
              .getByRole('button', { name: 'Exact change' })
              .click();
            assert.match(
              await f.page.getByRole('region', { name: 'Canvas', exact: true }).innerText(),
              /Exact approved issue/,
            );
            f.state.tools = [];
            f.state.nextBefore = 51;
            await f.page.reload();
            await f.page.getByRole('button', { name: 'Load older messages', exact: true }).waitFor();
            await f.page.getByRole('button', { name: 'View GitHub changes', exact: true }).click();
            await f.page.getByRole('button', { name: 'Approve exact batch', exact: true }).waitFor();
            assert.equal(
              await f.page.getByRole('list', { name: 'Tool activity', exact: true }).count(),
              0,
              'older proposals remain reviewable without loading older messages',
            );
            f.state.batches = [];
            f.state.tools = [{ id: toolId, tool: 'github.personal.propose', status: 'failed' }];
            await notifyChange(f.page, workspace.id, 'ada', 'chat', id);
            // The chat card and its open Canvas review both carry this name; both must go.
            await f.page
              .getByRole('region', { name: 'GitHub approvals', exact: true })
              .first()
              .waitFor({ state: 'detached' });
            assert.equal(await f.page.getByText('GitHub approvals unavailable', { exact: true }).count(), 0);
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          } finally {
            f.state.batchGate?.resolve();
            await f.close();
          }
        },
      );
    }
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
});
