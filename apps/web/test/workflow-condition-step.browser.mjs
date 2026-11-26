import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
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
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);

test(
  'Chromium describes a condition step in the workflow definition, and run history names the branch a run took and an incomparable condition',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const origin = 'http://127.0.0.1:5381',
      apiOrigin = 'http://127.0.0.1:3381';
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

      const service = createWorkflows(runtime);
      const workflowId = randomUUID(),
        workflowRevision = randomUUID();
      await service.save(w.id, w.userId, workflowId, {
        revision: workflowRevision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Big order check',
          triggers: [],
          steps: [
            {
              id: 'check',
              kind: 'condition',
              when: { left: { kind: 'input', path: ['total'] }, op: 'gt', right: { kind: 'literal', value: 100 } },
              ifMet: ['big_order'],
              otherwise: ['small_order'],
            },
            { id: 'big_order', kind: 'transform', fields: { note: { kind: 'literal', value: 'big' } } },
            { id: 'small_order', kind: 'transform', fields: { note: { kind: 'literal', value: 'small' } } },
            { id: 'record_total', kind: 'transform', fields: { total: { kind: 'input', path: ['total'] } } },
          ],
        },
      });
      const current = (await service.list(w.id, w.userId)).find(item => item.id === workflowId);
      await service.activate(w.id, w.userId, workflowId, {
        commandId: randomUUID(),
        expectedGeneration: current.generation,
        revision: workflowRevision,
        enabled: true,
      });

      const workspace = {
        id: w.id,
        name: 'Condition step proof',
        slug: 'condition-step-proof',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'local-test-session', userId: w.userId },
        user: { id: w.userId, name: 'Condition step tester', email: 'conditions@example.com' },
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
      app.get('/v1/workspaces/condition-step-proof', async () => workspace);
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
      await app.listen({ host: '127.0.0.1', port: 3381 });
      vite = spawn(process.execPath, ['test/serve-built-app.mjs', '--host', '127.0.0.1', '--port', '5381'], {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, VITE_API_URL: apiOrigin },
        stdio: 'ignore',
      });
      for (let attempt = 0; ; attempt++) {
        try {
          if ((await fetch(origin)).ok) break;
        } catch {
          if (attempt > 100) throw new Error('Vite did not start');
        }
        await setTimeout(100);
      }
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ locale: 'en-US' });
      await context.addCookies([{ name: 'workflow-test', value: '1', url: apiOrigin }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));

      await page.goto(`${origin}/condition-step-proof/workflows`);
      await page.getByRole('link', { name: 'Big order check', exact: true }).click();
      // Workflows are read-only on this page and change through chat, so the condition is described in the
      // definition's step details rather than in an editor.
      const definition = page.getByRole('region', { name: 'Workflow definition' });
      await definition.getByRole('button', { name: 'Steps', exact: true }).click();
      const steps = definition.getByRole('list', { name: 'Workflow steps' });
      // The trigger is listed first, then all four steps, including the one outside both branches.
      assert.equal(await steps.getByRole('listitem').count(), 5);
      await steps.getByRole('button', { name: /Check a condition/ }).click();
      const details = definition.getByRole('region', { name: 'Step details' });
      await details.getByRole('heading', { name: 'Check a condition' }).waitFor();
      await details.getByText('Only the selected steps continue', { exact: true }).waitFor();
      await details.getByText('Checks', { exact: true }).waitFor();
      const checks = await details
        .locator('dt', { hasText: 'Checks' })
        .locator('xpath=following-sibling::dd')
        .textContent();
      assert.match(checks, /total.* is greater than .*100/, checks);
      await definition.getByText('Yes / No branches', { exact: true }).waitFor();

      const advance = async runId => {
        for (let step = 0; step < 10 && (await service.advance({ workspaceId: w.id, runId })).kind !== 'done'; step++);
      };
      const met = await service.start(w.id, w.userId, workflowId, { requestId: randomUUID(), input: { total: 250 } });
      await advance(met.runId);
      const incomparable = await service.start(w.id, w.userId, workflowId, {
        requestId: randomUUID(),
        input: { total: 'lots' },
      });
      await advance(incomparable.runId);
      const runs = await service.history(w.id, w.userId, workflowId).then(page => page.runs);
      const run = runs.find(item => item.id === met.runId),
        failed = runs.find(item => item.id === incomparable.runId);
      assert.equal(run.status, 'completed');
      assert.deepEqual(
        run.steps.map(step => step.stepId),
        ['check', 'big_order', 'record_total'],
        'the skipped branch leaves no receipt and the unlisted step still runs',
      );
      assert.equal(failed.status, 'failed');
      assert.equal(
        failed.error,
        'condition-values-incomparable',
        'a number compared with text fails instead of choosing a branch',
      );

      await page.getByRole('tab', { name: 'Runs', exact: true }).click();
      await page.getByRole('button', { name: 'Check run history' }).click();
      const history = page.getByRole('region', { name: 'Run history' });
      await history.locator(`#workflow-run-${met.runId}`).getByText('3 workflow steps').click();
      await history.getByText('Condition met, so it ran big order and skipped small order.', { exact: true }).waitFor();
      await history
        .locator(`#workflow-run-${incomparable.runId}`)
        .getByText('condition-values-incomparable', { exact: true })
        .waitFor();
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
