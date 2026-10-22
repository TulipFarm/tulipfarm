import assert from 'node:assert/strict';
import { openGitHubReview, openGitHubDetails } from './github-review.fixture.mjs';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { githubFileFixture } from '../../worker/test/github-file-fixture.mjs';
import { fileTarget, headSha, blob } from '../../../packages/github/test/file-provider-fixture.mjs';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { registerGitHubBatches } from '../../api/src/github-batches.ts';
import { registerConversations } from '../../api/src/conversations.ts';
import { createGitHubBatchDecision } from '../../../packages/github/dist/batch-approval.js';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = 5235,
  origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await githubFileFixture(),
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
  slug: 'github-files',
  name: 'GitHub files',
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
  const text = 'Exact reviewed text.\nSecond line <not HTML>.\n';
  const operation = {
    kind: 'files.commit',
    ...fileTarget,
    message: 'Commit reviewed file changes',
    files: [
      { kind: 'create', path: 'new.txt', encoding: 'base64', content: Buffer.from(text).toString('base64') },
      { kind: 'delete', path: 'old.txt', blobSha: blob('old text\n') },
    ],
  };
  const confirmed = 'Provider evidence checked. The original success was confirmed.';
  const rejected = await f.propose([operation]);
  await f.approve(rejected);
  f.state.reject = '/git/refs/heads/main';
  await f.worker(rejected);
  const rejectedReceipt = (
    await f.db.platform.query(
      `SELECT status,result,reconciliation FROM ${f.table('tf_github_action_receipts')} WHERE batch_id=$1 AND ordinal=0`,
      [rejected.snapshot.id],
    )
  ).rows[0];
  assert.equal(rejectedReceipt.status, 'rejected');
  assert.equal(rejectedReceipt.result, null);
  assert.equal(rejectedReceipt.reconciliation.phase, 'ref-dispatch');
  assert.equal(f.branches.get('main'), headSha);
  assert.equal(f.effects.length, 2);
  assert.equal(
    f.requests.filter(request => request.method === 'PATCH' && request.path.endsWith('/git/refs/heads/main')).length,
    1,
  );
  await page.goto(`${origin}/${workspace.slug}/chat/${f.chatId}`);
  await openGitHubReview(page, rejected.snapshot.id);
  const rejection = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: '1. files.commit · rejected', exact: true }) });
  await rejection.waitFor();
  assert.equal(
    await rejection.getByText(confirmed, { exact: true }).count(),
    0,
    'Rejected final ref update must not claim confirmed success',
  );
  await rejection
    .getByText('The action was rejected. Saved preparatory evidence does not confirm success.', { exact: true })
    .waitFor();
  console.log(
    'PASS final ref 422, worker receipt rejected with null result and saved candidate, unchanged branch, browser reports rejection without confirmed success.',
  );
  const recovery = await f.propose([
    {
      ...operation,
      branch: 'other',
      files: [{ kind: 'create', path: 'recovered.txt', encoding: 'utf-8', content: 'Recovered exact text' }],
    },
  ]);
  await f.approve(recovery);
  f.state.lose = '/git/refs/heads/other';
  await f.worker(recovery);
  assert.equal((await f.read(recovery)).actions[0].status, 'unknown');
  const effectsBeforeRecovery = f.effects.length;
  await page.reload();
  await openGitHubReview(page, recovery.snapshot.id);
  await page.getByRole('heading', { name: '1. files.commit · unknown', exact: true }).waitFor();
  assert.equal(await page.getByText(confirmed, { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Reconcile with GitHub', exact: true }).click();
  await page.getByText(confirmed, { exact: true }).waitFor();
  const recoveredReceipt = (
    await f.db.platform.query(
      `SELECT status,result,reconciliation FROM ${f.table('tf_github_action_receipts')} WHERE batch_id=$1 AND ordinal=0`,
      [recovery.snapshot.id],
    )
  ).rows[0];
  assert.equal(recoveredReceipt.status, 'succeeded');
  assert.equal(recoveredReceipt.reconciliation.outcome, 'confirmed-original-success');
  assert.equal(recoveredReceipt.result.commitSha, f.branches.get('other'));
  assert.equal(f.effects.length, effectsBeforeRecovery);
  await page.reload();
  await openGitHubReview(page, recovery.snapshot.id);
  await page.getByText(confirmed, { exact: true }).waitFor();
  console.log(
    'PASS lost ref acknowledgement reconciles to attributable succeeded receipt, browser confirms original success after recovery and reload, no repeated mutation.',
  );
  f.state.reject = '';
  const preparationEffects = f.effects.length;
  const batch = await f.propose(
    [operation],
    [
      { kind: 'file.read', owner: 'octocat', repo: 'private', path: 'old.txt', ref: 'main' },
      { kind: 'repository.read', owner: 'outside', repo: 'source' },
    ],
  );
  await page.goto(`${origin}/${workspace.slug}/chat/${f.chatId}`);
  const review = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: '1. files.commit · unattempted', exact: true }) });
  await openGitHubReview(page, batch.snapshot.id);
  await review.waitFor();
  await openGitHubDetails(review);
  assert.deepEqual(JSON.parse(await review.locator('pre').first().innerText()), batch.snapshot.actions[0]);
  assert.equal(await review.getByLabel('Exact text for new.txt').textContent(), text);
  assert.equal(f.effects.length, preparationEffects);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-file-review.png',
    fullPage: true,
  });
  await review.getByRole('button', { name: 'Approve exact batch' }).focus();
  await page.keyboard.press('Enter');
  const success = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: '1. files.commit · succeeded', exact: true }) })
    .filter({ has: page.getByLabel('Exact text for new.txt') });
  await success.waitFor();
  assert.equal(f.current().get('new.txt').content, text);
  assert.equal(f.current().has('old.txt'), false);
  assert.equal(f.current().get('keep.txt').content, 'untouched\n');
  const commit = f.branches.get('main');
  assert.equal((await f.read(batch)).actions[0].result.commitSha, commit);
  await page.reload();
  await openGitHubReview(page, batch.snapshot.id);
  await success.waitFor();
  await openGitHubDetails(success);
  assert.equal((await page.getByText(new RegExp(commit)).count()) > 0, true);
  assert.equal(f.effects.length, preparationEffects + 3);
  assert.equal(
    await success.getByText(confirmed, { exact: true }).count(),
    0,
    'Direct success with a preparatory candidate is not reconciled success',
  );
  f.state.outsideDeny = true;
  await page.reload();
  await openGitHubReview(page, batch.snapshot.id);
  await page.getByRole('heading', { name: 'GitHub batch status', exact: true }).waitFor();
  assert.equal(await success.count(), 0);
  f.state.outsideDeny = false;
  await page.getByRole('button', { name: 'Check private details' }).click();
  await success.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-file-receipt-mobile.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS exact file payload and decoded text, keyboard approval, atomic HTTP commit, retained receipt, reload, own deletion source, outside-source concealment and recovery, mobile dark reduced motion.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await app.close();
  await f.close();
}
