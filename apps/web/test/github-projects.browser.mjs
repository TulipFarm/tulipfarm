import assert from 'node:assert/strict';
import { openGitHubReview, openGitHubDetails } from './github-review.fixture.mjs';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { githubProjectFixture } from '../../worker/test/github-project-fixture.mjs';
import {
  projectOperations,
  projectOwner,
  draftTarget,
} from '../../../packages/github/test/project-provider-fixture.mjs';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { registerGitHubBatches } from '../../api/src/github-batches.ts';
import { registerConversations } from '../../api/src/conversations.ts';
import { createGitHubBatchDecision } from '../../../packages/github/dist/batch-approval.js';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = 5239,
  origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await githubProjectFixture(),
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
  slug: 'github-projects',
  name: 'GitHub Projects',
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
  page.setDefaultTimeout(30000);
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
  const create = await f.propose([projectOperations[0]]);
  delayReads = 700;
  await page.reload();
  await page.getByText('Checking GitHub approvals…', { exact: true }).waitFor();
  delayReads = 0;
  await openGitHubReview(page, create.snapshot.id);
  const review = article('1. project.create · unattempted');
  await review.waitFor();
  await openGitHubDetails(review);
  assert.deepEqual(JSON.parse(await review.locator('pre').first().innerText()), create.snapshot.actions[0]);
  assert.equal(f.effects.length, 0);
  await review.getByText(/Project owner octocat/).waitFor();
  await review.getByRole('button', { name: 'Approve exact batch' }).focus();
  await page.keyboard.press('Enter');
  await article('1. project.create · succeeded').waitFor();
  const receipt = (await f.read(create)).actions[0].result,
    target = { ...projectOwner, projectId: receipt.projectId, projectNumber: receipt.projectNumber };
  assert.equal(f.projects.get(receipt.projectId).title, 'Delivery plan');
  await f.freshChat();
  const objects = await f.propose([
    { kind: 'project.field-create', ...target, field: { dataType: 'TEXT', name: 'Delivery notes' } },
    { kind: 'project.draft-create', ...target, title: 'Review release', body: 'Check the release checklist.' },
  ]);
  await visit();
  await openGitHubReview(page, objects.snapshot.id);
  const objectsReview = article('1. project.field-create · unattempted');
  await objectsReview.getByRole('button', { name: 'Approve exact batch' }).click();
  await article('2. project.draft-create · succeeded').waitFor();
  const objectReceipts = (await f.read(objects)).actions;
  const item = {
      ...target,
      itemId: objectReceipts[1].result.itemId,
      content: { type: 'DraftIssue', id: objectReceipts[1].result.contentId },
    },
    fieldId = objectReceipts[0].result.fieldId;
  await f.freshChat();
  const edits = await f.propose([
    { kind: 'project.draft-update', ...item, title: 'Release reviewed', body: 'Ready to ship.' },
    { kind: 'project.value-set', ...item, fieldId, value: { dataType: 'TEXT', text: 'Approved after review' } },
    { kind: 'project.item-archive', ...item },
  ]);
  await visit();
  await openGitHubReview(page, edits.snapshot.id);
  const editReview = article('1. project.draft-update · unattempted');
  await editReview.waitFor();
  await openGitHubDetails(editReview);
  assert.deepEqual(JSON.parse(await editReview.locator('pre').first().innerText()), edits.snapshot.actions[0]);
  await page.screenshot({
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-projects-review.png',
    fullPage: true,
  });
  await editReview.getByRole('button', { name: 'Approve exact batch' }).click();
  await article('3. project.item-archive · succeeded').waitFor();
  assert.equal(f.items.get(item.itemId).isArchived, true);
  assert.equal(f.contents.get(item.content.id).body, 'Ready to ship.');
  await f.freshChat();
  const cleanup = await f.propose(
    [
      { kind: 'project.item-unarchive', ...item },
      { kind: 'project.value-clear', ...item, fieldId, dataType: 'TEXT' },
      { kind: 'project.item-delete', ...item },
      { kind: 'project.field-delete', ...target, fieldId },
      { kind: 'project.close', ...target },
      { kind: 'project.reopen', ...target },
      { kind: 'project.delete', ...target },
      { kind: 'issue.comment', owner: 'octocat', repo: 'private', issueNumber: 7, body: 'Project complete.' },
    ],
    [
      {
        kind: 'project.item',
        owner: target.owner,
        ownerType: target.ownerType,
        number: target.projectNumber,
        itemId: item.itemId,
      },
    ],
  );
  assert.equal(
    cleanup.snapshot.sources.some(s => s.proof?.projectIdentity?.projectId === target.projectId),
    true,
  );
  await visit();
  await openGitHubReview(page, cleanup.snapshot.id);
  const cleanupReview = article('1. project.item-unarchive · unattempted');
  await cleanupReview.getByText(/Permanently delete project/).waitFor();
  await cleanupReview.getByRole('button', { name: 'Approve exact batch' }).click();
  await article('8. issue.comment · succeeded').waitFor();
  assert.equal(f.projects.has(target.projectId), false);
  assert.equal(f.items.has(item.itemId), false);
  assert.equal(f.effects.at(-1).name, 'issueComment');
  const count = f.effects.length;
  await page.reload();
  await openGitHubReview(page, cleanup.snapshot.id);
  await article('8. issue.comment · succeeded').waitFor();
  assert.equal(f.effects.length, count);
  failReads = true;
  await page.reload();
  await page.getByRole('button', { name: 'Check approvals' }).click();
  await page.getByText('Checking GitHub approvals…', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Check approvals' }).waitFor();
  failReads = false;
  await page.getByRole('button', { name: 'Check approvals' }).click();
  await openGitHubReview(page, cleanup.snapshot.id);
  await article('8. issue.comment · succeeded').waitFor();
  await f.freshChat();
  const privateBatch = await f.propose([projectOperations[1]]);
  const independent = await f.propose([
    { kind: 'issue.comment', owner: 'octocat', repo: 'private', issueNumber: 7, body: 'Independent approval.' },
  ]);
  f.state.deny = true;
  await visit();
  await openGitHubReview(page, independent.snapshot.id);
  await article('1. issue.comment · unattempted').waitFor();
  await openGitHubReview(page, privateBatch.snapshot.id);
  const hidden = article('GitHub batch status');
  await hidden.getByText('Action 1: unattempted', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '1. project.update · unattempted', exact: true }).count(), 0);
  assert.equal(await hidden.locator('pre').count(), 0);
  f.state.deny = false;
  await hidden.getByRole('button', { name: 'Check private details' }).click();
  const restored = article('1. project.update · unattempted');
  await restored.waitFor();
  await openGitHubDetails(restored);
  assert.deepEqual(JSON.parse(await restored.locator('pre').first().innerText()), privateBatch.snapshot.actions[0]);
  assert.equal(f.effects.length, count);
  await f.freshChat();
  const field = f.fields.get('F_MULTI_SELECT');
  field.multiSelectOptions.push({ id: 'OPT_2', name: 'Second', color: 'GREEN', description: '' });
  const uncertain = await f.propose([
    {
      kind: 'project.value-set',
      ...draftTarget,
      fieldId: field.id,
      value: { dataType: 'MULTI_SELECT', multiSelectOptionIds: ['OPT_1', 'OPT_2'] },
    },
    { kind: 'issue.comment', owner: 'octocat', repo: 'private', issueNumber: 7, body: 'Only after exact values.' },
  ]);
  f.items.get('PI_1').fieldValues = () => ({
    nodes: [{ __typename: 'ProjectV2ItemFieldMultiSelectValue', field, options: [{ id: 'OPT_1' }, { id: 'OPT_1' }] }],
    pageInfo: { hasNextPage: false },
  });
  await visit();
  await openGitHubReview(page, uncertain.snapshot.id);
  await article('1. project.value-set · unattempted').getByRole('button', { name: 'Approve exact batch' }).click();
  const unknown = article('1. project.value-set · unknown');
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
    path: '/var/folders/7d/qk8p6t3d1jvfnh4503bz0msr0000gn/T/opencode/github-projects-unknown-mobile.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(f.schemaErrors, []);
  console.log(
    'PASS Projects multiobject creation, exact review, values, archive/unarchive, deletion chain, unrelated effect, reload, loading, empty, retry, keyboard, revoked-target isolation and recovery, duplicate-value unknown recovery, no replay, mobile dark reduced motion.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await app.close();
  await f.close();
}
