import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { githubChatFixture } from '../../worker/test/github-read-fixture.mjs';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { registerConversations } from '../../api/src/conversations.ts';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = 5229,
  origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await githubChatFixture(),
  app = Fastify();
const auth = { api: { getSession: async () => ({ user: { id: f.member.userId }, session: { id: 'browser' } }) } };
await app.register(
  async routes => {
    registerGitHubAccounts(routes, auth, f.service, f.reads);
    registerConversations(routes, { auth, service: f.store });
  },
  { prefix: '/v1' },
);
await app.ready();
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
let browser;
const workspace = {
  id: f.one.id,
  slug: 'github-reads',
  name: 'GitHub reads',
  createdAt: new Date().toISOString(),
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const errors = [];
let failSelection = false,
  delay = 0;
const requests = [];
let heldSelection;
let holdSelection = false;
const releaseSelection = Promise.withResolvers();
try {
  const first = await f.connect(123),
    second = await f.connect(456),
    chatId = await f.chat();
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {
      if (attempt === 100) throw new Error('Vite failed');
    }
    await setTimeout(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/v1/**', async route => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    requests.push({ method: req.method(), path });
    if (path.includes('/github/') || path.includes('/conversations')) {
      if (path.endsWith('/selection') && req.method() === 'GET') {
        await setTimeout(delay);
        if (failSelection) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      }
      const response = await app.inject({
        method: req.method(),
        url: path + url.search,
        headers: { origin, ...(req.postData() ? { 'content-type': 'application/json' } : {}) },
        ...(req.postData() ? { payload: req.postData() } : {}),
      });
      if (holdSelection && path.endsWith('/selection') && req.method() !== 'GET') {
        heldSelection = true;
        await releaseSelection.promise;
      }
      if (
        req.method() === 'PUT' &&
        path.includes('/messages/') &&
        response.statusCode === 200 &&
        response.json().turnId
      )
        assert.equal(await f.process(chatId, response.json().turnId), 'completed');
      return route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    }
    let json;
    if (path === '/v1/auth/get-session')
      json = {
        session: { id: 'browser', userId: f.member.userId },
        user: { id: f.member.userId, name: 'Ada', email: 'ada@example.test' },
      };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: '22222222-2222-4222-8222-222222222222',
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith('/model-catalog')) json = chatCatalog;
    else if (path.includes('/google/')) json = { proposals: [] };
    else return route.fulfill({ status: 404, json: { error: 'not-found' } });
    return route.fulfill({ json });
  });
  const call = {
    tool: 'github.personal.read',
    operation: { kind: 'repository.read', owner: 'octocat', repo: 'private' },
  };
  const cards = page.getByRole('region', { name: 'Choose a GitHub account' });
  delay = 700;
  await page.goto(`${origin}/${workspace.slug}/chat/${chatId}`);
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'GitHub account selection' }).count(), 0);
  // The workspace shell's reauthorization banner reads the account list once (cloud reauthorization-banner.tsx:26-29, mounted in workspace.tsx); chat adds no GitHub reads of its own.
  const githubReads = requests.filter(request => request.path.includes('/github/'));
  assert.ok(
    githubReads.every(request => request.method === 'GET' && request.path.endsWith('/github/accounts')),
    'Ordinary chat does not load GitHub selections',
  );
  assert.ok(githubReads.length <= 1, 'Ordinary chat does not load GitHub accounts beyond the shell banner');
  f.decide([call, { tool: 'github.personal.account' }], 'Pick a GitHub account below.');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Read my GitHub repository.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Pick a GitHub account below.', { exact: true }).waitFor();
  await page.getByText('Loading GitHub accounts…').waitFor();
  await cards.last().getByRole('button', { name: 'person-123', exact: true }).waitFor();
  delay = 0;
  const beforeFocus = requests.length;
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep account-card draft');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await setTimeout(300);
  assert.equal(
    requests.slice(beforeFocus).filter(request => request.path.includes('/github/')).length,
    0,
    'Account cards do not refetch on focus; authority reads remain allowed',
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'Message', exact: true }).textContent(),
    'Keep account-card draft',
  );
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('');
  assert.equal(f.providerCalls.length, 0);
  assert.equal((await f.reads.selection(f.one.id, f.member.userId, chatId)).accountId, null);
  assert.equal(requests.filter(request => request.method === 'GET' && request.path.endsWith('/selection')).length, 1);
  assert.equal(
    requests.filter(request => request.method === 'GET' && request.path.endsWith('/github/accounts')).length,
    1,
  );
  f.decide([call], 'First account private repository.');
  await cards.last().getByRole('button', { name: 'person-123', exact: true }).click();
  await page
    .getByText('I selected GitHub account person-123. Continue my previous GitHub request with it.', { exact: true })
    .waitFor();
  await page.getByText('First account private repository.', { exact: true }).waitFor();
  assert.equal((await f.reads.selection(f.one.id, f.member.userId, chatId)).accountId, first);
  assert.ok(f.providerCalls.length > 1);
  await page.getByLabel('Messages').getByText('Read my GitHub repository.', { exact: true }).waitFor();
  failSelection = true;
  await page.reload();
  await page.getByText('Could not load GitHub accounts').waitFor();
  failSelection = false;
  await page.getByRole('button', { name: 'Retry loading accounts' }).click();
  await cards.last().getByRole('button', { name: 'person-123 · Selected', exact: true, pressed: true }).waitFor();
  failSelection = true;
  await page.evaluate(
    ({ userId, workspaceId, chatId }) => {
      const channel = new BroadcastChannel('tulipfarm:query:v1');
      channel.postMessage({
        version: 1,
        id: crypto.randomUUID(),
        sessionId: 'browser',
        scope: { kind: 'workspace', userId, workspaceId, membershipId: '22222222-2222-4222-8222-222222222222' },
        kind: 'change',
        keys: [['integrations', 'github-personal', 'content', 'selection', chatId]],
      });
      channel.close();
    },
    { userId: f.member.userId, workspaceId: f.one.id, chatId },
  );
  await cards.last().getByText('GitHub accounts could not be refreshed.', { exact: true }).waitFor();
  assert.equal(
    await cards.last().getByRole('button', { name: 'person-456', exact: true }).isDisabled(),
    true,
    'Retained account data cannot authorize a write after refresh failure',
  );
  failSelection = false;
  await cards.last().getByRole('button', { name: 'Check accounts again', exact: true }).click();
  await page.waitForFunction(() => !document.body.textContent.includes('GitHub accounts could not be refreshed.'));
  f.decide([{ tool: 'github.personal.account' }], 'Pick another GitHub account.');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Switch my GitHub account.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('Pick another GitHub account.', { exact: true }).waitFor();
  assert.equal(await cards.count(), 2);
  const beforeCardsFocus = requests.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await setTimeout(300);
  assert.equal(
    requests.slice(beforeCardsFocus).filter(request => request.path.includes('/github/')).length,
    0,
    'Multiple account cards share cached reads without focus refresh',
  );
  f.decide([call], 'Second account private repository.');
  await cards.last().getByRole('button', { name: 'person-456', exact: true }).click();
  await page.getByText('Second account private repository.', { exact: true }).waitFor();
  assert.equal((await f.reads.selection(f.one.id, f.member.userId, chatId)).accountId, second);
  await page
    .getByText(/This reply is unavailable/)
    .first()
    .waitFor();
  await page.screenshot({ path: join(tmpdir(), 'github-reads-desktop.png'), fullPage: true });
  f.setProvider(async () => Response.json({ message: 'Repository access denied' }, { status: 403 }));
  await page.reload();
  await page
    .getByText(/This reply is unavailable/)
    .first()
    .waitFor();
  assert.equal(await page.getByText('Second account private repository.', { exact: true }).count(), 0);
  f.setProvider(async () => Response.json({ name: 'private-repository', description: 'Private account content' }));
  await page.reload();
  await page.getByText('Second account private repository.', { exact: true }).waitFor();
  await f.service.disconnect(f.one.id, f.member.userId, second);
  await page.reload();
  await page
    .getByText(/This reply is unavailable/)
    .first()
    .waitFor();
  assert.equal(await page.getByText('Second account private repository.', { exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await cards.last().getByText('1 account needs attention in Integrations.').waitFor();
  assert.equal(
    await cards
      .last()
      .getByRole('button', { name: /person-456/ })
      .count(),
    0,
    'Unusable accounts are not offered in chat',
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(tmpdir(), 'github-reads-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  holdSelection = true;
  await cards.last().getByRole('button', { name: 'person-123', exact: true }).click();
  for (let attempt = 0; !heldSelection; attempt++) {
    assert.ok(attempt < 100, 'Selection write reaches server');
    await setTimeout(20);
  }
  await page.getByRole('button', { name: 'Back to chats', exact: true }).click();
  await cards.last().waitFor({ state: 'detached' });
  const afterUnmount = requests.length;
  releaseSelection.resolve();
  await setTimeout(500);
  assert.equal(
    requests.slice(afterUnmount).filter(request => request.method !== 'GET').length,
    0,
    'Late selection response after card unmount cannot send a follow-up chat command',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS actual chat UI, API, PostgreSQL and metered worker with controlled model/GitHub. Model-requested account card, persisted selection, read receipt, account switch, fresh context, revocation visibility, loading, retry, mobile/dark.',
  );
} finally {
  releaseSelection.resolve();
  await browser?.close();
  server.kill('SIGTERM');
  await app.close();
  await f.close();
}
