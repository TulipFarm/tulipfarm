import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '../../../packages/workspace-storage/src/runtime.ts';
import { createWorkflows } from '../../../packages/workflows/src/service.ts';
import { registerWorkflows } from '../../api/src/workflows.ts';
import { protectBusinessRequests } from '../../api/src/business.ts';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify'),
  cors = requireApi('@fastify/cors');
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);

test(
  'Chromium archives a workflow after confirmation, recovers from an unconfirmed attempt and keeps its history',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const origin = 'http://127.0.0.1:5396',
      apiOrigin = 'http://127.0.0.1:3396';
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
        revision = randomUUID(),
        keptId = randomUUID();
      const definition = {
        version: 1,
        name: 'Old intake',
        trigger: { kind: 'manual' },
        steps: [{ id: 'review', kind: 'human', prompt: 'Approve?', timeoutSeconds: 86400 }],
      };
      await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
      await service.activate(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: 1,
        revision,
        enabled: true,
      });
      const { runId } = await service.start(w.id, w.userId, id, { requestId: randomUUID(), input: null });
      await service.advance({ workspaceId: w.id, runId });
      await service.save(w.id, w.userId, keptId, {
        revision: randomUUID(),
        expectedRevision: null,
        definition: { ...definition, name: 'Current intake' },
      });
      const workspace = {
        id: w.id,
        name: 'Archive proof',
        slug: 'archive-proof',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'local-test-session', userId: w.userId },
        user: { id: w.userId, name: 'Archive tester', email: 'archive@example.com' },
      };
      let archiveRequests = 0,
        archivedReadsFail = true,
        release;
      const held = new Promise(resolve => {
        release = resolve;
      });
      app = Fastify();
      app.register(cors, { origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'OPTIONS'] });
      app.addHook('onRequest', async (request, reply) => {
        if (request.method === 'GET' && request.url.endsWith('/workflows?archived=true') && archivedReadsFail)
          return reply.code(503).send({ error: 'workflows-unavailable' });
        if (!request.url.endsWith('/archive') || request.method !== 'POST') return;
        archiveRequests++;
        if (archiveRequests === 1) {
          await held;
          return reply.code(503).send({ error: 'workflows-unavailable' });
        }
      });
      app.get('/v1/auth/get-session', async () => session);
      app.get('/v1/workspaces', async () => [workspace]);
      app.get('/v1/workspaces/archive-proof', async () => workspace);
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
      await app.listen({ host: '127.0.0.1', port: 3396 });
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5396', '--strictPort'],
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
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      await context.addCookies([{ name: 'workflow-test', value: '1', url: apiOrigin }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));

      await page.goto(`${origin}/archive-proof/workflows`);
      await page.getByRole('button', { name: 'Old intake', exact: true }).click();
      await page.getByRole('button', { name: 'Archive workflow' }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Archive Old intake?' });
      await dialog.getByText('Run history and the audit trail are kept.', { exact: false }).waitFor();
      await dialog.getByRole('button', { name: 'Keep workflow' }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(archiveRequests, 0);

      await page.getByRole('button', { name: 'Archive workflow' }).click();
      await dialog.getByRole('button', { name: 'Archive workflow' }).click();
      await page.getByRole('button', { name: 'Archiving workflow…' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Archiving workflow…' }).isDisabled(), true);
      release();
      await page
        .getByRole('alert')
        .filter({ hasText: 'The result is unconfirmed. Retry the exact request below' })
        .waitFor();
      await page.getByRole('button', { name: 'Retry exact request' }).click();
      await page.getByRole('status').filter({ hasText: 'Workflow archived.' }).waitFor();
      await page.getByRole('button', { name: 'Current intake', exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent === 'All workflows');
      assert.equal(await page.getByRole('button', { name: 'Old intake', exact: true }).count(), 0);
      assert.equal(archiveRequests, 2);

      await page.getByRole('button', { name: 'Archived workflows' }).click();
      assert.equal(await page.getByRole('button', { name: 'Archived workflows' }).getAttribute('aria-pressed'), 'true');
      await page.getByRole('heading', { name: 'Archived workflows could not load' }).waitFor();
      archivedReadsFail = false;
      await page.getByRole('button', { name: 'Retry loading archived workflows' }).click();
      await page.getByRole('button', { name: 'Old intake', exact: true }).waitFor();
      assert.equal(await page.getByText('No archived workflows', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Current intake', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Old intake', exact: true }).click();
      await page.getByRole('heading', { name: 'Run history' }).waitFor();
      await page.locator('article').getByText('Access denied', { exact: true }).waitFor();
      await page.getByRole('alert').filter({ hasText: 'workflow-archived' }).waitFor();
      await page.getByText('Its run history is read-only.', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Run workflow' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Definition and activation' }).count(), 0);

      await page.getByRole('button', { name: 'All workflows' }).click();
      await page.getByRole('button', { name: 'Current workflows' }).click();
      await page.getByRole('button', { name: 'Current intake', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Old intake', exact: true }).count(), 0);

      const table = name => qualified(w.names.schema, name);
      assert.deepEqual(
        (
          await db.platform.query(
            `SELECT enabled,archived_at IS NOT NULL AS archived FROM ${table('tf_workflows')} WHERE id=$1`,
            [id],
          )
        ).rows[0],
        { enabled: false, archived: true },
      );
      assert.deepEqual(
        (await service.history(w.id, w.userId, id).then(page => page.runs)).map(run => [run.id, run.status, run.error]),
        [[runId, 'blocked', 'workflow-archived']],
      );

      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      vite?.kill('SIGTERM');
      await app?.close();
      await runtime?.close();
      await db.close();
      if (priorOrigin === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = priorOrigin;
    }
  },
);
