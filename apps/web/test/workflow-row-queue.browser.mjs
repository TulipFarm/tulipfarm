import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture, connect } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '../../../packages/workspace-storage/src/runtime.ts';
import { registerWorkflows } from '../../api/src/workflows.ts';
import { registerTableChanges } from '../../api/src/table-changes.ts';
import { protectBusinessRequests } from '../../api/src/business.ts';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify'),
  cors = requireApi('@fastify/cors');
const load = name => import(pathToFileURL(requireApi.resolve(name)).href);
const { createWorkflows } = await load('@tulipfarm/workflows');
const { tableProposalOptions } = await load('@tulipfarm/agents/table-proposals');
const { createGeneration, activateGeneration, activeGeneration, persistMutation } =
  await load('@tulipfarm/tables/store');
const { inTransaction } = await load('@tulipfarm/workspace-storage/provisioning');
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const cdpPort = process.env.ROW_QUEUE_CDP_PORT;

test(
  'Chromium shows retained row queue capacity, refresh recovery, explicit cancellation and hidden source metadata',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const origin = 'http://127.0.0.1:5383',
      apiOrigin = 'http://127.0.0.1:3383';
    let app, runtime, migration, browser, vite, page;
    let agentBrowserAttached = false;
    const priorOrigin = process.env.WEB_ORIGIN;
    try {
      process.env.WEB_ORIGIN = origin;
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const migrations = await workspaceTableMigrations(),
        w = await db.create(migrations);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      migration = await connect(db.login(w, 'migration'));
      const team = randomUUID(),
        field = randomUUID(),
        tableId = randomUUID();
      await db.platform.query(`INSERT INTO "${w.names.schema}".tf_teams(id,name) VALUES($1,'Sales')`, [team]);
      await inTransaction(migration, async client => {
        await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
        const tx = { client, schema: w.names.schema };
        const generation = await createGeneration(tx, {
          revision: '1'.repeat(40),
          definition: {
            formatVersion: 2,
            id: tableId,
            owningTeamId: team,
            label: 'Orders',
            fields: [{ id: field, label: 'Name', required: false, kind: 'text', maxLength: 200 }],
            uniqueKeys: [],
          },
        });
        await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
      });
      const service = createWorkflows(runtime),
        id = randomUUID(),
        revision = randomUUID();
      await service.save(w.id, w.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Every new order',
          trigger: { kind: 'row', tableId, event: 'created' },
          steps: [{ id: 'review', kind: 'human', prompt: 'Check the order.', timeoutSeconds: 3600 }],
        },
      });
      await service.sponsorship(w.id, w.userId, id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      const saved = async () => (await service.list(w.id, w.userId)).find(item => item.id === id);
      await service.activate(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: (await saved()).generation,
        revision,
        enabled: true,
      });
      const workspace = {
        id: w.id,
        name: 'Row queue proof',
        slug: 'row-queue-proof',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'local-test-session', userId: w.userId },
        user: { id: w.userId, name: 'Row tester', email: 'row@example.com' },
      };
      const auth = {
        api: {
          getSession: async ({ headers }) => (headers.get('cookie')?.includes('workflow-test=1') ? session : null),
        },
      };
      app = Fastify();
      app.register(cors, { origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'OPTIONS'] });
      app.get('/v1/auth/get-session', async () => session);
      app.get('/v1/workspaces', async () => [workspace]);
      app.get('/v1/workspaces/row-queue-proof', async () => workspace);
      app.get(`/v1/workspaces/${w.id}/governance/me`, async () => ({
        membershipId: w.membershipId,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: true },
      }));
      app.register(
        async routes => {
          protectBusinessRequests(routes);
          registerWorkflows(routes, { service, auth });
          registerTableChanges(routes, {
            ...tableProposalOptions(runtime),
            auth,
            resolveConfirmationCredential: async () => db.login(w, 'confirmation'),
          });
        },
        { prefix: '/v1' },
      );
      await app.listen({ host: '127.0.0.1', port: 3383 });
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5383', '--strictPort'],
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
      browser = await chromium.launch({
        headless: true,
        ...(cdpPort ? { args: [`--remote-debugging-port=${cdpPort}`] } : {}),
      });
      const context = await browser.newContext({ timezoneId: 'America/New_York', locale: 'en-US' });
      await context.addCookies([{ name: 'workflow-test', value: '1', url: apiOrigin }]);
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const historyResponses = [];
      page.on('response', response => {
        if (new URL(response.url()).pathname.endsWith(`/workflows/${id}/runs`))
          historyResponses.push(response.status());
      });
      await page.goto(`${origin}/row-queue-proof/workflows`);
      await page.getByRole('link', { name: 'Every new order', exact: true }).click();
      await page.getByRole('tab', { name: 'Runs', exact: true }).click();
      const queue = page.getByRole('region', { name: 'Row event queue' });
      await queue.getByText('No waiting row events', { exact: true }).waitFor();
      await runtime.transaction(w.id, { minimum: migrations.length, maximum: migrations.length }, async tx => {
        const generation = await activeGeneration(tx, tableId);
        for (let index = 0; index < 130; index++)
          await persistMutation(tx, {
            generation,
            recordId: randomUUID(),
            before: null,
            values: { [field]: { kind: 'text', value: `Order ${index}` } },
            actor: { kind: 'human', userId: w.userId, membershipId: w.membershipId },
            operation: 'create',
          });
      });
      await service.due(w.id);
      await queue.getByRole('button', { name: 'Check queue status' }).click();
      await queue.getByText(/119 pending · 1 blocked/).waitFor();
      await queue.getByText(/Waiting for run capacity/).waitFor();
      await mkdir('reports/check', { recursive: true });
      await queue.screenshot({ path: 'reports/check/workflow-row-queue-capacity.png' });
      if (cdpPort) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await queue.scrollIntoViewIfNeeded();
        agentBrowserAttached = true;
        execFileSync(
          'agent-browser',
          [
            '--session',
            'workflow-row-queue',
            '--cdp',
            cdpPort,
            'screenshot',
            'reports/check/workflow-row-queue-capacity-agent-browser.png',
          ],
          { stdio: 'inherit' },
        );
      }
      const listUrl = `${apiOrigin}/v1/workspaces/${w.id}/workflows`;
      await page.route(listUrl, route =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'workflows-unavailable' }),
        }),
      );
      await queue.getByRole('button', { name: 'Check queue status' }).click();
      // Copy from cloud 4a3eb8e3 (#1021), src/pages/workflows.tsx:143.
      await page.getByText('Refresh failed. These are your last checked workflows.').waitFor();
      assert.equal(await queue.getByText(/119 pending · 1 blocked/).count(), 1);
      await page.unroute(listUrl);
      await queue.getByRole('button', { name: 'Check queue status' }).click();
      await queue.getByRole('button', { name: 'Cancel waiting events' }).click();
      const dialog = page.getByRole('alertdialog');
      await dialog.getByRole('button', { name: 'Keep events' }).click();
      assert.equal((await saved()).rowQueue.cancelled, 0);
      await queue.getByRole('button', { name: 'Cancel waiting events' }).click();
      const [cancelled] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/row-events/cancel')),
        dialog.getByRole('button', { name: 'Cancel waiting events' }).click(),
      ]);
      assert.equal(cancelled.status(), 200);
      await dialog.waitFor({ state: 'hidden' });
      await queue.getByText('120 events explicitly cancelled.').waitFor();
      await queue.getByText('No waiting row events', { exact: true }).waitFor();
      await page.locator('article[id^="workflow-run-"]').first().waitFor();
      assert.equal(
        await page.locator('article[id^="workflow-run-"]').count(),
        10,
        'cancellation automatically refreshes admitted history without a manual retry',
      );
      assert.equal(
        await page
          .getByText('Run history could not refresh. Your previous history and input remain available.')
          .count(),
        0,
      );
      const [historyResponse] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/workflows/${id}/runs`)),
        page.getByRole('button', { name: 'Check run history', exact: true }).click(),
      ]);
      assert.equal(historyResponse.status(), 200, await historyResponse.text());
      await page
        .getByText('Run history could not refresh. Your previous history and input remain available.')
        .waitFor({ state: 'hidden' });
      assert.equal(
        (await historyResponse.json()).runs.length,
        10,
        'cancelling waiting events retains readable admitted runs',
      );
      assert.ok(
        historyResponses.every(status => status === 200),
        `Unexpected history responses: ${historyResponses.join(', ')}`,
      );
      await queue.screenshot({ path: 'reports/check/workflow-row-queue-cancelled.png' });
      if (cdpPort) {
        await queue.scrollIntoViewIfNeeded();
        execFileSync(
          'agent-browser',
          [
            '--session',
            'workflow-row-queue',
            '--cdp',
            cdpPort,
            'screenshot',
            'reports/check/workflow-row-queue-cancelled-agent-browser.png',
          ],
          { stdio: 'inherit' },
        );
      }
      assert.equal((await saved()).rowQueue.pending + (await saved()).rowQueue.blocked, 0);
      await page.route(listUrl, async route => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: (await response.json()).map(workflow =>
            workflow.id === id ? { ...workflow, rowQueue: null } : workflow,
          ),
        });
      });
      await queue.getByRole('button', { name: 'Check queue status' }).click();
      await queue.getByText(/Queue details are hidden/).waitFor();
      assert.equal(await queue.getByText('120 events explicitly cancelled.').count(), 0);
      await page.unroute(listUrl);
      assert.deepEqual(errors, []);
    } catch (error) {
      if (page) {
        await mkdir('reports/check', { recursive: true });
        await page.screenshot({ path: 'reports/check/workflow-row-queue-failure.png', fullPage: true });
      }
      throw error;
    } finally {
      try {
        if (agentBrowserAttached)
          execFileSync('agent-browser', ['--session', 'workflow-row-queue', 'close'], { stdio: 'inherit' });
      } finally {
        await browser?.close();
        vite?.kill('SIGTERM');
        await app?.close();
        await migration?.end();
        await runtime?.close();
        await db.close();
        if (priorOrigin === undefined) delete process.env.WEB_ORIGIN;
        else process.env.WEB_ORIGIN = priorOrigin;
      }
    }
  },
);
