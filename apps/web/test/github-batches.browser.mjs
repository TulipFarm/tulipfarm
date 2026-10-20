import assert from 'node:assert/strict';
import { openGitHubReview, openGitHubDetails } from './github-review.fixture.mjs';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { githubChatFixture } from '../../worker/test/github-read-fixture.mjs';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { registerGitHubBatches } from '../../api/src/github-batches.ts';
import { registerConversations } from '../../api/src/conversations.ts';
import { createGitHubBatches } from '../../../packages/github/dist/batches.js';
import { createGitHubBatchDecision } from '../../../packages/github/dist/batch-approval.js';
import { requireDraftSources } from '../../../packages/agents/dist/draft-sources.js';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = 5231,
  origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await githubChatFixture(),
  app = Fastify();
const auth = { api: { getSession: async () => ({ user: { id: f.member.userId }, session: { id: 'browser' } }) } };
const options = { runtime: f.runtime, accounts: f.service, requireSources: requireDraftSources };
const batches = createGitHubBatches(options);
await app.register(
  async routes => {
    registerGitHubAccounts(routes, auth, f.service, f.reads);
    registerGitHubBatches(routes, {
      auth,
      batches,
      decide: createGitHubBatchDecision({
        ...options,
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
  slug: 'github-batches',
  name: 'GitHub batches',
  createdAt: new Date().toISOString(),
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const effects = [],
  errors = [];
let loseResponse = false,
  failRead = false,
  delayRead = 0;
f.setProvider(async (url, init) => {
  if (init.method === 'GET') return Response.json(String(url).includes('?') ? effects : { id: 1 });
  const issue = { id: 100 + effects.length, number: effects.length + 1, ...JSON.parse(init.body), user: { id: 123 } };
  effects.push(issue);
  if (loseResponse) throw new Error('Lost acknowledgement');
  return Response.json(issue, { status: init.method === 'POST' ? 201 : 200 });
});
try {
  const account = await f.connect(123),
    chatId = await f.chat();
  await f.reads.select(f.one.id, f.member.userId, chatId, { accountId: account, expectedVersion: 0 });
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
    if (path.includes('/github/') || path.includes('/conversations')) {
      if (path.endsWith('/batches') && req.method() === 'GET') {
        await setTimeout(delayRead);
        if (failRead) return route.fulfill({ status: 503, json: { error: 'batch-unavailable' } });
      }
      const response = await app.inject({
        method: req.method(),
        url: path + url.search,
        headers: { origin, ...(req.postData() ? { 'content-type': 'application/json' } : {}) },
        ...(req.postData() ? { payload: req.postData() } : {}),
      });
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
        user: { id: f.member.userId, name: 'Ada', email: 'ada@example.test', lastModelFamilyId: 'claude-sonnet' },
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
    else return route.fulfill({ status: 404, json: { error: 'not-found' } });
    return route.fulfill({ json });
  });
  const openNewest = async () => {
    await page.getByRole('button', { name: 'View GitHub changes', exact: true }).first().waitFor();
    const newest = (await batches.list(f.one.id, f.member.userId, chatId)).batches[0];
    await openGitHubReview(page, newest.snapshot.id);
  };
  const sendProposal = async () => {
    const sent = page.waitForResponse(
      response => response.request().method() === 'PUT' && new URL(response.url()).pathname.includes('/messages/'),
    );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await sent;
    await openNewest();
  };
  const action = {
    kind: 'issue.create',
    owner: 'octocat',
    repo: 'private',
    title: 'Browser issue',
    body: 'Exact approved body',
  };
  f.decide([{ tool: 'github.personal.propose', actions: [action] }], 'Review the exact issue batch below.');
  await page.goto(`${origin}/${workspace.slug}/chat/${chatId}`);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Create the issue after my approval.');
  await sendProposal();
  await page.getByRole('button', { name: 'Approve exact batch' }).waitFor();
  assert.equal(effects.length, 0);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-batches-desktop.png',
    fullPage: true,
  });
  failRead = true;
  await page.reload();
  await page.getByRole('button', { name: 'Check approvals' }).waitFor();
  const failedRetry = page.waitForResponse(
    response => response.url().endsWith('/batches') && response.status() === 503,
  );
  await page.getByRole('button', { name: 'Check approvals' }).click();
  await failedRetry;
  await page.getByText('GitHub approvals unavailable', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve exact batch' }).count(), 0);
  failRead = false;
  delayRead = 500;
  await page.getByRole('button', { name: 'Check approvals' }).click();
  await openNewest();
  await page.getByRole('button', { name: 'Approve exact batch' }).waitFor();
  delayRead = 0;
  await page.getByRole('button', { name: 'Approve exact batch' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '1. issue.create · succeeded', exact: true }).waitFor();
  assert.equal(effects.length, 1);
  assert.equal(effects[0].title, 'Browser issue');
  assert.match(effects[0].body, /^Exact approved body\n\n<!-- tulipfarm:/);
  await page.reload();
  await openNewest();
  await page.getByRole('heading', { name: '1. issue.create · succeeded', exact: true }).waitFor();
  f.decide(
    [{ tool: 'github.personal.propose', actions: [{ ...action, title: 'Uncertain issue' }] }],
    'Review the second batch.',
  );
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Create a second issue after approval.');
  await sendProposal();
  await page.getByRole('button', { name: 'Approve exact batch' }).waitFor();
  loseResponse = true;
  await page.getByRole('button', { name: 'Approve exact batch' }).click();
  await page.getByRole('button', { name: 'Reconcile with GitHub' }).waitFor();
  assert.equal(effects.length, 2);
  await page.reload();
  await openNewest();
  await page.getByRole('button', { name: 'Reconcile with GitHub' }).click();
  await page.getByText('Provider evidence checked. The original success was confirmed.', { exact: true }).waitFor();
  assert.equal(effects.length, 2);
  f.decide(
    [{ tool: 'github.personal.propose', actions: [{ ...action, title: 'Reject this issue' }] }],
    'Review the third batch.',
  );
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Prepare one more issue for review.');
  await sendProposal();
  await page.getByRole('button', { name: 'Reject batch' }).click();
  await page.getByText(/· Rejected$/).waitFor();
  assert.equal(effects.length, 2);
  loseResponse = false;
  const headSha = 'a'.repeat(40);
  const mergeEffects = [];
  let merged = false;
  f.setProvider(async (url, init) => {
    const path = new URL(url).pathname;
    if (init.method === 'GET') {
      if (path.endsWith('/pulls/7'))
        return Response.json({
          id: 77,
          number: 7,
          base: { ref: 'main', repo: { id: 42 } },
          head: { sha: headSha, ref: 'fix' },
          state: merged ? 'closed' : 'open',
          merged,
          draft: false,
        });
      return Response.json({ id: 42, full_name: 'octocat/private', archived: false, permissions: { push: true } });
    }
    assert.equal(path, '/repos/octocat/private/pulls/7/merge');
    mergeEffects.push(JSON.parse(init.body));
    merged = true;
    if (loseResponse) throw new Error('Lost merge acknowledgement');
    return Response.json({ merged: true, sha: 'b'.repeat(40) });
  });
  const merge = {
    kind: 'pull.merge',
    owner: 'octocat',
    repo: 'private',
    repositoryId: 42,
    pullNumber: 7,
    pullRequestId: 77,
    headSha,
    base: 'main',
    mergeMethod: 'squash',
    commitTitle: 'Ship reviewed fix',
    commitMessage: 'Exact merge message',
  };
  f.decide([{ tool: 'github.personal.propose', actions: [merge] }], 'Review the exact merge before approving.');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Prepare the merge for review.');
  await sendProposal();
  await page
    .getByText(
      `Merge octocat/private #7 into main using squash. This changes the base branch. Only head ${headSha} is approved.`,
      { exact: true },
    )
    .waitFor();
  assert.equal(mergeEffects.length, 0);
  await page.reload();
  await openNewest();
  const mergeReview = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: '1. pull.merge · unattempted', exact: true }) });
  await mergeReview.waitFor();
  await openGitHubDetails(mergeReview);
  const reviewed = JSON.parse(await mergeReview.locator('pre').first().innerText());
  assert.deepEqual(reviewed, merge);
  await mergeReview.getByRole('button', { name: 'Approve exact batch' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-pull-merge-review.png',
    fullPage: true,
  });
  await mergeReview.getByRole('button', { name: 'Approve exact batch' }).click();
  await page.getByRole('heading', { name: '1. pull.merge · succeeded', exact: true }).waitFor();
  assert.deepEqual(mergeEffects, [
    { sha: headSha, merge_method: 'squash', commit_title: 'Ship reviewed fix', commit_message: 'Exact merge message' },
  ]);
  await page.reload();
  await openNewest();
  await page.getByRole('heading', { name: '1. pull.merge · succeeded', exact: true }).waitFor();
  merged = false;
  f.decide([{ tool: 'github.personal.propose', actions: [merge] }], 'Review another merge.');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Prepare another merge.');
  await sendProposal();
  await page.getByRole('button', { name: 'Approve exact batch' }).waitFor();
  loseResponse = true;
  await page.getByRole('button', { name: 'Approve exact batch' }).click();
  await page.getByRole('heading', { name: '1. pull.merge · unknown', exact: true }).waitFor();
  await page.reload();
  await openNewest();
  await page.getByRole('button', { name: 'Reconcile with GitHub' }).click();
  await page
    .getByText('Provider evidence checked. The original outcome remains unresolved. No mutation was retried.', {
      exact: true,
    })
    .waitFor();
  assert.equal(mergeEffects.length, 2);
  assert.equal(await page.getByRole('button', { name: 'Continue unattempted actions' }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-batches-mobile.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS chat proposal, exact human approval, issue creation, SHA-pinned merge review, reload, lost acknowledgement, conservative merge reconciliation, no duplicate effects, mobile dark reduced motion.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await app.close();
  await f.close();
}
