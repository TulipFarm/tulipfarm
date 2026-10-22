import assert from 'node:assert/strict';
import { openGitHubReview, openGitHubDetails } from './github-review.fixture.mjs';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { githubDiscussionFixture } from '../../worker/test/github-discussion-fixture.mjs';
import { discussionOperations, discussionTarget } from '../../../packages/github/test/discussion-provider-fixture.mjs';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { registerGitHubBatches } from '../../api/src/github-batches.ts';
import { registerConversations } from '../../api/src/conversations.ts';
import { createGitHubBatchDecision } from '../../../packages/github/dist/batch-approval.js';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = 5238,
  origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await githubDiscussionFixture(),
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
  slug: 'github-discussions',
  name: 'GitHub Discussions',
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
  let failReads = false,
    delayReads = 0;
  await page.route('**/v1/**', async route => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (path.includes('/github/') || path.includes('/conversations')) {
      if (req.method() === 'GET' && path.endsWith('/batches')) {
        await setTimeout(delayReads);
        if (failReads) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      }
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
              membershipId: f.member.membershipId,
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
  const article = name => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const visit = () => page.goto(`${origin}/${workspace.slug}/chat/${f.chatId}`);
  await visit();
  await page.getByRole('textbox', { name: 'Message' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve exact batch' }).count(), 0);
  const create = await f.propose(
    [discussionOperations[0]],
    [{ kind: 'discussion.categories', owner: 'octocat', repo: 'private' }],
  );
  delayReads = 700;
  await page.reload();
  await page.getByText('Checking GitHub approvals…', { exact: true }).waitFor();
  delayReads = 0;
  await openGitHubReview(page, create.snapshot.id);
  const review = article('1. discussion.create · unattempted');
  await review.waitFor();
  await openGitHubDetails(review);
  assert.deepEqual(JSON.parse(await review.locator('pre').first().innerText()), create.snapshot.actions[0]);
  assert.equal(f.effects.length, 0);
  await review.getByText(/notify repository subscribers/).waitFor();
  await review.getByRole('button', { name: 'Approve exact batch' }).focus();
  await page.keyboard.press('Enter');
  await article('1. discussion.create · succeeded').waitFor();
  const receipt = (await f.read(create)).actions[0].result;
  assert.equal(f.discussions.get(receipt.discussionId).title, 'Release questions');
  await f.freshChat();
  const target = {
    ...discussionTarget,
    discussionId: receipt.discussionId,
    discussionNumber: receipt.discussionNumber,
  };
  const comment = await f.propose([
    { kind: 'discussion.comment-create', ...target, replyToId: null, body: 'Resolved with the release checklist.' },
  ]);
  await visit();
  await openGitHubReview(page, comment.snapshot.id);
  await article('1. discussion.comment-create · unattempted')
    .getByRole('button', { name: 'Approve exact batch' })
    .click();
  await article('1. discussion.comment-create · succeeded').waitFor();
  const commentId = (await f.read(comment)).actions[0].result.commentId;
  const edits = await f.propose([
    {
      kind: 'discussion.update',
      ...target,
      categoryId: 'DIC_1',
      title: 'Release questions resolved',
      body: 'See the answer.',
    },
    { kind: 'discussion.answer-mark', ...target, commentId },
  ]);
  await page.reload();
  await openGitHubReview(page, edits.snapshot.id);
  const editReview = article('1. discussion.update · unattempted');
  await editReview.waitFor();
  await openGitHubDetails(editReview);
  assert.deepEqual(JSON.parse(await editReview.locator('pre').first().innerText()), edits.snapshot.actions[0]);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-discussions-review.png',
    fullPage: true,
  });
  await editReview.getByRole('button', { name: 'Approve exact batch' }).click();
  await article('2. discussion.answer-mark · succeeded').waitFor();
  assert.equal(f.discussions.get(target.discussionId).answer.id, commentId);
  assert.equal(f.discussions.get(target.discussionId).title, 'Release questions resolved');
  await f.freshChat();
  const cleanup = await f.propose(
    [
      { kind: 'discussion.answer-unmark', ...target, commentId },
      { kind: 'discussion.comment-delete', ...target, commentId },
      { kind: 'discussion.delete', ...target },
      {
        kind: 'issue.comment',
        owner: 'octocat',
        repo: 'private',
        issueNumber: 7,
        body: 'Archived the resolved discussion.',
      },
    ],
    [{ kind: 'discussion.read', owner: 'octocat', repo: 'private', number: target.discussionNumber }],
  );
  assert.equal(
    cleanup.snapshot.sources.some(s => s.proof?.discussionIdentity?.discussionId === target.discussionId),
    true,
  );
  await visit();
  await openGitHubReview(page, cleanup.snapshot.id);
  const cleanupReview = article('1. discussion.answer-unmark · unattempted');
  await cleanupReview.getByText(/Permanently delete discussion/).waitFor();
  await cleanupReview.getByRole('button', { name: 'Approve exact batch' }).click();
  await article('4. issue.comment · succeeded').waitFor();
  assert.equal(f.discussions.has(target.discussionId), false);
  assert.equal(f.comments.has(commentId), false);
  assert.equal(f.effects.at(-1).name, 'issueComment');
  const count = f.effects.length;
  await page.reload();
  await openGitHubReview(page, cleanup.snapshot.id);
  await article('4. issue.comment · succeeded').waitFor();
  assert.equal(f.effects.length, count);
  failReads = true;
  await page.reload();
  await page.getByRole('button', { name: 'Check approvals' }).waitFor();
  const failedRetry = page.waitForResponse(
    response => response.url().endsWith('/batches') && response.status() === 503,
  );
  await page.getByRole('button', { name: 'Check approvals' }).click();
  await failedRetry;
  await page.getByRole('button', { name: 'Check approvals' }).waitFor();
  failReads = false;
  await page.getByRole('button', { name: 'Check approvals' }).click();
  await openGitHubReview(page, cleanup.snapshot.id);
  await article('4. issue.comment · succeeded').waitFor();
  await f.freshChat();
  const uncertain = await f.propose([discussionOperations[1], discussionOperations[4]]);
  f.state.lose = true;
  await visit();
  await openGitHubReview(page, uncertain.snapshot.id);
  await article('1. discussion.update · unattempted').getByRole('button', { name: 'Approve exact batch' }).click();
  const unknown = article('1. discussion.update · unknown');
  await unknown.waitFor();
  await unknown.getByRole('button', { name: 'Reconcile with GitHub' }).click();
  await unknown
    .getByText('Provider evidence checked. The original outcome remains unresolved. No mutation was retried.', {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(
    (await f.status(uncertain)).actions.map(a => a.status),
    ['unknown', 'unattempted'],
  );
  assert.equal(f.effects.length, count + 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await unknown.getByRole('button', { name: 'Reconcile with GitHub' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-discussions-unknown-mobile.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(f.schemaErrors, []);
  console.log(
    'PASS category discovery, exact approvals, create discussion and comment, edit and mark answer, unmark and delete both objects, succeeding unrelated effect, reload, slow loading, empty, failed reads and retry, keyboard, lost acknowledgement, no replay, mobile dark reduced motion.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await app.close();
  await f.close();
}
