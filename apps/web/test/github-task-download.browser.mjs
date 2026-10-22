import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import Fastify from '../../api/node_modules/fastify/fastify.js';
import cors from '../../api/node_modules/@fastify/cors/index.js';
import { githubDownloadFixture, archive } from '../../worker/test/github-download-fixture.mjs';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';
import { createAgentExecutor } from '../../../packages/agents/dist/executor.js';
import { createGitHubTaskTools } from '../../../packages/agents/dist/github-tasks.js';
import { createAgentTasks } from '../../../packages/agents/dist/tasks.js';
import { createTaskApprovals } from '../../../packages/agents/dist/task-approvals.js';
import { createGitHubBatches } from '../../../packages/github/dist/batches.js';
import { createGitHubBatchDecision } from '../../../packages/github/dist/batch-approval.js';
import { requireDraftSources } from '../../../packages/agents/dist/draft-sources.js';
import { registerGitHubAccounts } from '../../api/src/github-accounts.ts';
import { registerGitHubTasks } from '../../api/src/github-tasks.ts';
import { registerAgentTasks } from '../../api/src/agent-tasks.ts';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const socket = createServer().listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
process.env.WEB_ORIGIN = origin;
const f = await githubDownloadFixture(),
  app = Fastify();
let browser, server;
try {
  const actor = { kind: 'human', ...f.member };
  const agent = await savedTaskAgent(
    f.db,
    f.one,
    f.runtime,
    actor.userId,
    actor.membershipId,
    [],
    ['github.personal.read', 'github.personal.download'],
  );
  const options = { runtime: f.runtime, accounts: f.service, requireSources: requireDraftSources };
  const executor = createAgentExecutor({
    runtime: f.runtime,
    github: runtime => createGitHubTaskTools({ ...options, runtime, accounts: f.makeService({ runtime }) }),
  });
  await executor.configure(
    f.one.id,
    { kind: 'human', userId: f.one.userId, membershipId: f.one.membershipId },
    { agentId: agent.agentId, version: 0, enabled: true, teamIds: [agent.teamId], limits: [] },
  );
  const tasks = createAgentTasks(f.runtime);
  const task = await tasks.start(f.one.id, actor.userId, {
    requestId: randomUUID(),
    agentId: agent.agentId,
    text: 'Download private release.',
  });
  const run = await createTaskApprovals(f.runtime).bindRun(f.one.id, actor.userId, task.id, { generation: 0 });
  await tasks.pause(f.one.id, actor.userId, task.id, { expectedGeneration: 0 });
  await f.reads.select(
    f.one.id,
    actor.userId,
    { taskId: task.id },
    { accountId: await f.connect(), expectedVersion: 0 },
  );
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='pending' WHERE id=$1`, [task.id]);
  const callId = randomUUID(),
    ids = { workspaceId: f.one.id, runId: run.runId, callId };
  await executor.queueCall(f.one.id, actor, {
    runId: run.runId,
    callId,
    sequence: 0,
    call: {
      tool: 'github.personal.download',
      operation: { kind: 'release.download', owner: 'octocat', repo: 'private', id: 7 },
    },
  });
  assert.equal(await executor.execute(ids), 'completed');
  const result = (await executor.readResult(ids, actor)).result;
  assert.equal(result.state, 'completed');
  const path = result.data.downloadPath;
  assert.equal(path, `/v1/workspaces/${f.one.id}/github/tasks/${task.id}/downloads/${callId}`);
  await f.db.platform.query(
    `INSERT INTO ${f.table('tf_agent_task_messages')} (task_id,sequence,generation,role,text,sources) VALUES ($1,1,0,'agent',$2,$3)`,
    [task.id, `[Download private archive](${path})`, JSON.stringify(result.sources)],
  );
  await f.db.platform.query(`UPDATE ${f.table('tf_agent_tasks')} SET status='completed' WHERE id=$1`, [task.id]);
  let userId = actor.userId;
  const auth = {
    api: { getSession: async () => ({ user: { id: userId }, session: { id: 'task-download-browser' } }) },
  };
  const batches = createGitHubBatches(options),
    decide = createGitHubBatchDecision({
      ...options,
      resolveConfirmationCredential: async () => f.db.login(f.one, 'confirmation'),
    });
  await app.register(cors, { origin, credentials: true, exposedHeaders: ['Retry-After'] });
  await app.register(
    async routes => {
      registerGitHubAccounts(routes, auth, f.service, f.reads);
      registerGitHubTasks(routes, { auth, reads: f.reads, batches, decide });
      registerAgentTasks(routes, { auth, runtime: f.runtime });
    },
    { prefix: '/v1' },
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  const api = `http://127.0.0.1:${app.server.address().port}`;
  assert.notEqual(api, origin);
  server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, VITE_API_URL: api },
    stdio: 'ignore',
  });
  const shell = createWorkspaceFixture({ id: f.one.id, slug: 'task-download', name: 'Task download' });
  for (let n = 0; ; n++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    if (n > 100) throw new Error('Vite unavailable');
    await delay(100);
  }
  const direct = await fetch(api + path);
  assert.equal(direct.status, 200);
  assert.deepEqual(Buffer.from(await direct.arrayBuffer()), archive);
  userId = f.one.userId;
  assert.equal((await fetch(api + path)).status, 404);
  userId = actor.userId;
  assert.equal((await fetch(api + path.replace(task.id, randomUUID()))).status, 404);
  const deniedOrigin = await fetch(`${api}/v1/workspaces/${f.one.id}/github/tasks/${task.id}/selection`, {
    method: 'PUT',
    headers: { origin: 'https://untrusted.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: null, expectedVersion: 1 }),
  });
  assert.equal(deniedOrigin.status, 403);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ acceptDownloads: true });
  page.setDefaultTimeout(15000);
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/github/') || path.includes('/agent-tasks')) return route.continue();
    if (path === '/v1/auth/get-session')
      return route.fulfill({ json: { ...shell.session, user: { ...shell.session.user, id: actor.userId } } });
    if (path === '/v1/workspaces') return route.fulfill({ json: [shell.workspace] });
    if (path === '/v1/workspaces/task-download') return route.fulfill({ json: shell.workspace });
    if (path.endsWith('/governance/me'))
      return route.fulfill({
        json: {
          membershipId: actor.membershipId,
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        },
      });
    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  });
  await page.goto(`${origin}/task-download/agent-tasks/${task.id}`);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download private archive', exact: true }).click();
  const downloaded = await downloadEvent;
  const bytes = await readFile(await downloaded.path());
  assert.deepEqual(bytes, archive);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'ff9fcdfa5cbd0e50f0fb0cd6ff0fa7d138bbfadc73a92fe7e68b6d949cc28e7c',
  );
  assert.equal(downloaded.suggestedFilename(), 'private.bin');
  await page.getByText('Download sent to your browser.').waitFor();
  f.state.content = Buffer.from('mutated!');
  await page.getByRole('button', { name: 'Download private archive', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Download unavailable' }).waitFor();
  f.state.content = archive;
  const retry = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download private archive', exact: true }).click();
  const retried = await retry;
  assert.deepEqual(await readFile(await retried.path()), archive);
  assert.equal(retried.suggestedFilename(), 'private.bin');
  assert.equal(
    f.state.requests.filter(req => req.path.startsWith('/object')).every(req => !req.authorization),
    true,
  );
  console.log(
    'PASS task executor, retained receipt, owner HTTP route, and cross-origin Chromium download of private.bin with exact bytes, denial, changed-byte rejection, and retry.',
  );
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
  }
  await app.close();
  await f.close();
}
