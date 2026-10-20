import assert from 'node:assert/strict';
import { openGitHubReview, openGitHubDetails } from './github-review.fixture.mjs';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { repositoryFixture, repositoryTarget, branchSha } from '../../worker/test/github-repository-fixture.mjs';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { registerGitHubBatches } from '../../api/src/github-batches.ts';
import { registerConversations } from '../../api/src/conversations.ts';
import { createGitHubBatchDecision } from '../../../packages/github/dist/batch-approval.js';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = 5234,
  origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await repositoryFixture(),
  app = Fastify();
const auth = { api: { getSession: async () => ({ user: { id: f.member.userId }, session: { id: 'browser' } }) } };
await app.register(
  async routes => {
    registerGitHubAccounts(routes, auth, f.options.accounts, f.reads);
    registerGitHubBatches(routes, {
      auth,
      batches: f.batches,
      decide: createGitHubBatchDecision({
        ...f.options,
        resolveConfirmationCredential: async () => f.db.login(f.one, 'confirmation'),
      }),
    });
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
  slug: 'github-repositories',
  name: 'GitHub repositories',
  createdAt: new Date().toISOString(),
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
try {
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
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/v1/**', async route => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (path.includes('/github/') || path.includes('/conversations')) {
      const result = await app.inject({
        method: req.method(),
        url: path + url.search,
        headers: { origin, ...(req.postData() ? { 'content-type': 'application/json' } : {}) },
        ...(req.postData() ? { payload: req.postData() } : {}),
      });
      return route.fulfill({ status: result.statusCode, contentType: 'application/json', body: result.body });
    }
    const json =
      path === '/v1/auth/get-session'
        ? {
            session: { id: 'browser', userId: f.member.userId },
            user: { id: f.member.userId, name: 'Ada', email: 'ada@example.test' },
          }
        : path.endsWith('/governance/me')
          ? {
              membershipId: '22222222-2222-4222-8222-222222222222',
              role: 'member',
              teams: [],
              capabilities: { manageGovernance: false, canLeave: true },
            }
          : path === '/v1/workspaces'
            ? [workspace]
            : path === `/v1/workspaces/${workspace.slug}`
              ? workspace
              : path.endsWith('/model-catalog')
                ? chatCatalog
                : null;
    return route.fulfill({ status: json ? 200 : 404, json: json ?? { error: 'not-found' } });
  });
  const deletion = { kind: 'repository.delete', ...repositoryTarget };
  const branch = { kind: 'branch.delete', ...repositoryTarget, branch: 'old', headSha: branchSha };
  const creation = {
    kind: 'repository.create',
    owner: 'person-123',
    repo: 'new',
    ownerType: 'user',
    ownerId: 123,
    description: '',
    private: true,
    autoInit: true,
  };
  const batch = await f.propose(
    [branch, deletion, creation],
    [
      { kind: 'branch.read', owner: 'octocat', repo: 'private', branch: 'old' },
      { kind: 'repository.read', owner: 'outside', repo: 'source' },
    ],
  );
  await page.goto(`${origin}/${workspace.slug}/chat/${f.chatId}`);
  await openGitHubReview(page, batch.snapshot.id);
  await page
    .getByText(
      'Delete octocat/private, repository ID 42. This permanently removes the repository and its contents. TulipFarm cannot undo this action.',
      { exact: true },
    )
    .waitFor();
  const review = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: '2. repository.delete · unattempted', exact: true }) });
  await openGitHubDetails(review);
  assert.deepEqual(JSON.parse(await review.locator('pre').nth(1).innerText()), deletion);
  assert.equal(f.effects.length, 0);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-repository-delete-review.png',
    fullPage: true,
  });
  await review.getByRole('button', { name: 'Approve exact batch' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '3. repository.create · succeeded', exact: true }).waitFor();
  const expectedEffects = [
    { method: 'DELETE', path: '/repos/octocat/private/git/refs/heads/old' },
    { method: 'DELETE', path: '/repos/octocat/private' },
    { method: 'POST', path: '/user/repos', body: { name: 'new', description: '', private: true, auto_init: true } },
  ];
  assert.deepEqual(f.effects, expectedEffects);
  await page.reload();
  await openGitHubReview(page, batch.snapshot.id);
  await page.getByRole('heading', { name: '2. repository.delete · succeeded', exact: true }).waitFor();
  await page.getByRole('heading', { name: '3. repository.create · succeeded', exact: true }).waitFor();
  assert.deepEqual((await f.read(batch)).actions[1].result, { repositoryId: 42, deleted: true });
  f.denyOutside();
  await page.reload();
  await openGitHubReview(page, batch.snapshot.id);
  await page.getByRole('heading', { name: 'GitHub batch status', exact: true }).waitFor();
  await page.getByText('Action 1: succeeded', { exact: true }).waitFor();
  await page.getByText('Action 3: succeeded', { exact: true }).waitFor();
  assert.equal(await page.getByText(/Delete octocat\/private, repository ID/).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Approve exact batch' }).count(), 0);
  await page.getByRole('button', { name: 'Check private details' }).click();
  await page.getByRole('heading', { name: 'GitHub batch status', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-repository-status-mobile.png',
    fullPage: true,
  });
  f.allowOutside();
  await page.getByRole('button', { name: 'Check private details' }).click();
  await page.getByRole('heading', { name: '2. repository.delete · succeeded', exact: true }).waitFor();
  await page.getByRole('heading', { name: '3. repository.create · succeeded', exact: true }).waitFor();
  assert.deepEqual(f.effects, expectedEffects);
  assert.deepEqual(errors, []);
  console.log(
    'PASS exact destructive review, keyboard approval, HTTP branch and repository deletion, unrelated creation, durable tombstone, reload, outside-source concealment and recovery, owner-only status, mobile dark reduced motion.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await app.close();
  await f.close();
}
