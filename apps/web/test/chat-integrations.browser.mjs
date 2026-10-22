import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const port = Number(process.env.CHAT_INTEGRATION_PORT ?? 5397);
const origin = `http://127.0.0.1:${port}`;
const id = '11111111-1111-4111-8111-111111111111';
const toolId = '22222222-2222-4222-8222-222222222222';
const { workspace, session } = createWorkspaceFixture({ slug: 'integration-qa', name: 'Integration QA' });
const chat = {
  id,
  title: 'Family portfolio',
  titleRevision: 1,
  archived: false,
  activityAt: workspace.createdAt,
  createdAt: workspace.createdAt,
};
const connected = {
  status: 'connected',
  integrationId: id,
  generation: 1,
  accountId: 'google-account',
  email: 'ada@example.test',
  scopes: [],
};

async function notify(page, keys, conceal = false) {
  await page.evaluate(
    ({ workspaceId, keys, conceal }) => {
      const channel = new BroadcastChannel('tulipfarm:query:v1');
      channel.postMessage({
        version: 1,
        id: crypto.randomUUID(),
        sessionId: 'qa',
        scope: { kind: 'workspace', userId: 'ada', workspaceId, membershipId: workspaceId },
        kind: conceal ? 'conceal' : 'change',
        keys,
      });
      channel.close();
    },
    { workspaceId: id, keys, conceal },
  );
}

test('chat integration links preserve the chat and recover from status failures', { timeout: 120000 }, async t => {
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
    for (const mobile of [false, true])
      await t.test(mobile ? 'mobile dark' : 'desktop light', async () => {
        const context = await browser.newContext({
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
          isMobile: mobile,
          hasTouch: mobile,
          colorScheme: mobile ? 'dark' : 'light',
          reducedMotion: 'reduce',
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        const state = {
          status: 200,
          google: { status: 'disconnected' },
          configured: true,
          gate: Promise.withResolvers(),
          historyGate: null,
          tools: ['google.read', 'google.propose'],
          requests: [],
          writes: [],
        };
        await context.route('**/v1/**', async route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          if (path.endsWith('/messages')) await state.historyGate?.promise;
          state.requests.push(path);
          if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
          // The shell remembers the opened workspace (cloud a5272032 #972, pages/workspace.tsx:358); the chat starts no write.
          if (path === `/v1/workspaces/${workspace.slug}/last-used`) return route.fulfill({ status: 204 });
          if (!['GET', 'OPTIONS'].includes(request.method())) state.writes.push(path);
          let json;
          if (path === '/v1/auth/get-session') json = session;
          else if (path === '/v1/workspaces') json = [workspace];
          else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
          else if (path.endsWith('/governance/me'))
            json = {
              membershipId: id,
              role: 'member',
              teams: [],
              capabilities: { manageGovernance: false, canLeave: true },
            };
          else if (path.endsWith('/model-catalog')) json = chatCatalog;
          else if (path.endsWith('/google-workspace/availability')) json = { configured: state.configured };
          else if (path.endsWith('/github/accounts')) json = { configured: true, accounts: [] };
          else if (path.endsWith('/slack/status'))
            json = { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] };
          else if (path.endsWith('/atlassian/accounts'))
            json = {
              accounts: [],
              providers: [
                { protocol: 'atlassian-rest', configured: true },
                { protocol: 'trello', configured: true },
              ],
            };
          else if (path.endsWith('/google-workspace')) {
            await state.gate?.promise;
            return route.fulfill({
              status: state.status,
              json: state.status === 200 ? state.google : { error: 'unavailable' },
            });
          } else if (path.endsWith('/messages'))
            json = {
              messages: [
                {
                  id,
                  sequence: 1,
                  author: 'human',
                  createdAt: workspace.createdAt,
                  parts: [{ kind: 'text', text: 'Show my family portfolio from Google Sheets.' }],
                  turn: { id, status: 'completed', generation: 0 },
                  tools: state.tools.map((tool, i) => ({ id: i ? toolId : id, tool, status: 'completed' })),
                },
                {
                  id: toolId,
                  sequence: 2,
                  author: 'assistant',
                  createdAt: workspace.createdAt,
                  parts: [{ kind: 'text', text: 'Connect your Google account to read your spreadsheet.' }],
                  turn: null,
                  tools: [],
                },
              ],
              nextBefore: null,
              hasGitHubProposals: false,
            };
          else if (/\/conversations\/[\w-]+$/.test(path)) json = chat;
          else return route.fulfill({ status: 404, json: { error: 'not-found' } });
          return route.fulfill({ json });
        });
        try {
          await page.goto(`${origin}/${workspace.slug}/chat/${id}`);
          const region = page.getByRole('region', { name: 'Chat integrations', exact: true });
          await region.getByText('Checking Google integration…', { exact: true }).waitFor();
          assert.equal(await region.getByRole('link').count(), 0, 'loading must not claim disconnected');
          state.gate.resolve();
          state.gate = null;
          const link = region.getByRole('link', { name: 'Connect Google', exact: true });
          await link.waitFor();
          if (process.env.CHAT_INTEGRATION_SCREENSHOTS)
            await page.screenshot({
              path: `${process.env.CHAT_INTEGRATION_SCREENSHOTS}/chat-connect-${mobile ? 'mobile' : 'desktop'}.png`,
              fullPage: true,
            });
          assert.equal(await region.getByRole('link').count(), 1, 'deduplicate Google tools');
          assert.equal(
            state.requests.filter(path => path.endsWith('/google-workspace')).length,
            1,
            'Google tool links share one status read',
          );
          // The workspace shell's reauthorization banner reads every provider once; the chat links add no reads of their own.
          for (const provider of ['github/accounts', 'slack/status', 'atlassian/accounts'])
            assert.ok(
              state.requests.filter(path => path.endsWith(`/${provider}`)).length <= 1,
              `only the requested provider is loaded by chat links (${provider})`,
            );
          assert.equal(
            await link.getAttribute('href'),
            `/${workspace.slug}/integrations?returnChat=${id}#google-workspace`,
          );
          const input = page.getByRole('textbox', { name: 'Message', exact: true });
          await input.fill('Keep my unsent draft');
          await link.focus();
          const popupPromise = page.waitForEvent('popup');
          await page.keyboard.press('Enter');
          const popup = await popupPromise;
          await popup
            .getByRole('dialog', { name: 'Gmail' })
            .getByRole('button', { name: 'Connect Gmail', exact: true })
            .waitFor();
          assert.equal(await input.textContent(), 'Keep my unsent draft');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
          assert.equal(page.url(), `${origin}/${workspace.slug}/chat/${id}`);
          await popup.close();
          state.google = { ...connected, status: 'reconnect-required' };
          const beforeFocus = state.requests.length;
          await page.evaluate(() => window.dispatchEvent(new Event('focus')));
          await delay(300);
          assert.equal(
            state.requests.slice(beforeFocus).some(path => path.endsWith('/google-workspace')),
            false,
            'focus does not refresh provider data',
          );
          await notify(page, [['integrations', 'google'], ['conversations']], true);
          await region.getByRole('link', { name: 'Reconnect Google', exact: true }).waitFor();
          state.status = 503;
          await notify(page, [['integrations', 'google', 'accounts']]);
          await region.getByRole('alert').waitFor();
          assert.equal(
            await region.getByRole('link').count(),
            0,
            'failed refresh cannot retain a stale integration action',
          );
          await region.getByRole('button', { name: 'Check Google integration again' }).click();
          await region.getByRole('alert').waitFor();
          await page.waitForFunction(
            () =>
              ![...document.querySelectorAll('button')].find(
                button => button.textContent === 'Check Google integration again',
              )?.disabled,
          );
          state.status = 200;
          state.google = connected;
          await region.getByRole('button', { name: 'Check Google integration again' }).click();
          await region.getByRole('link').waitFor({ state: 'hidden' });
          await region.getByRole('button').waitFor({ state: 'hidden' });
          assert.equal(await region.getByRole('link').count(), 0, 'connected accounts need no recovery link');
          assert.equal(await input.textContent(), 'Keep my unsent draft');
          state.google = { status: 'disconnected' };
          state.configured = false;
          state.tools = ['google.read'];
          await notify(page, [['conversations']]);
          await region.getByRole('link', { name: 'Review Google integration', exact: true }).waitFor();
          state.tools = ['github.personal.read', 'slack.message.send', 'atlassian.sources'];
          await notify(page, [['conversations']]);
          await region.getByRole('link', { name: 'Connect GitHub', exact: true }).waitFor();
          await region.getByRole('link', { name: 'Review Slack integration', exact: true }).waitFor();
          await region.getByRole('link', { name: 'Review Atlassian and Trello integrations', exact: true }).waitFor();
          assert.match(await region.innerText(), /An administrator needs to connect this workspace/);
          assert.match(
            await region.getByRole('link', { name: 'Connect GitHub', exact: true }).getAttribute('href'),
            /#github-accounts$/,
          );
          assert.match(
            await region
              .getByRole('link', { name: 'Review Atlassian and Trello integrations', exact: true })
              .getAttribute('href'),
            /#atlassian-heading$/,
          );
          state.historyGate = Promise.withResolvers();
          await notify(page, [['integrations', 'github-personal'], ['conversations']], true);
          await page
            .getByText('Connect your Google account to read your spreadsheet.', { exact: true })
            .waitFor({ state: 'hidden' });
          assert.equal(await input.textContent(), 'Keep my unsent draft', 'source concealment preserves the draft');
          state.historyGate.resolve();
          state.historyGate = null;
          await region.getByRole('link', { name: 'Connect GitHub', exact: true }).waitFor();
          state.tools = ['rows.get'];
          await notify(page, [['conversations']]);
          await region.waitFor({ state: 'hidden' });
          state.requests.length = 0;
          await page.reload();
          await page.getByText('Connect your Google account to read your spreadsheet.', { exact: true }).waitFor();
          assert.equal(
            await page.getByRole('region', { name: 'Chat integrations', exact: true }).count(),
            0,
            'assistant prose cannot invent integration actions',
          );
          // The workspace shell's reauthorization banner reads each provider once (cloud reauthorization-banner.tsx:26-29); the chat adds none.
          assert.ok(
            state.requests.filter(path => path.endsWith('/google-workspace')).length <= 1,
            'unrelated chats do not load provider status',
          );
          assert.deepEqual(state.writes, [], 'links and status checks never retry writes or start consent');
          assert.deepEqual(errors, []);
        } finally {
          state.gate?.resolve();
          state.historyGate?.resolve();
          await context.close();
        }
      });
  } finally {
    await browser?.close();
    server.kill();
  }
});
