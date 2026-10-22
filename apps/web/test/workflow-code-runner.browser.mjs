import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime } from '../../../packages/workspace-storage/src/runtime.ts';
import { createWorkflows } from '../../../packages/workflows/dist/service.js';
import { registerWorkflows } from '../../api/src/workflows.ts';
import { protectBusinessRequests } from '../../api/src/business.ts';
import { reviewDefinition, saveWorkflow, openWorkflow, assertConfiguration } from './workflow-definition.fixture.mjs';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify'),
  cors = requireApi('@fastify/cors');
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const unavailable = 'Code steps cannot run until an isolated code runner is configured.';

test(
  'Code saves require a runner and Chromium explains activation failure with read-only recovery',
  { timeout: 120000 },
  async () => {
    const db = await fixture(),
      origin = 'http://127.0.0.1:5313',
      apiOrigin = 'http://127.0.0.1:3313';
    let runtime, app, browser, vite;
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
      const workspace = {
        id: w.id,
        name: 'Code proof',
        slug: 'code-proof',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'code-session', userId: w.userId },
        user: { id: w.userId, name: 'Author', email: 'author@example.com' },
      };
      app = Fastify();
      app.register(cors, { origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'] });
      app.get('/v1/auth/get-session', async () => session);
      app.get('/v1/workspaces', async () => [workspace]);
      app.get('/v1/workspaces/code-proof', async () => workspace);
      app.get(`/v1/workspaces/${w.id}/governance/me`, async () => ({
        membershipId: w.membershipId,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: true },
      }));
      app.register(
        async routes => {
          protectBusinessRequests(routes);
          registerWorkflows(routes, { service, auth: { api: { getSession: async () => session } } });
        },
        { prefix: '/v1' },
      );
      await app.listen({ host: '127.0.0.1', port: 3313 });
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5313', '--strictPort'],
        { env: { ...process.env, VITE_API_URL: apiOrigin }, stdio: 'ignore' },
      );
      for (let i = 0; ; i++) {
        try {
          if ((await fetch(origin)).ok) break;
        } catch {}
        if (i > 100) throw new Error('Vite start timed out');
        await setTimeout(100);
      }
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);

      await page.goto(`${origin}/code-proof/workflows`);
      const definition = reviewDefinition('Code arithmetic');
      definition.steps.push({
        id: 'code',
        kind: 'code',
        language: 'javascript',
        source: 'return {amount: input.amount + 2};',
        input: { kind: 'input', path: [] },
      });
      const rejected = await fetch(`${apiOrigin}/v1/workspaces/${w.id}/workflows/${randomUUID()}`, {
        method: 'PUT',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ revision: randomUUID(), expectedRevision: null, definition }),
      });
      assert.equal(rejected.status, 409);
      assert.equal((await rejected.json()).error, 'code-steps-unavailable');
      assert.deepEqual(await service.list(w.id, w.userId), [], 'nothing was saved');

      const recovered = await saveWorkflow(service, w, { ...definition, steps: definition.steps.slice(0, -1) });
      await openWorkflow(page, recovered);

      const id = randomUUID(),
        revision = randomUUID();
      await createWorkflows(runtime, { codeSteps: true }).save(w.id, w.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Saved code',
          trigger: { kind: 'manual' },
          steps: [
            {
              id: 'javascript_total',
              kind: 'code',
              language: 'javascript',
              source: 'return input;',
              input: { kind: 'input', path: [] },
            },
          ],
        },
      });
      const savedCode = (await service.list(w.id, w.userId)).find(item => item.id === id);
      const viewer = await openWorkflow(page, savedCode);
      await assertConfiguration(viewer, 1, savedCode.definition.steps[0]);
      await page.getByRole('button', { name: 'Activate saved revision', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: unavailable }).waitFor();
      assert.equal((await service.list(w.id, w.userId)).find(item => item.id === id).enabled, false);
      const fixed = await saveWorkflow(
        service,
        w,
        {
          ...savedCode.definition,
          steps: [{ id: 'copy', kind: 'transform', fields: { input: { kind: 'input', path: [] } } }],
        },
        savedCode,
      );
      await openWorkflow(page, fixed);
      await page.getByRole('button', { name: 'Activate saved revision', exact: true }).click();
      await page.getByRole('button', { name: 'Disable workflow', exact: true }).waitFor();
      assert.equal((await service.list(w.id, w.userId)).find(item => item.id === id).activeRevision, fixed.revision);
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
