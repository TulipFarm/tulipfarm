import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '../../../packages/workspace-storage/src/runtime.ts';
import { createWorkflows } from '../../../packages/workflows/src/service.ts';
import { registerWorkflows } from '../../api/src/workflows.ts';
import { protectBusinessRequests } from '../../api/src/business.ts';
import { savedTaskAgent } from '../../../packages/agents/test/task-fixture.mjs';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify'),
  cors = requireApi('@fastify/cors');
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const cdpPort = process.env.RUN_HISTORY_CDP_PORT;

async function choose(page, control, option) {
  await control.click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test(
  'Chromium loads older workflow runs on request, recovers a failed page, and filters runs by status',
  { timeout: 180000 },
  async () => {
    const db = await fixture();
    const origin = 'http://127.0.0.1:5645',
      apiOrigin = 'http://127.0.0.1:3645';
    let app, runtime, browser, vite;
    const priorOrigin = process.env.WEB_ORIGIN;
    try {
      process.env.WEB_ORIGIN = origin;
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime),
        id = randomUUID(),
        revision = randomUUID();
      await service.save(w.id, w.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Nightly copy',
          trigger: { kind: 'manual' },
          steps: [{ id: 'copy', kind: 'transform', fields: { n: { kind: 'input', path: ['n'] } } }],
        },
      });
      await service.activate(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: 1,
        revision,
        enabled: true,
      });
      const runIds = [];
      for (let n = 0; n < 53; n++) {
        const { runId } = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: { n } });
        if (n === 52) await service.cancel(w.id, w.userId, id, runId);
        else while ((await service.advance({ workspaceId: w.id, runId })).kind !== 'done');
        runIds.unshift(runId);
      }
      const completed = (await service.history(w.id, w.userId, id)).runs.find(run => run.id === runIds[1]);
      assert.ok(completed?.startedAt);
      assert.ok(completed?.finishedAt);
      assert.equal(completed?.scheduledFor, null);
      const workspace = {
        id: w.id,
        name: 'History proof',
        slug: 'history-proof',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'local-test-session', userId: w.userId },
        user: { id: w.userId, name: 'History tester', email: 'history@example.com' },
      };
      let olderFails = true,
        release;
      const runHistoryReads = [];
      const held = new Promise(resolve => {
        release = resolve;
      });
      app = Fastify();
      app.register(cors, { origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'OPTIONS'] });
      app.addHook('onRequest', async (request, reply) => {
        if (request.method !== 'GET' || !request.url.includes('/runs?before=')) return;
        runHistoryReads.push(request.url);
        if (olderFails) {
          await held;
          return reply.code(503).send({ error: 'workflows-unavailable' });
        }
      });
      app.get('/v1/auth/get-session', async () => session);
      app.get('/v1/workspaces', async () => [workspace]);
      app.get('/v1/workspaces/history-proof', async () => workspace);
      app.get(`/v1/workspaces/${w.id}/governance/me`, async () => ({
        membershipId: w.membershipId,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: true },
      }));
      app.register(
        async routes => {
          protectBusinessRequests(routes);
          registerWorkflows(routes, {
            service,
            auth: {
              api: {
                getSession: async ({ headers }) =>
                  headers.get('cookie')?.includes('workflow-test=1') ? session : null,
              },
            },
          });
        },
        { prefix: '/v1' },
      );
      await app.listen({ host: '127.0.0.1', port: 3645 });
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5645', '--strictPort'],
        { env: { ...process.env, VITE_API_URL: apiOrigin }, stdio: 'ignore' },
      );
      for (let attempt = 0; ; attempt++) {
        try {
          if ((await fetch(origin)).ok) break;
        } catch {
          if (attempt > 100) throw new Error('Vite did not start');
        }
        await setTimeout(100);
      }
      if (process.env.RUN_HISTORY_SCREENSHOTS) await mkdir(process.env.RUN_HISTORY_SCREENSHOTS, { recursive: true });
      browser = await chromium.launch({
        headless: true,
        ...(cdpPort ? { args: [`--remote-debugging-port=${cdpPort}`] } : {}),
      });
      const context = await browser.newContext();
      await context.addCookies([{ name: 'workflow-test', value: '1', url: apiOrigin }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const shown = () =>
        page
          .locator('article[id^="workflow-run-"]')
          .evaluateAll(articles => articles.map(article => article.id.slice('workflow-run-'.length)));

      await page.goto(`${origin}/history-proof/workflows`);
      await page.getByRole('link', { name: 'Nightly copy', exact: true }).click();
      await page.getByRole('tab', { name: 'Runs', exact: true }).click();
      await page.getByRole('heading', { name: 'Run history' }).waitFor();
      await page.locator(`#workflow-run-${runIds[49]}`).waitFor();
      assert.deepEqual(await shown(), runIds.slice(0, 50), 'the first page shows the 50 newest runs');
      const completedArticle = page.locator(`#workflow-run-${runIds[1]}`);
      const runTimes = await completedArticle.locator('p').first().textContent();
      const dateTimes = await completedArticle.locator('time').evaluateAll(times => times.map(time => time.dateTime));
      assert.ok(dateTimes.includes(completed.startedAt));
      assert.ok(dateTimes.includes(completed.finishedAt));
      assert.match(runTimes, /Started .* Finished .* Duration \d+ (?:sec|min|hr)/);

      const readsBeforeLoadMore = runHistoryReads.length;
      await page.getByRole('button', { name: 'Load older runs' }).click();
      const loading = page.getByRole('button', { name: 'Loading older runs...' });
      await loading.waitFor();
      assert.equal(runHistoryReads.length - readsBeforeLoadMore, 1, 'loading more requests only the next cursor page');
      assert.equal(await loading.isDisabled(), true);
      assert.deepEqual(await shown(), runIds.slice(0, 50), 'loaded runs stay visible while the older page loads');
      release();
      await page.getByRole('alert').filter({ hasText: 'Run history could not refresh.' }).waitFor();
      assert.deepEqual(await shown(), runIds.slice(0, 50), 'a failed older page keeps the loaded runs');
      olderFails = false;
      await page.getByRole('button', { name: 'Retry loading older runs' }).click();
      await page.locator(`#workflow-run-${runIds[52]}`).waitFor();
      assert.deepEqual(await shown(), runIds, 'the older page appends the remaining runs in order');
      assert.equal(
        await page.getByRole('button', { name: /older runs/ }).count(),
        0,
        'no load action remains at the end of history',
      );
      await page.getByText('You have reached the end of run history.', { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.activeElement?.id),
        `workflow-run-${runIds[50]}`,
        'the first newly loaded run receives focus when history ends',
      );

      await choose(page, page.getByLabel('Show', { exact: true }), 'Cancelled');
      await page.waitForFunction(() => document.querySelectorAll('article[id^="workflow-run-"]').length === 1);
      assert.deepEqual(await shown(), [runIds[0]]);
      await choose(page, page.getByLabel('Show', { exact: true }), 'Failed');
      await page.getByText('No runs in your history for this workflow match Failed.', { exact: true }).waitFor();
      if (process.env.RUN_HISTORY_SCREENSHOTS)
        await page.screenshot({ path: `${process.env.RUN_HISTORY_SCREENSHOTS}/run-history-no-match.png` });
      await page.getByRole('button', { name: 'Clear filter' }).click();
      await page.locator(`#workflow-run-${runIds[49]}`).waitFor();
      assert.deepEqual(await shown(), runIds.slice(0, 50), 'clearing the filter returns to the first page of all runs');
      assert.equal(await page.getByLabel('Show', { exact: true }).getByText('All runs', { exact: true }).count(), 1);
      await page.getByRole('button', { name: 'Load older runs' }).waitFor();
      const screenshots = process.env.RUN_HISTORY_SCREENSHOTS;
      await service.save(w.id, w.userId, id, {
        revision: randomUUID(),
        expectedRevision: revision,
        definition: {
          version: 1,
          name: 'Changed saved copy',
          trigger: { kind: 'manual' },
          steps: [{ id: 'copy', kind: 'transform', fields: { n: { kind: 'literal', value: 99 } } }],
        },
      });
      await completedArticle.getByRole('button', { name: 'View run diagram', exact: true }).click();
      const diagram = page.getByRole('region', { name: 'Nightly copy workflow', exact: true });
      await diagram.waitFor();
      await diagram.getByText('Definition used by this run', { exact: true }).waitFor();
      assert.equal(await diagram.getByRole('textbox').count(), 0);
      assert.equal(
        await page.getByRole('heading', { name: 'Changed saved copy', exact: true }).count(),
        0,
        'a run never displays the newer saved definition',
      );
      for (const width of [1440, 768, 414, 375, 320]) {
        await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
        await page.emulateMedia({ colorScheme: width === 375 ? 'dark' : 'light', reducedMotion: 'reduce' });
        await diagram.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const graphBounds = await diagram.getByRole('figure').boundingBox();
        const triggerBounds = await diagram.locator('.workflow-node').first().boundingBox();
        assert.ok(
          triggerBounds.x >= graphBounds.x &&
            triggerBounds.x + triggerBounds.width <= graphBounds.x + graphBounds.width,
          `the short workflow stays readable when resized to ${width}px`,
        );
        if (screenshots) {
          const path = `${screenshots}/workflow-pinned-run-${width}.png`;
          if (cdpPort)
            execFileSync('agent-browser', ['--session', 'workflow-history', '--cdp', cdpPort, 'screenshot', path], {
              stdio: 'inherit',
            });
          else await page.screenshot({ path });
        }
      }
      await page.getByRole('button', { name: 'Close run diagram', exact: true }).click();
      await page.emulateMedia({ colorScheme: 'light' });

      const { agentId } = await savedTaskAgent(db, w, runtime, w.userId, w.membershipId);
      const taskId = randomUUID(),
        agentWorkflowId = randomUUID(),
        agentRevision = randomUUID();
      let taskStatus = 'paused',
        pauseReason = 'limit.credits';
      const agentWorkflows = createWorkflows(runtime, {
        agentTasks: {
          start: async () => ({ id: taskId }),
          result: async () => ({ status: taskStatus, pauseReason, text: 'Reviewed the ticket.' }),
        },
      });
      await agentWorkflows.save(w.id, w.userId, agentWorkflowId, {
        revision: agentRevision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Review ticket',
          trigger: { kind: 'manual' },
          steps: [{ id: 'review', kind: 'agent', agentId, prompt: { kind: 'literal', value: 'Review this ticket.' } }],
        },
      });
      await agentWorkflows.activate(w.id, w.userId, agentWorkflowId, {
        commandId: randomUUID(),
        expectedGeneration: 1,
        revision: agentRevision,
        enabled: true,
      });
      const agentRun = await agentWorkflows.start(w.id, w.userId, agentWorkflowId, {
        requestId: randomUUID(),
        input: {},
      });
      const work = { workspaceId: w.id, runId: agentRun.runId };
      await agentWorkflows.advance(work);
      await agentWorkflows.advance(work);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${origin}/history-proof/workflows?workflow=${agentWorkflowId}&view=runs`);
      const agentArticle = page.locator(`#workflow-run-${agentRun.runId}`);
      await agentArticle.getByText('Paused at the task credit limit', { exact: true }).waitFor();
      assert.equal(
        await agentArticle
          .getByRole('status')
          .filter({ hasText: /^Waiting to continue$/ })
          .count(),
        1,
      );
      assert.equal(
        await agentArticle.getByRole('link', { name: 'Open agent task', exact: true }).getAttribute('href'),
        `/history-proof/agent-tasks/${taskId}`,
      );
      if (screenshots) {
        await page.screenshot({ path: `${screenshots}/workflow-agent-paused.png` });
        if (cdpPort)
          execFileSync(
            'agent-browser',
            [
              '--session',
              'workflow-history',
              '--cdp',
              cdpPort,
              'screenshot',
              `${screenshots}/workflow-agent-paused-agent-browser.png`,
            ],
            { stdio: 'inherit' },
          );
      }
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (screenshots) await page.screenshot({ path: `${screenshots}/workflow-agent-paused-mobile.png` });

      taskStatus = 'waiting-approval';
      pauseReason = null;
      await agentWorkflows.advance(work);
      await page.reload();
      await agentArticle.getByText('Needs your review', { exact: true }).waitFor();
      assert.equal(await agentArticle.getByText('Paused at the task credit limit', { exact: true }).count(), 0);
      taskStatus = 'completed';
      await agentWorkflows.advance(work);
      await agentWorkflows.advance(work);
      await page.reload();
      await agentArticle
        .getByRole('status')
        .filter({ hasText: /^Completed$/ })
        .waitFor();
      assert.equal(await agentArticle.getByRole('link', { name: 'Open agent task', exact: true }).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      try {
        if (cdpPort && browser)
          execFileSync('agent-browser', ['--session', 'workflow-history', 'close'], { stdio: 'inherit' });
      } finally {
        await browser?.close();
        vite?.kill('SIGTERM');
        await app?.close();
        await runtime?.close();
        await db.close();
        if (priorOrigin === undefined) delete process.env.WEB_ORIGIN;
        else process.env.WEB_ORIGIN = priorOrigin;
      }
    }
  },
);
