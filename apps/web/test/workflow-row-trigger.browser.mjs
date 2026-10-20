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
import { saveWorkflow, openWorkflow, assertConfiguration } from './workflow-definition.fixture.mjs';

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
  'Chromium inspects exact row triggers and numeric, empty and date record filters',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const origin = 'http://127.0.0.1:5381',
      apiOrigin = 'http://127.0.0.1:3381';
    let app, runtime, migration, browser, vite;
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
      migration = await connect(db.login(w, 'migration'));

      const team = randomUUID();
      await db.platform.query(`INSERT INTO "${w.names.schema}".tf_teams(id,name) VALUES($1,'Sales')`, [team]);
      const status = { id: randomUUID(), label: 'Status', required: false, kind: 'text', maxLength: 200 };
      const amount = { id: randomUUID(), label: 'Amount', required: false, kind: 'numeric', precision: 12, scale: 2 };
      const shipped = { id: randomUUID(), label: 'Shipped on', required: false, kind: 'date' };
      const orders = {
        formatVersion: 2,
        id: randomUUID(),
        owningTeamId: team,
        label: 'Orders',
        fields: [status, amount, shipped],
        uniqueKeys: [],
      };
      await inTransaction(migration, async client => {
        await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
        const tx = { client, schema: w.names.schema };
        const generation = await createGeneration(tx, { definition: orders, revision: '1'.repeat(40) });
        await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
      });

      const service = createWorkflows(runtime);
      const steps = [{ id: 'note', kind: 'human', prompt: 'Check the order.', timeoutSeconds: 3600 }];
      const rowTrigger = {
        kind: 'row',
        tableId: orders.id,
        event: 'updated',
        fieldIds: [status.id],
        filter: { fieldId: amount.id, match: 'gte', value: { kind: 'numeric', value: '1000' } },
      };
      const recordTrigger = {
        kind: 'record',
        tableId: orders.id,
        field: {
          kind: 'date',
          fieldId: shipped.id,
          offset: { direction: 'after', amount: 1, unit: 'days' },
          time: '09:00',
          timezone: 'UTC',
        },
        filter: { fieldId: status.id, match: 'is-empty' },
      };
      await service.save(w.id, w.userId, randomUUID(), {
        revision: randomUUID(),
        expectedRevision: null,
        definition: { version: 1, name: 'Large order check', trigger: rowTrigger, steps },
      });
      await service.save(w.id, w.userId, randomUUID(), {
        revision: randomUUID(),
        expectedRevision: null,
        definition: { version: 1, name: 'Shipped follow-up', trigger: recordTrigger, steps },
      });

      const workspace = {
        id: w.id,
        name: 'Row proof',
        slug: 'row-proof',
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
      app.get('/v1/workspaces/row-proof', async () => workspace);
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
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5381', '--strictPort'],
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
      const context = await browser.newContext({ timezoneId: 'America/New_York', locale: 'en-US' });
      await context.addCookies([{ name: 'workflow-test', value: '1', url: apiOrigin }]);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const saved = async name => (await service.list(w.id, w.userId)).find(item => item.definition.name === name);
      await page.goto(`${origin}/row-proof/workflows`);
      const originalRow = await saved('Large order check');
      let viewer = await openWorkflow(page, originalRow);
      let inspector = await assertConfiguration(viewer, 0, rowTrigger);
      await inspector.getByText('Orders / updated', { exact: true }).first().waitFor();
      const editedRow = await saveWorkflow(
        service,
        w,
        {
          ...originalRow.definition,
          trigger: {
            ...rowTrigger,
            fieldIds: [status.id, shipped.id],
            filter: { fieldId: amount.id, match: 'gte', value: { kind: 'numeric', value: '2000' } },
          },
          steps: [{ ...steps[0], prompt: 'Call the customer.' }],
        },
        originalRow,
      );
      viewer = await openWorkflow(page, editedRow);
      await assertConfiguration(viewer, 0, editedRow.definition.trigger);
      await assertConfiguration(viewer, 1, editedRow.definition.steps[0]);
      assert.deepEqual(editedRow.definition.trigger, {
        ...rowTrigger,
        fieldIds: [status.id, shipped.id],
        filter: { fieldId: amount.id, match: 'gte', value: { kind: 'numeric', value: '2000' } },
      });
      assert.equal(editedRow.definition.steps[0].prompt, 'Call the customer.');

      const originalRecord = await saved('Shipped follow-up');
      viewer = await openWorkflow(page, originalRecord);
      inspector = await assertConfiguration(viewer, 0, recordTrigger);
      await inspector.getByText('Orders', { exact: true }).first().waitFor();
      const nonempty = await saveWorkflow(
        service,
        w,
        {
          ...originalRecord.definition,
          trigger: { ...recordTrigger, filter: { fieldId: shipped.id, match: 'is-not-empty' } },
        },
        originalRecord,
      );
      viewer = await openWorkflow(page, nonempty);
      await assertConfiguration(viewer, 0, nonempty.definition.trigger);
      const editedRecord = await saveWorkflow(
        service,
        w,
        {
          ...nonempty.definition,
          trigger: {
            ...recordTrigger,
            filter: { fieldId: shipped.id, match: 'lte', value: { kind: 'date', value: '2027-01-31' } },
          },
          steps: [{ ...steps[0], prompt: 'Ask for a review.' }],
        },
        nonempty,
      );
      viewer = await openWorkflow(page, editedRecord);
      await assertConfiguration(viewer, 0, editedRecord.definition.trigger);
      await assertConfiguration(viewer, 1, editedRecord.definition.steps[0]);
      assert.deepEqual(editedRecord.definition.trigger, {
        ...recordTrigger,
        filter: { fieldId: shipped.id, match: 'lte', value: { kind: 'date', value: '2027-01-31' } },
      });
      assert.equal(editedRecord.definition.steps[0].prompt, 'Ask for a review.');
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
