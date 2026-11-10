import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { fixture, connect } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '../../../packages/workspace-storage/src/runtime.ts';
import { createWorkflows } from '../../../packages/workflows/dist/service.js';
import { createGeneration, activateGeneration } from '../../../packages/tables/dist/store.js';
import { inTransaction } from '../../../packages/workspace-storage/dist/provisioning.js';
import { registerWorkflows } from '../../api/src/workflows.ts';
import { protectBusinessRequests } from '../../api/src/business.ts';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const runCommand = promisify(execFile);
const Fastify = requireApi('fastify'),
  cors = requireApi('@fastify/cors');

test(
  'manual runs use active input fields, preserve JSON, write rows and explain input failures',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const origin = 'http://127.0.0.1:5692',
      apiOrigin = 'http://127.0.0.1:3692';
    let runtime, migration, app, server, browser;
    const previousOrigin = process.env.WEB_ORIGIN;
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
      const teamId = randomUUID();
      await db.platform.query(`INSERT INTO "${w.names.schema}".tf_teams(id,name) VALUES($1,'Operations')`, [teamId]);
      const nameField = { id: randomUUID(), label: 'Name', required: true, kind: 'text', maxLength: 80 };
      const table = {
        formatVersion: 2,
        id: randomUUID(),
        owningTeamId: teamId,
        label: 'People',
        fields: [nameField],
        uniqueKeys: [],
      };
      await inTransaction(migration, async client => {
        await client.query(`SET LOCAL ROLE "${w.names.customOwner}"`);
        const tx = { client, schema: w.names.schema };
        const generation = await createGeneration(tx, { definition: table, revision: '1'.repeat(40) });
        await activateGeneration(tx, { generationId: generation.id, expectedActiveGenerationId: null });
      });
      const service = createWorkflows(runtime);
      async function save(name, path) {
        const id = randomUUID(),
          revision = randomUUID();
        const definition = {
          version: 1,
          name,
          triggers: [],
          steps: [
            {
              id: 'add',
              kind: 'create-row',
              tableId: table.id,
              fields: { [nameField.id]: { kind: 'input', path } },
            },
          ],
        };
        await service.save(w.id, w.userId, id, { revision, expectedRevision: null, definition });
        await service.activate(w.id, w.userId, id, {
          commandId: randomUUID(),
          expectedGeneration: 1,
          revision,
          enabled: true,
        });
        return { id, revision, definition };
      }
      const named = await save('Add person', ['name']);
      const requested = await save('Add request', ['request']);
      const nested = await save('Add nested person', ['person', 'name']);
      const unknown = await save('Add raw input', []);
      // Saving a different input does not change the active revision used by a manual run.
      await service.save(w.id, w.userId, named.id, {
        revision: randomUUID(),
        expectedRevision: named.revision,
        definition: {
          ...named.definition,
          steps: [
            {
              ...named.definition.steps[0],
              fields: { [nameField.id]: { kind: 'input', path: ['saved_only'] } },
            },
          ],
        },
      });
      const workspace = {
        id: w.id,
        name: 'Manual runs',
        slug: 'manual-runs',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'input-session', userId: w.userId },
        user: { id: w.userId, name: 'Author', email: 'author@example.test' },
      };
      const inputs = [];
      app = Fastify();
      app.register(cors, { origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'OPTIONS'] });
      app.get('/v1/auth/get-session', async () => session);
      app.get('/v1/workspaces', async () => [workspace]);
      app.get('/v1/workspaces/manual-runs', async () => workspace);
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
            service: {
              ...service,
              start: async (...args) => {
                const result = await service.start(...args);
                inputs.push(args[3].input);
                for (let n = 0; n < 5; n++) {
                  if ((await service.advance({ workspaceId: w.id, runId: result.runId })).kind === 'done') break;
                }
                return result;
              },
            },
            auth: { api: { getSession: async () => session } },
          });
        },
        { prefix: '/v1' },
      );
      await app.listen({ host: '127.0.0.1', port: 3692 });
      server = spawn(
        process.execPath,
        [
          new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname,
          '--host',
          '127.0.0.1',
          '--port',
          '5692',
          '--strictPort',
        ],
        {
          cwd: new URL('..', import.meta.url),
          stdio: 'ignore',
          env: { ...process.env, VITE_API_URL: apiOrigin },
        },
      );
      for (let attempt = 0; ; attempt++) {
        if (
          await fetch(origin).then(
            response => response.ok,
            () => false,
          )
        )
          break;
        assert.ok(attempt < 100 && server.exitCode === null, 'isolated Vite fixture starts');
        await delay(100);
      }
      browser = await chromium.launch(
        process.env.RUN_INPUT_CDP_PORT ? { args: [`--remote-debugging-port=${process.env.RUN_INPUT_CDP_PORT}`] } : {},
      );
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(20000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const form = page.getByRole('form', { name: 'Run workflow', exact: true });
      async function open(workflow) {
        await page.goto(`${origin}/manual-runs/workflows/${workflow.id}`);
        await page.getByRole('heading', { name: workflow.definition.name, exact: true }).waitFor();
        await page.getByRole('button', { name: 'Start a run', exact: true }).click();
        await form.waitFor();
      }
      async function run(workflow, status = 'Completed') {
        const [response] = await Promise.all([
          page.waitForResponse(
            response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/runs'),
          ),
          form.getByRole('button', { name: 'Run workflow', exact: true }).click(),
        ]);
        assert.equal(response.status(), 200);
        const { runId } = await response.json();
        await page.getByRole('button', { name: 'Check run history', exact: true }).click();
        await page
          .locator(`#workflow-run-${runId}`)
          .getByRole('status')
          .filter({ hasText: new RegExp(`^${status}$`) })
          .waitFor();
        const [latest] = (await service.history(w.id, w.userId, workflow.id)).runs;
        assert.equal(latest.status, status.toLowerCase());
        return latest;
      }
      async function screenshot(name) {
        if (!process.env.RUN_INPUT_SCREENSHOTS) return;
        await mkdir(process.env.RUN_INPUT_SCREENSHOTS, { recursive: true });
        const path = `${process.env.RUN_INPUT_SCREENSHOTS}/${name}.png`;
        if (process.env.RUN_INPUT_CDP_PORT && name === 'manual-input-fields') {
          await runCommand(
            'pnpm',
            [
              'exec',
              'agent-browser',
              '--session',
              'workflow-inputs',
              '--cdp',
              process.env.RUN_INPUT_CDP_PORT,
              'screenshot',
              path,
            ],
            { timeout: 15000 },
          );
        } else await page.screenshot({ path, fullPage: true });
      }

      await open(named);
      await screenshot('manual-input-fields');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await screenshot('manual-input-mobile');
      await page.setViewportSize({ width: 1280, height: 900 });
      assert.equal(await page.getByLabel('Request to review', { exact: true }).count(), 0);
      assert.equal(await form.getByLabel('saved_only', { exact: true }).count(), 0);
      await form.getByLabel('name', { exact: true }).fill('Ada');
      const first = await run(named);
      assert.deepEqual(first.input, { name: 'Ada' });
      assert.equal(first.revision, named.revision);
      assert.equal(first.steps[0].output.operation, 'created');
      await form.getByLabel('name', { exact: true }).fill('');
      await form.getByRole('button', { name: 'Advanced JSON input', exact: true }).click();
      assert.deepEqual(JSON.parse(await form.getByLabel('Input JSON').inputValue()), { name: '' });
      await form.getByLabel('Input JSON').fill('{"name":"Grace","extra":true}');
      await form.getByRole('button', { name: 'Use fields', exact: true }).click();
      assert.equal(await form.getByLabel('name', { exact: true }).inputValue(), 'Grace');
      await form.getByRole('button', { name: 'Advanced JSON input', exact: true }).click();
      assert.deepEqual(JSON.parse(await form.getByLabel('Input JSON').inputValue()), { name: 'Grace', extra: true });
      await run(named);
      await form.getByLabel('Input JSON').fill('{');
      await form.getByRole('button', { name: 'Run workflow', exact: true }).click();
      await form.getByRole('alert').filter({ hasText: 'Enter valid JSON input.' }).waitFor();
      await form.getByLabel('Input JSON').fill('{}');
      const failed = await run(named, 'Failed');
      const article = page.locator(`#workflow-run-${failed.id}`);
      await article
        .getByRole('alert')
        .filter({ hasText: /Input field "name" is missing/ })
        .waitFor();
      await article.getByRole('button', { name: 'View run diagram', exact: true }).click();
      const viewer = page.getByRole('region', { name: 'Selected run diagram', exact: true });
      await viewer.getByRole('button', { name: 'Steps', exact: true }).click();
      await viewer.getByRole('list', { name: 'Workflow steps', exact: true }).getByRole('button').last().click();
      await viewer
        .getByRole('alert')
        .filter({ hasText: /Input field "name" is missing/ })
        .waitFor();
      await screenshot('missing-input-explanation');
      await page.getByRole('button', { name: 'Close run diagram', exact: true }).click();
      await form.getByLabel('Input JSON').fill('{"name":true}');
      const invalid = await run(named, 'Failed');
      await page
        .locator(`#workflow-run-${invalid.id}`)
        .getByRole('alert')
        .filter({ hasText: /Input field "name" has an invalid value/ })
        .waitFor();
      await page
        .locator(`#workflow-run-${invalid.id}`)
        .getByRole('button', { name: 'View run diagram', exact: true })
        .click();
      await viewer.getByRole('button', { name: 'Steps', exact: true }).click();
      await viewer.getByRole('list', { name: 'Workflow steps', exact: true }).getByRole('button').last().click();
      await viewer
        .getByRole('alert')
        .filter({ hasText: /Input field "name" has an invalid value/ })
        .waitFor();
      await open(requested);
      await form.getByLabel('request', { exact: true }).fill('Requested person');
      await run(requested);
      await open(nested);
      assert.deepEqual(JSON.parse(await form.getByLabel('Input JSON').inputValue()), { person: { name: '' } });
      await form.getByLabel('Input JSON').fill('{"person":{"name":"Lin"}}');
      await run(nested);
      await open(unknown);
      assert.deepEqual(JSON.parse(await form.getByLabel('Input JSON').inputValue()), {});
      await form.getByLabel('Input JSON').fill('"Raw person"');
      await run(unknown);
      assert.deepEqual(inputs, [
        { name: 'Ada' },
        { name: 'Grace', extra: true },
        {},
        { name: true },
        { request: 'Requested person' },
        { person: { name: 'Lin' } },
        'Raw person',
      ]);
      assert.deepEqual(errors, []);
    } finally {
      try {
        if (browser && process.env.RUN_INPUT_CDP_PORT && process.env.RUN_INPUT_SCREENSHOTS) {
          await runCommand('pnpm', ['exec', 'agent-browser', '--session', 'workflow-inputs', 'close'], {
            timeout: 10000,
          });
        }
      } finally {
        await browser?.close();
        server?.kill('SIGTERM');
        await app?.close();
        await migration?.end();
        await runtime?.close();
        await db.close();
        if (previousOrigin === undefined) delete process.env.WEB_ORIGIN;
        else process.env.WEB_ORIGIN = previousOrigin;
      }
    }
  },
);
