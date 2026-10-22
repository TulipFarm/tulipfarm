import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import { githubChatFixture } from '../../worker/test/github-read-fixture.mjs';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { createAgentExecutor } from '../../../packages/agents/dist/executor.js';
import { createAgentTasks } from '../../../packages/agents/dist/tasks.js';
import { createTaskApprovals } from '../../../packages/agents/dist/task-approvals.js';
import { createGitHubBatches } from '../../../packages/github/dist/batches.js';
import { createGitHubBatchDecision } from '../../../packages/github/dist/batch-approval.js';
import { createGitHubInvestigation } from '../../../packages/github/dist/investigation.js';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { registerGitHubTasks } from '../../api/src/github-tasks.ts';
import { registerGitHubInvestigation } from '../../api/src/github-investigation.ts';
import { registerAgentTasks } from '../../api/src/agent-tasks.ts';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const port = 5243,
  origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await githubChatFixture(),
  app = Fastify();
const actor = { kind: 'human', ...f.member };
const agent = await savedTaskAgent(
  f.db,
  f.one,
  f.runtime,
  actor.userId,
  actor.membershipId,
  [],
  ['github.personal.read', 'github.personal.propose'],
);
await createAgentExecutor({ runtime: f.runtime }).configure(
  f.one.id,
  { kind: 'human', userId: f.one.userId, membershipId: f.one.membershipId },
  { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
);
const tasks = createAgentTasks(f.runtime);
const task = await tasks.start(f.one.id, actor.userId, {
  requestId: randomUUID(),
  agentId: agent.agentId,
  text: 'Create a private GitHub issue.',
});
await createTaskApprovals(f.runtime).bindRun(f.one.id, actor.userId, task.id, { generation: 0 });
await tasks.pause(f.one.id, actor.userId, task.id, { expectedGeneration: 0 });
const accountId = await f.connect(123);
f.setProvider(async () => Response.json({ id: 1 }));
const options = { runtime: f.runtime, accounts: f.service, requireSources: async () => {} };
const batches = createGitHubBatches(options);
const decide = createGitHubBatchDecision({
  ...options,
  resolveConfirmationCredential: async () => f.db.login(f.one, 'confirmation'),
});
const auth = { api: { getSession: async () => ({ user: { id: actor.userId }, session: { id: 'browser' } }) } };
await app.register(
  async routes => {
    registerGitHubAccounts(routes, auth, f.service, f.reads);
    registerGitHubTasks(routes, { auth, reads: f.reads, batches, decide });
    // The task page reads the task's GitHub investigation before offering accounts (cloud agent-tasks.tsx GitHubTaskSourceCard, app.ts composition).
    registerGitHubInvestigation(routes, auth, createGitHubInvestigation({ runtime: f.runtime, accounts: f.service }));
    registerAgentTasks(routes, { auth, runtime: f.runtime });
  },
  { prefix: '/v1' },
);
await app.ready();
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
const shell = createWorkspaceFixture({ id: f.one.id, slug: 'github-tasks', name: 'GitHub tasks' });
let browser,
  slow = 700,
  fail = false,
  decisions = 0;
try {
  for (let n = 0; ; n++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    if (n > 100) throw new Error('Vite unavailable');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/v1/**', async route => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (path.includes('/github/') || path.includes('/agent-tasks')) {
      if (path.endsWith('/selection') && req.method() === 'GET') {
        await delay(slow);
        if (fail) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      }
      if (path.endsWith('/decision')) decisions++;
      const response = await app.inject({
        method: req.method(),
        url: path + url.search,
        headers: { origin, ...(req.postData() ? { 'content-type': 'application/json' } : {}) },
        ...(req.postData() ? { payload: req.postData() } : {}),
      });
      return route.fulfill({ status: response.statusCode, contentType: 'application/json', body: response.body });
    }
    if (path === '/v1/auth/get-session')
      return route.fulfill({ json: { ...shell.session, user: { ...shell.session.user, id: actor.userId } } });
    if (path === '/v1/workspaces') return route.fulfill({ json: [shell.workspace] });
    if (path === '/v1/workspaces/github-tasks') return route.fulfill({ json: shell.workspace });
    if (path.endsWith('/governance/me'))
      return route.fulfill({
        json: {
          membershipId: actor.membershipId,
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        },
      });
    if (path.endsWith(`/agents/${agent.agentId}`)) return route.fulfill({ status: 404, json: { error: 'not-found' } });
    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  });
  await page.goto(`${origin}/github-tasks/agent-tasks/${task.id}`);
  await page.getByText('Loading GitHub accounts…').waitFor();
  assert.equal(await page.getByText('No personal GitHub accounts connected.').count(), 0);
  // The chosen account reads "· Selected" since cloud fddafcd4 (#390), features/chat/github-account-card.tsx:53.
  await page.getByRole('button', { name: 'person-123', exact: true }).click();
  await page.getByRole('button', { name: 'person-123 · Selected', exact: true, pressed: true }).waitFor();
  assert.equal((await f.reads.selection(f.one.id, actor.userId, { taskId: task.id })).accountId, accountId);
  slow = 0;
  await page.reload();
  await page.getByRole('button', { name: 'person-123 · Selected', exact: true, pressed: true }).waitFor();
  fail = true;
  await page.reload();
  await page.getByText('Could not load GitHub accounts').waitFor();
  const failedRetry = page.waitForResponse(
    response => response.url().endsWith('/selection') && response.status() === 503,
  );
  await page.getByRole('button', { name: 'Retry loading accounts' }).click();
  await failedRetry;
  await page.getByText('Could not load GitHub accounts').waitFor();
  fail = false;
  await page.getByRole('button', { name: 'Retry loading accounts' }).click();
  await page.getByRole('button', { name: 'person-123 · Selected', exact: true, pressed: true }).waitFor();
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='pending' WHERE id=$1`, [task.id]);
  const batch = await batches.propose(
    f.one.id,
    actor,
    randomUUID(),
    { taskId: task.id, callId: randomUUID(), generation: 0, sources: [] },
    {
      actions: [
        {
          kind: 'issue.create',
          owner: 'octocat',
          repo: 'private',
          title: 'Browser exact issue',
          body: 'Exact private body',
        },
      ],
    },
  );
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='waiting-approval' WHERE id=$1`, [task.id]);
  await page.reload();
  await page.getByRole('button', { name: 'View GitHub changes', exact: true }).click();
  await page.getByText('Review GitHub changes', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Approve exact batch', exact: true }).click();
  await page
    .getByText('Approval saved. The task worker resumes eligible actions and records their outcomes.')
    .waitFor();
  assert.equal(decisions, 1);
  assert.equal(
    (await batches.read(f.one.id, actor.userId, { taskId: task.id }, batch.snapshot.id)).decision,
    'approve',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(
    'PASS GitHub task account selection, reload, loading, repeated failure/recovery, exact protected approval, and narrow dark layout with real API and PostgreSQL.',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await app.close();
  await f.close();
}
