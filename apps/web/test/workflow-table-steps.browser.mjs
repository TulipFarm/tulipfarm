import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
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
const { createGeneration, activateGeneration } = await load('@tulipfarm/tables/store');
const { inTransaction } = await load('@tulipfarm/workspace-storage/provisioning');
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);

test(
  'Chromium shows table row steps with table and field names, and run history names the rows a run created and updated',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const origin = 'http://127.0.0.1:5380',
      apiOrigin = 'http://127.0.0.1:3380';
    let app, runtime, migration, browser, vite;
    const priorOrigin = process.env.WEB_ORIGIN;
    try {
      process.env.WEB_ORIGIN = origin;
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const migrations = await workspaceTableMigrations();
      const w = await db.create(migrations);
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      migration = await connect(db.login(w, 'migration'));

      const team = randomUUID(),
        revision = '1'.repeat(40);
      await db.platform.query(`INSERT INTO "${w.names.schema}".tf_teams(id,name) VALUES($1,'Sales')`, [team]);
      const name = { id: randomUUID(), label: 'Company', required: false, kind: 'text', maxLength: 200 };
      const open = { id: randomUUID(), label: 'Open', retired: false },
        won = { id: randomUUID(), label: 'Won', retired: false };
      const stage = { id: randomUUID(), label: 'Stage', required: false, kind: 'single-select', options: [open, won] };
      const leads = {
        formatVersion: 2,
        id: randomUUID(),
        owningTeamId: team,
        label: 'Leads',
        fields: [name, stage],
        uniqueKeys: [],
      };
      await inTransaction(migration, async client => {
        await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
        const tx = { client, schema: w.names.schema };
        const generation = await createGeneration(tx, { definition: leads, revision });
        await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
      });

      const service = createWorkflows(runtime);
      const workflowId = randomUUID(),
        workflowRevision = randomUUID();
      await service.save(w.id, w.userId, workflowId, {
        revision: workflowRevision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Add lead',
          trigger: { kind: 'manual' },
          steps: [
            {
              id: 'add',
              kind: 'create-row',
              tableId: leads.id,
              fields: {
                [name.id]: { kind: 'input', path: ['company'] },
                [stage.id]: { kind: 'literal', value: 'Open' },
              },
            },
            {
              id: 'find',
              kind: 'find-rows',
              tableId: leads.id,
              filters: [{ fieldId: name.id, op: 'eq', value: { kind: 'input', path: ['company'] } }],
              limit: 5,
            },
            {
              id: 'win',
              kind: 'update-row',
              tableId: leads.id,
              row: { kind: 'step', step: 'add', path: [] },
              fields: { [stage.id]: { kind: 'literal', value: 'Won' } },
            },
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
        name: 'Table steps proof',
        slug: 'table-steps-proof',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'local-test-session', userId: w.userId },
        user: { id: w.userId, name: 'Table step tester', email: 'steps@example.com' },
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
      app.get('/v1/workspaces/table-steps-proof', async () => workspace);
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
      await app.listen({ host: '127.0.0.1', port: 3380 });
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5380', '--strictPort'],
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
      const context = await browser.newContext({ locale: 'en-US' });
      await context.addCookies([{ name: 'workflow-test', value: '1', url: apiOrigin }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));

      await page.goto(`${origin}/table-steps-proof/workflows`);
      await page.getByRole('link', { name: 'Add lead', exact: true }).click();
      const editor = page.getByRole('region', { name: 'Workflow editor' });
      await editor.getByRole('heading', { name: '1. Add a table row' }).waitFor();
      await editor.getByText('Add mapped field', { exact: true }).first().waitFor();
      await editor.getByText('Company', { exact: true }).first().waitFor();
      await editor.getByText('Stage', { exact: true }).first().waitFor();
      await editor.getByRole('heading', { name: '2. Find table rows' }).waitFor();
      await editor.getByText('Add filter field', { exact: true }).waitFor();
      await editor.getByText('Row to update', { exact: true }).waitFor();
      await editor.getByRole('button', { name: 'Add find rows' }).click();
      await editor.getByRole('heading', { name: '4. Find table rows' }).waitFor();
      const addedFind = editor
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: '4. Find table rows' }) });
      await addedFind.getByLabel('Table', { exact: true }).click();
      await page.getByRole('option', { name: 'Leads', exact: true }).click();
      await addedFind.getByText('Add filter field', { exact: true }).waitFor();

      const { runId } = await service.start(w.id, w.userId, workflowId, {
        requestId: randomUUID(),
        input: { company: 'Acme' },
      });
      for (let step = 0; step < 10 && (await service.advance({ workspaceId: w.id, runId })).kind !== 'done'; step++);
      const [run] = await service.history(w.id, w.userId, workflowId).then(page => page.runs);
      assert.equal(run.status, 'completed');
      const recordId = run.steps[0].output.recordId.slice(0, 8);
      await page.getByRole('tab', { name: 'Runs', exact: true }).click();
      await page.getByRole('button', { name: 'Check run history' }).click();
      const history = page.getByRole('region', { name: 'Run history' });
      await history.getByText('3 workflow steps').click();
      await history.getByText(`Created row ${recordId}, writing 2 fields.`, { exact: true }).waitFor();
      await history.getByText(`Found 1 row: ${recordId}.`, { exact: true }).waitFor();
      await history.getByText(`Updated row ${recordId}, writing 1 field.`, { exact: true }).waitFor();
      assert.deepEqual(errors, []);
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
  },
);
