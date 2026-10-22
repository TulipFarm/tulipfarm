import assert from 'node:assert/strict';
import { openGitHubReview, openGitHubDetails } from './github-review.fixture.mjs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { githubReleaseFixture } from '../../worker/test/github-release-fixture.mjs';
import { createConversationActivities } from '../../worker/src/conversation-activities.ts';
import { releaseOperations, upload, binary } from '../../../packages/github/test/release-provider-fixture.mjs';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { registerGitHubBatches } from '../../api/src/github-batches.ts';
import { registerConversations } from '../../api/src/conversations.ts';
import { createGitHubBatchDecision } from '../../../packages/github/dist/batch-approval.js';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = 5236,
  origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await githubReleaseFixture(),
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
  slug: 'github-releases',
  name: 'GitHub releases',
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
      if (req.method() === 'POST' && path.endsWith('/retry') && result.statusCode === 200) {
        const turnId = path.split('/').at(-2);
        const { generation } = (
          await f.db.platform.query(`SELECT generation FROM ${f.table('tf_conversation_turns')} WHERE id=$1`, [turnId])
        ).rows[0];
        assert.equal(
          await createConversationActivities(f.runtime).processConversationReply({
            workspaceId: f.one.id,
            conversationId: f.chatId,
            turnId,
            generation,
          }),
          'completed',
        );
      }
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
  const invalid = { tool: 'github.personal.propose', actions: [{ ...upload, name: 'binary.bin.' }] };
  f.decide([invalid, invalid, invalid]);
  const invalidTurn = await f.store.send(f.one.id, f.member.userId, f.chatId, {
    commandId: randomUUID(),
    messageId: randomUUID(),
    model: 'claude-sonnet',
    parts: [{ kind: 'text', text: 'Upload binary.bin.' }],
  });
  await f.db.platform.query(`UPDATE ${f.table('tf_conversation_turns')} SET attempts=4 WHERE id=$1`, [
    invalidTurn.turnId,
  ]);
  assert.equal(await f.process(f.chatId, invalidTurn.turnId), 'failed');
  await page.goto(`${origin}/${workspace.slug}/chat/${f.chatId}`);
  await page
    .getByText(
      'The model could not produce a valid answer or tool request. Retry uses the original model. To use another model, select it and send a new message.',
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve exact batch' }).count(), 0);
  assert.deepEqual((await f.batches.list(f.one.id, f.member.userId, f.chatId)).batches, []);
  assert.equal(f.effects.length, 0);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-release-invalid-filename.png',
    fullPage: true,
  });
  f.decide(
    [{ tool: 'github.personal.propose', actions: [upload] }],
    'Review the corrected filename binary.bin before approving.',
  );
  await page.getByRole('button', { name: 'Retry reply', exact: true }).click();
  await page.getByRole('button', { name: 'View GitHub changes', exact: true }).waitFor();
  const batch = (await f.batches.list(f.one.id, f.member.userId, f.chatId)).batches[0];
  await openGitHubReview(page, batch.snapshot.id);
  await page.getByRole('heading', { name: '1. release.asset-upload · unattempted', exact: true }).waitFor();
  assert.equal(batch.snapshot.actions[0].name, 'binary.bin');
  assert.equal(f.effects.length, 0);
  delayReads = 700;
  await page.goto(`${origin}/${workspace.slug}/chat/${f.chatId}`);
  await page.getByText('Checking GitHub approvals…', { exact: true }).waitFor();
  delayReads = 0;
  await openGitHubReview(page, batch.snapshot.id);
  const article = name => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const uploadReview = article('1. release.asset-upload · unattempted');
  await uploadReview.waitFor();
  await openGitHubDetails(uploadReview);
  assert.deepEqual(JSON.parse(await uploadReview.locator('pre').first().innerText()), batch.snapshot.actions[0]);
  assert.equal(f.effects.length, 0);
  await uploadReview.getByText(new RegExp(`SHA-256 ${upload.sha256}`)).waitFor();
  await uploadReview.getByRole('button', { name: 'Approve exact batch' }).focus();
  await page.keyboard.press('Enter');
  await article('1. release.asset-upload · succeeded').waitFor();
  assert.deepEqual(f.bytes.get(21), binary);
  const publish = await f.propose([{ ...releaseOperations[2], assetIds: [20, 21] }]);
  await page.reload();
  await openGitHubReview(page, publish.snapshot.id);
  const publishReview = article('1. release.publish · unattempted');
  await publishReview.waitFor();
  await openGitHubDetails(publishReview);
  await publishReview.getByText(/makes the draft available to repository readers/).waitFor();
  assert.deepEqual(JSON.parse(await publishReview.locator('pre').first().innerText()), publish.snapshot.actions[0]);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-release-publish.png',
    fullPage: true,
  });
  await publishReview.getByRole('button', { name: 'Approve exact batch' }).click();
  await article('1. release.publish · succeeded').waitFor();
  assert.equal(f.releases.get(10).draft, false);
  assert.equal(f.effects.length, 2);
  await page.reload();
  await openGitHubReview(page, publish.snapshot.id);
  await article('1. release.publish · succeeded').waitFor();
  assert.equal(f.effects.length, 2);
  const deletion = await f.propose(
    [{ ...releaseOperations[3], expectedUpdatedAt: '2026-10-02T00:00:01Z', assetIds: [20, 21] }],
    [
      { kind: 'release.read', owner: 'octocat', repo: 'private', id: 10 },
      { kind: 'release.asset', owner: 'octocat', repo: 'private', id: 20 },
      { kind: 'repository.read', owner: 'outside', repo: 'source' },
    ],
  );
  await page.reload();
  await openGitHubReview(page, deletion.snapshot.id);
  const deleteReview = article('1. release.delete · unattempted');
  await deleteReview.waitFor();
  await deleteReview.getByText(/Permanently delete release 10 and its listed assets/).waitFor();
  await deleteReview.getByRole('button', { name: 'Approve exact batch' }).click();
  await article('1. release.delete · succeeded').waitFor();
  assert.equal(f.releases.has(10), false);
  assert.equal(f.assets.has(20), false);
  assert.equal(f.assets.has(21), false);
  assert.equal((await f.read(deletion)).actions[0].status, 'succeeded');
  f.state.outsideDeny = true;
  await page.reload();
  await openGitHubReview(page, deletion.snapshot.id);
  await page.getByRole('heading', { name: 'GitHub batch status', exact: true }).waitFor();
  assert.equal(await article('1. release.delete · succeeded').count(), 0);
  f.state.outsideDeny = false;
  await page.getByRole('button', { name: 'Check private details' }).click();
  await article('1. release.delete · succeeded').waitFor();
  failReads = true;
  await page.reload();
  await page.getByRole('button', { name: 'Check approvals' }).click();
  await page.getByText('Checking GitHub approvals…', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Check approvals' }).waitFor();
  failReads = false;
  await page.getByRole('button', { name: 'Check approvals' }).click();
  await openGitHubReview(page, deletion.snapshot.id);
  await article('1. release.delete · succeeded').waitFor();
  f.releases.set(10, {
    id: 10,
    tag_name: 'v1.0',
    target_commitish: 'main',
    name: 'Version one',
    body: 'Reviewed notes',
    draft: true,
    prerelease: false,
    updated_at: '2026-10-02T00:00:00Z',
    assets: [],
    author: { id: 123 },
  });
  await f.freshChat();
  const uncertain = await f.propose([{ ...releaseOperations[2], assetIds: [] }]);
  f.state.lose = true;
  await page.goto(`${origin}/${workspace.slug}/chat/${f.chatId}`);
  await openGitHubReview(page, uncertain.snapshot.id);
  await article('1. release.publish · unattempted').getByRole('button', { name: 'Approve exact batch' }).click();
  const unknown = article('1. release.publish · unknown');
  await unknown.waitFor();
  await unknown.getByText(/Do not repeat this action or propose a replacement/).waitFor();
  const effects = f.effects.length;
  await unknown.getByRole('button', { name: 'Reconcile with GitHub' }).click();
  await unknown
    .getByText('Provider evidence checked. The original outcome remains unresolved. No mutation was retried.', {
      exact: true,
    })
    .waitFor();
  assert.equal((await f.status(uncertain)).actions[0].status, 'unknown');
  assert.equal(f.effects.length, effects);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-release-unknown-mobile.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS invalid filename before approval, failed reply recovery to corrected review, exact binary upload, publication, destructive approval, actual HTTP effects, reload, source concealment/recovery, repeated read failures, unresolved nonretry state, keyboard and mobile dark reduced motion.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await app.close();
  await f.close();
}
