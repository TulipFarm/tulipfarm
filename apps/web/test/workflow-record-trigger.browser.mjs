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
import { reviewDefinition, saveWorkflow, openWorkflow, assertConfiguration } from './workflow-definition.fixture.mjs';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify'),
  cors = requireApi('@fastify/cors');
const load = name => import(pathToFileURL(requireApi.resolve(name)).href);
const { createWorkflows } = await load('@tulipfarm/workflows');
const { tableProposalOptions } = await load('@tulipfarm/agents/table-proposals');
const { createTableService } = await load('@tulipfarm/tables/service');
const { createGeneration, activateGeneration, activeGeneration, identity, readRecords, writeGenerationRecord } =
  await load('@tulipfarm/tables/store');
const { inTransaction } = await load('@tulipfarm/workspace-storage/provisioning');
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);

test(
  'Chromium reads a Record date trigger and lists the upcoming occurrence after the sweep, then explains why removing its filter field disabled it',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const origin = 'http://127.0.0.1:5379',
      apiOrigin = 'http://127.0.0.1:3379';
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
      await db.platform.query(`INSERT INTO "${w.names.schema}".tf_teams(id,name) VALUES($1,'Renewals')`, [team]);
      const title = { id: randomUUID(), label: 'Customer', required: false, kind: 'text', maxLength: 200 };
      const renewal = { id: randomUUID(), label: 'Renewal date', required: false, kind: 'date' };
      const active = { id: randomUUID(), label: 'Active', retired: false },
        cancelled = { id: randomUUID(), label: 'Cancelled', retired: false };
      const stage = {
        id: randomUUID(),
        label: 'Stage',
        required: false,
        kind: 'single-select',
        options: [active, cancelled],
      };
      const contracts = {
        formatVersion: 2,
        id: randomUUID(),
        owningTeamId: team,
        label: 'Contracts',
        fields: [title, renewal, stage],
        uniqueKeys: [],
      };
      await inTransaction(migration, async client => {
        await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
        const tx = { client, schema: w.names.schema };
        const generation = await createGeneration(tx, { definition: contracts, revision });
        await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
      });
      const year = new Date().getUTCFullYear() + 1;
      const records = createTableService(
        runtime,
        { readableFiles: async (_tx, _actor, ids) => new Set(ids) },
        { minimum: migrations.length, maximum: migrations.length },
      );
      const contract = await records.mutate(w.id, w.userId, {
        kind: 'create',
        tableId: contracts.id,
        revision,
        recordId: randomUUID(),
        values: {
          [title.id]: { kind: 'text', value: 'Acme' },
          [renewal.id]: { kind: 'date', value: `${year}-07-20` },
          [stage.id]: { kind: 'single-select', optionId: active.id },
        },
      });
      await records.mutate(w.id, w.userId, {
        kind: 'create',
        tableId: contracts.id,
        revision,
        recordId: randomUUID(),
        values: {
          [title.id]: { kind: 'text', value: 'Globex' },
          [renewal.id]: { kind: 'date', value: `${year}-07-20` },
          [stage.id]: { kind: 'single-select', optionId: cancelled.id },
        },
      });

      const service = createWorkflows(runtime);
      const workspace = {
        id: w.id,
        name: 'Record proof',
        slug: 'record-proof',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'local-test-session', userId: w.userId },
        user: { id: w.userId, name: 'Record tester', email: 'record@example.com' },
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
      app.get('/v1/workspaces/record-proof', async () => workspace);
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
      await app.listen({ host: '127.0.0.1', port: 3379 });
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5379', '--strictPort'],
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
      const saved = async () =>
        (await service.list(w.id, w.userId)).find(item => item.definition.name === 'Renewal reminder');
      const formatted = iso =>
        new Date(iso).toLocaleString('en-US', {
          timeZone: 'America/New_York',
          dateStyle: 'medium',
          timeStyle: 'short',
        });

      await page.goto(`${origin}/record-proof/workflows`);
      await page.getByRole('heading', { name: 'No workflows yet' }).waitFor();
      const trigger = {
        kind: 'record',
        tableId: contracts.id,
        field: {
          kind: 'date',
          fieldId: renewal.id,
          offset: { direction: 'before', amount: 3, unit: 'days' },
          time: '09:00',
          timezone: 'Europe/Berlin',
        },
        filter: { fieldId: stage.id, match: 'is', value: { kind: 'single-select', optionId: active.id } },
      };
      const workflow = await saveWorkflow(service, w, reviewDefinition('Renewal reminder', trigger));
      const viewer = await openWorkflow(page, workflow);
      const inspector = await assertConfiguration(viewer, 0, trigger);
      await inspector.getByText('Contracts', { exact: true }).first().waitFor();

      await service.sponsorship(w.id, w.userId, workflow.id, {
        sponsorMembershipId: w.membershipId,
        historyAudience: [w.membershipId],
      });
      await Promise.all([
        page.waitForResponse(
          response =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname === `/v1/workspaces/${w.id}/workflows` &&
            response.ok(),
        ),
        page.getByRole('button', { name: 'Refresh workflows', exact: true }).click(),
      ]);
      await page.getByRole('button', { name: 'Activate saved revision' }).click();
      await page.getByRole('button', { name: 'Disable workflow' }).waitFor();
      await page.getByRole('tab', { name: 'Runs', exact: true }).click();
      const upcoming = page.getByRole('region', { name: 'Upcoming record dates' });
      await upcoming
        .getByText('No upcoming record dates. Future dates appear after the next sweep.', { exact: true })
        .waitFor();

      await service.due(w.id);
      const dueAt = `${year}-07-17T07:00:00.000Z`;
      assert.deepEqual(
        (await saved()).upcomingRecords,
        [{ recordId: contract.id, dueAt }],
        '09:00 in Berlin summer time three days before July 20, for the Active contract only',
      );
      await openWorkflow(page, await saved());
      await page.getByRole('tab', { name: 'Runs', exact: true }).click();
      await upcoming.getByText(`Record ${contract.id.slice(0, 8)} / ${formatted(dueAt)}`, { exact: true }).waitFor();
      await page
        .getByRole('region', { name: 'Workflow summary', exact: true })
        .getByText(`Next run ${formatted(dueAt)}`, { exact: false })
        .waitFor();

      await inTransaction(migration, async client => {
        await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
        const tx = { client, schema: w.names.schema };
        const current = await activeGeneration(tx, contracts.id);
        const next = await createGeneration(tx, {
          definition: { ...contracts, fields: [title, renewal] },
          revision: '2'.repeat(40),
        });
        for (const record of await readRecords(tx, current)) {
          const { [stage.id]: _stage, ...kept } = record.values;
          await writeGenerationRecord(tx, {
            generationId: next.id,
            recordId: record.id,
            token: (await identity(tx, contracts.id, record.id)).token,
            values: kept,
          });
        }
        await activateGeneration(tx, { generationId: next.id, expectedActiveGenerationId: current.id });
      });
      await db.databaseAdmin.query(
        `UPDATE "${w.names.schema}".tf_workflows SET next_run_at=clock_timestamp() WHERE id=$1`,
        [workflow.id],
      );
      await service.due(w.id);
      await page.goto(`${origin}/record-proof/workflows`);
      await page
        .getByRole('region', { name: 'Workflow selection' })
        .getByText('Disabled: record field unavailable', { exact: true })
        .waitFor();
      await page.getByRole('link', { name: 'Renewal reminder', exact: true }).click();
      await page
        .getByText(
          'Disabled automatically because the table, watched fields, or filter its trigger uses is no longer available. Edit the trigger in chat. Once its sponsor accepts the new revision, activate it.',
          { exact: true },
        )
        .waitFor();
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
