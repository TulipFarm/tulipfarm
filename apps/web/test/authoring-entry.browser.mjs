import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';
import { createWorkspaceFixture, workspaceShellReads } from './workspace.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';
import { catalogFixture } from '../src/features/models/catalog-fixture.ts';
import { modelOption } from './browser-controls.mjs';

const createdAt = '2026-10-01T00:00:00Z';
const cases = [
  {
    page: 'agents',
    action: 'New agent',
    empty: 'No agents yet',
    skillId: 'agent-authoring',
    placeholder: 'Describe the job, for example "Answer questions about my Customers table"',
    description: 'Answer questions about my Customers table',
  },
  {
    page: 'skills',
    action: 'New skill',
    empty: 'No workspace skills yet',
    skillId: 'workspace-skill-authoring',
    placeholder: 'Describe the task, for example "Write a weekly customer update"',
    description: 'Write a weekly customer update',
  },
];

async function fixture(page, { delayedCatalog = false, defaultAvailable = true } = {}) {
  const { workspace, session } = createWorkspaceFixture({ slug: 'acme', name: 'Acme' });
  session.user.lastModelFamilyId = 'deepseek-pro';
  const shell = new Map(workspaceShellReads(workspace.id));
  const base = `/v1/workspaces/${workspace.id}`;
  const catalog = catalogFixture(['deepseek-pro', 'grok-fast', 'kimi']);
  catalog.defaultChatFamilyId = 'grok-fast';
  if (!defaultAvailable) {
    catalog.families[0].available = false;
    catalog.families[0].unavailableReason = 'workspace-disabled';
    catalog.families[1].available = false;
    catalog.families[1].unavailableReason = 'model-family-paused';
  }
  const catalogGate = Promise.withResolvers();
  const sends = [];
  const chats = new Map();
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const send = json => route.fulfill({ json });
    if (path === '/v1/auth/get-session') return send(session);
    if (path === '/v1/auth/update-user') return send({ status: true });
    if (path === '/v1/user/visit') return send({ firstSession: false });
    if (path === '/v1/workspaces') return send([workspace]);
    if (path === '/v1/workspaces/acme') return send(workspace);
    if (path === `${base}/governance/me`) return send(membership);
    if (path === `${base}/credits`) return send(credits);
    if (path === `${base}/model-catalog`) {
      if (delayedCatalog) await catalogGate.promise;
      return send(catalog);
    }
    if (path === `${base}/agents/authoring-context`)
      return send({ currentSoulRevision: 'a'.repeat(40), teams: [], admin: true });
    if (path === `${base}/agents`) return send({ agents: [], count: 0, nextCursor: null });
    if (path === `${base}/skills`) return send({ workspace: [], nextCursor: null });
    if (path === `${base}/projects`) return send([]);
    if (path === `${base}/integrations`) return send({ integrations: [] });
    if (path === `${base}/conversations`)
      return send({ chats: [...chats.values()].map(item => item.chat), nextCursor: null });
    const conversation = new RegExp(`^${base}/conversations/([\\w-]+)(/.*)?$`).exec(path);
    if (conversation) {
      const [, id, rest = ''] = conversation;
      if (method === 'PUT' && !rest) {
        chats.set(id, {
          chat: {
            id,
            title: 'New chat',
            titleRevision: 0,
            titleManual: false,
            archived: false,
            activityAt: createdAt,
            createdAt,
            projectId: null,
          },
          messages: [],
        });
        return send({ id });
      }
      const stored = chats.get(id);
      if (stored && method === 'PUT' && rest.startsWith('/messages/')) {
        const body = request.postDataJSON();
        sends.push(body);
        const messageId = rest.split('/').at(-1);
        const turnId = crypto.randomUUID();
        stored.messages.push({
          id: messageId,
          sequence: stored.messages.length + 1,
          author: 'human',
          createdAt,
          parts: body.parts.map(part => (part.kind === 'skill' ? { ...part, name: 'Authoring' } : part)),
          turn: { id: turnId, generation: 0, status: 'completed' },
          tools: [],
          calendarResults: [],
        });
        return send({ messageId, turnId, sequence: stored.messages.length });
      }
      if (stored && method === 'GET' && rest === '/messages')
        return send({ messages: stored.messages, nextBefore: null, hasGitHubProposals: false });
      if (stored && method === 'GET' && !rest) return send(stored.chat);
      if (rest === '/events') return route.fulfill({ status: 204 });
    }
    if (shell.has(path)) return send(shell.get(path));
    if (path.endsWith('/last-used') || path.endsWith('/recommendations/events')) return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  });
  return { sends, releaseCatalog: () => catalogGate.resolve() };
}

async function screenshot(page, name) {
  const directory = process.env.AUTHORING_ENTRY_SCREENSHOTS;
  if (!directory) return;
  const path = `${directory}/${name}.png`;
  if (!process.env.AGENT_BUILDER_CDP_PORT) return page.screenshot({ path, fullPage: true });
  const run = (...args) =>
    execFileSync(
      'agent-browser',
      ['--session', 'plain-authoring-entry', '--cdp', process.env.AGENT_BUILDER_CDP_PORT, ...args],
      { encoding: 'utf8' },
    );
  const tabs = JSON.parse(run('tab', 'list', '--json')).data.tabs;
  const target = tabs.find(tab => tab.url === page.url());
  assert.ok(target);
  run('tab', target.tabId);
  run('screenshot', path);
}

test(
  'authoring starts from one action with an empty focused composer and workspace model',
  { timeout: 180000 },
  async () => {
    const server = await startBuiltApp();
    const browser = await chromium.launch(builderBrowserOptions());
    let page;
    try {
      for (const mobile of [false, true]) {
        for (const entry of cases) {
          const context = await browser.newContext({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
            colorScheme: mobile ? 'dark' : 'light',
            reducedMotion: 'reduce',
          });

          page = await context.newPage();
          page.setDefaultTimeout(30000);
          const state = await fixture(page, { delayedCatalog: true });
          await page.goto(`${server.origin}/acme/${entry.page}`);
          await page.getByText(entry.empty, { exact: true }).waitFor();
          const action = page.getByRole('link', { name: entry.action, exact: true });
          assert.equal(await action.count(), 1);
          if (entry.page === 'skills')
            assert.equal(await page.getByRole('button', { name: 'Import skill', exact: true }).count(), 1);
          await screenshot(page, `${entry.page}-${mobile ? 'mobile' : 'desktop'}-list`);
          await action.click();
          const message = page.getByRole('textbox', { name: 'Message', exact: true });
          await message.locator(`[data-placeholder='${entry.placeholder}']`).waitFor();
          await page.waitForURL(`${server.origin}/acme`);
          assert.equal((await message.innerText()).trim(), '');
          await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'textbox');
          assert.equal(await message.evaluate(element => element === document.activeElement), true);
          state.releaseCatalog();
          await page.getByRole('combobox', { name: 'Model: Grok Fast', exact: true }).waitFor();
          assert.equal(state.sends.length, 0);
          await screenshot(page, `${entry.page}-${mobile ? 'mobile' : 'desktop'}-composer`);
          await page.keyboard.type(entry.description);
          const sent = page.waitForResponse(
            response => response.request().method() === 'PUT' && response.url().includes('/messages/'),
          );
          await page.keyboard.press('Enter');
          await page.waitForURL(/\/chat\/[0-9a-f-]+$/);
          await sent;
          assert.equal(state.sends.length, 1);
          assert.equal(state.sends[0].model, 'grok-fast');
          assert.deepEqual(
            state.sends[0].parts.filter(part => part.kind === 'skill'),
            [{ kind: 'skill', skillId: entry.skillId, revision: 'latest' }],
          );
          assert.deepEqual(
            state.sends[0].parts.filter(part => part.kind === 'text').map(part => part.text),
            [entry.description],
          );
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await context.close();
        }
      }
    } catch (error) {
      await captureBrowserFailure(page, 'authoring-entry');
      throw error;
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test('authoring uses an available fallback and keeps explicit model choices', { timeout: 120000 }, async () => {
  const server = await startBuiltApp();
  const browser = await chromium.launch(builderBrowserOptions());
  let page;
  try {
    for (const entry of cases) {
      page = await browser.newPage();
      page.setDefaultTimeout(30000);
      await fixture(page, { defaultAvailable: false });
      await page.goto(`${server.origin}/acme?intent=create-${entry.page === 'agents' ? 'agent' : 'skill'}`);
      await page.getByRole('combobox', { name: 'Model: Kimi', exact: true }).waitFor();
      await page.close();
    }
    page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await fixture(page);
    await page.goto(`${server.origin}/acme`);
    await page.getByRole('combobox', { name: 'Model: DeepSeek Pro', exact: true }).waitFor();
    await page.close();

    page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const state = await fixture(page);
    await page.goto(`${server.origin}/acme?intent=create-agent`);
    const picker = page.getByRole('combobox', { name: 'Model: Grok Fast', exact: true });
    await picker.click();
    await modelOption(page, 'Kimi').click();
    await page.getByRole('combobox', { name: 'Model: Kimi', exact: true }).waitFor();
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await message.fill('Answer questions about customers');
    const sent = page.waitForResponse(
      response => response.request().method() === 'PUT' && response.url().includes('/messages/'),
    );
    await message.press('Enter');
    await sent;
    assert.equal(state.sends[0].model, 'kimi');
  } catch (error) {
    await captureBrowserFailure(page, 'authoring-entry-models');
    throw error;
  } finally {
    await browser.close();
    await server.close();
  }
});
