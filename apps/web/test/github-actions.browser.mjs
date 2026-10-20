import assert from 'node:assert/strict';
import { openGitHubReview, openGitHubDetails } from './github-review.fixture.mjs';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { githubActionsFixture } from '../../worker/test/github-actions-fixture.mjs';
import { actionsOperations } from '../../../packages/github/test/actions-provider-fixture.mjs';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { registerGitHubBatches } from '../../api/src/github-batches.ts';
import { registerConversations } from '../../api/src/conversations.ts';
import { createGitHubBatchDecision } from '../../../packages/github/dist/batch-approval.js';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = 5237,
  origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await githubActionsFixture(),
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
  slug: 'github-actions',
  name: 'GitHub Actions',
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
  const article = name => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await page.goto(`${origin}/${workspace.slug}/chat/${f.chatId}`);
  await page.getByRole('textbox', { name: 'Message' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve exact batch' }).count(), 0);
  const dispatch = await f.propose([actionsOperations[0]]);
  delayReads = 700;
  await page.reload();
  await page.getByText('Checking GitHub approvals…', { exact: true }).waitFor();
  delayReads = 0;
  await openGitHubReview(page, dispatch.snapshot.id);
  const review = article('1. actions.dispatch · unattempted');
  await review.waitFor();
  await openGitHubDetails(review);
  assert.deepEqual(JSON.parse(await review.locator('pre').first().innerText()), dispatch.snapshot.actions[0]);
  assert.equal(f.effects.length, 0);
  await review.getByText(/may consume runner minutes or trigger deployment steps/).waitFor();
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-actions-dispatch.png',
    fullPage: true,
  });
  await review.getByRole('button', { name: 'Approve exact batch' }).focus();
  await page.keyboard.press('Enter');
  await article('1. actions.dispatch · succeeded').waitFor();
  assert.equal(f.runs.get(22).status, 'queued');
  assert.equal((await f.read(dispatch)).actions[0].result.runId, 22);
  await page.reload();
  await openGitHubReview(page, dispatch.snapshot.id);
  await article('1. actions.dispatch · succeeded').waitFor();
  assert.equal(f.effects.length, 1);
  let lastBatch = dispatch;
  for (const operation of [actionsOperations[1], actionsOperations[3], actionsOperations[4]]) {
    const batch = await f.propose([operation]);
    lastBatch = batch;
    await page.reload();
    await openGitHubReview(page, batch.snapshot.id);
    const current = article(`1. ${operation.kind} · unattempted`);
    await current.waitFor();
    await openGitHubDetails(current);
    assert.deepEqual(JSON.parse(await current.locator('pre').first().innerText()), batch.snapshot.actions[0]);
    if (operation.kind === 'actions.rerun')
      await current.getByText(/not a new attempt number or workflow success/).waitFor();
    if (operation.kind === 'actions.cancel')
      await current.getByText(/does not force-cancel jobs or undo completed effects/).waitFor();
    if (operation.kind === 'actions.artifact-delete')
      await current.getByText(/Permanently delete Actions artifact 30/).waitFor();
    await current.getByRole('button', { name: 'Approve exact batch' }).click();
    await article(`1. ${operation.kind} · succeeded`).waitFor();
  }
  assert.equal(f.runs.get(20).run_attempt, 2);
  assert.equal(f.runs.get(21).conclusion, 'cancelled');
  assert.equal(f.artifacts.has(30), false);
  assert.equal(f.effects.length, 4);
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
  await openGitHubReview(page, lastBatch.snapshot.id);
  await article('1. actions.artifact-delete · succeeded').waitFor();
  await f.freshChat();
  const rejected = await f.propose([actionsOperations[0]]);
  await page.goto(`${origin}/${workspace.slug}/chat/${f.chatId}`);
  await openGitHubReview(page, rejected.snapshot.id);
  await article('1. actions.dispatch · unattempted').getByRole('button', { name: 'Reject batch' }).click();
  await page.getByText(/· Rejected/).waitFor();
  assert.equal((await f.read(rejected)).decision, 'reject');
  assert.equal(f.effects.length, 4);
  const recoveryKind = process.argv[2] ?? 'dispatch';
  assert.ok(['dispatch', 'rerun', 'cancel'].includes(recoveryKind));
  f.runs.get(20).status = 'completed';
  f.runs.get(21).status = 'in_progress';
  const recoveryOperation =
    recoveryKind === 'rerun'
      ? { ...actionsOperations[1], runAttempt: 2 }
      : recoveryKind === 'cancel'
        ? actionsOperations[3]
        : actionsOperations[0];
  const uncertain = await f.propose([recoveryOperation, actionsOperations[4]]);
  f.state.lose = true;
  await page.reload();
  await openGitHubReview(page, uncertain.snapshot.id);
  const pending = article(`1. ${recoveryOperation.kind} · unattempted`).filter({
    has: page.getByRole('button', { name: 'Approve exact batch' }),
  });
  await pending.waitFor();
  await openGitHubDetails(pending);
  assert.deepEqual(JSON.parse(await pending.locator('pre').first().innerText()), uncertain.snapshot.actions[0]);
  await pending.getByRole('button', { name: 'Approve exact batch' }).click();
  const unknown = article(`1. ${recoveryOperation.kind} · unknown`);
  await unknown.waitFor();
  await unknown.getByText(/Do not repeat this action or propose a replacement/).waitFor();
  const effects = f.effects.length;
  await unknown.getByRole('button', { name: 'Reconcile with GitHub' }).click();
  await unknown
    .getByText('Provider evidence checked. The original outcome remains unresolved. No mutation was retried.', {
      exact: true,
    })
    .waitFor();
  assert.deepEqual(
    (await f.status(uncertain)).actions.map(action => action.status),
    ['unknown', 'unattempted'],
  );
  assert.equal(f.effects.length, effects);
  assert.equal(await unknown.getByRole('button', { name: 'Continue unattempted actions' }).count(), 0);
  await page.reload();
  await openGitHubReview(page, uncertain.snapshot.id);
  await article(`1. ${recoveryOperation.kind} · unknown`).waitFor();
  assert.equal(f.effects.length, effects);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await unknown.getByRole('button', { name: 'Reconcile with GitHub' }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-actions-${recoveryKind}-unknown-mobile.png`,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    `PASS exact Actions dispatch, rerun, normal cancellation, artifact deletion, provider effects, reload, loading/empty/error recovery, keyboard approval, rejection, ${recoveryKind} lost acknowledgement with read-only reconciliation, no duplicates, mobile dark reduced motion.`,
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await app.close();
  await f.close();
}
