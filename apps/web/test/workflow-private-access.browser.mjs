import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { fixture } from '../../../packages/workspace-storage/test/integration/fixture.mjs';
import { workspaceTableMigrations } from '../../../packages/workspaces/src/table-migrations.ts';
import { createWorkspaceRuntime, qualified } from '@tulipfarm/workspace-storage/runtime';
import { createWorkflows } from '../../../packages/workflows/src/service.ts';
import { registerWorkflows } from '../../api/src/workflows.ts';
import { protectBusinessRequests } from '../../api/src/business.ts';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { reviewDefinition, saveWorkflow, openWorkflow, showWorkflowList } from './workflow-definition.fixture.mjs';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify'),
  cors = requireApi('@fastify/cors');

test(
  'ordinary member views, shares, schedules and runs privately through Chromium and real HTTP/database',
  { timeout: 120000 },
  async () => {
    const db = await fixture(),
      origin = 'http://127.0.0.1:5306',
      apiOrigin = 'http://127.0.0.1:3306';
    let runtime, app, browser, vite;
    const priorOrigin = process.env.WEB_ORIGIN;
    try {
      process.env.WEB_ORIGIN = origin;
      await db.platform.query(`SET search_path TO app; DROP TABLE IF EXISTS app.accounts;
${await readFile(new URL('../../database/migrations/0001_baseline.sql', import.meta.url), 'utf8')}`);
      const w = await db.create(await workspaceTableMigrations());
      const table = name => qualified(w.names.schema, name);
      const creator = { userId: randomUUID(), membershipId: randomUUID() },
        other = { userId: randomUUID(), membershipId: randomUUID() };
      for (const person of [creator, other])
        await db.platform.query(`INSERT INTO ${table('tf_memberships')} (id,user_id,role) VALUES ($1,$2,'member')`, [
          person.membershipId,
          person.userId,
        ]);
      const { workspace, session } = createWorkspaceFixture({
        id: w.id,
        slug: 'private-workflows',
        name: 'Private workflows',
        userId: creator.userId,
      });
      runtime = createWorkspaceRuntime({
        replicaCount: 1,
        reservedConnections: 2,
        databaseConnectionBudget: 20,
        resolveCredential: async id => ({ workspaceId: id, generation: 1, connectionString: db.login(w) }),
      });
      const service = createWorkflows(runtime);
      app = Fastify();
      app.register(cors, { origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'] });
      app.get('/v1/auth/get-session', async () => session);
      app.get('/v1/workspaces', async () => [workspace]);
      app.get('/v1/workspaces/private-workflows', async () => workspace);
      app.get(`/v1/workspaces/${w.id}/governance/me`, async () => ({
        membershipId: creator.membershipId,
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
      }));
      app.register(
        async routes => {
          protectBusinessRequests(routes);
          registerWorkflows(routes, {
            service,
            auth: {
              api: {
                getSession: async ({ headers }) => ({
                  user: { id: headers.get('cookie')?.includes('unrelated-admin=1') ? w.userId : creator.userId },
                }),
              },
            },
          });
        },
        { prefix: '/v1' },
      );
      await app.listen({ host: '127.0.0.1', port: 3306 });
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5306', '--strictPort'],
        { env: { ...process.env, VITE_API_URL: apiOrigin }, stdio: 'ignore', detached: true },
      );
      for (let i = 0; ; i++) {
        try {
          if ((await fetch(origin)).ok) break;
        } catch {}
        if (i > 100) throw new Error('Vite start timed out');
        await delay(100);
      }
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      let failRead = true;
      await page.route('**/v1/workspaces/*/workflows', async route => {
        if (failRead)
          return route.fulfill({
            status: 503,
            json: { error: 'unavailable' },
            headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
          });
        await delay(200);
        return route.continue();
      });
      await page.goto(`${origin}/private-workflows/workflows`);
      await page.getByRole('heading', { name: 'Workflows could not load' }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'No workflows yet' }).count(), 0);
      failRead = false;
      await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
      await page.getByRole('heading', { name: 'No workflows yet' }).waitFor();
      const author = { ...w, userId: creator.userId };
      const current = await saveWorkflow(service, author, reviewDefinition('Private ordinary workflow'));
      await openWorkflow(page, current);
      await page.getByRole('heading', { name: 'Definition sharing' }).waitFor();
      const base = `${apiOrigin}/v1/workspaces/${w.id}/workflows`;
      const unrelatedHeaders = { cookie: 'unrelated-admin=1', origin, 'content-type': 'application/json' };
      assert.deepEqual(await (await fetch(base, { headers: unrelatedHeaders })).json(), []);
      for (const [suffix, method, body] of [
        [`/${current.id}?revision=${current.revision}`, 'GET'],
        [`/${current.id}/runs`, 'GET'],
        [`/${current.id}/runs`, 'POST', { requestId: randomUUID(), input: null }],
        [
          `/${current.id}/grants`,
          'PUT',
          { principal: { kind: 'person', id: w.membershipId }, permissions: ['manage'] },
        ],
      ])
        assert.equal(
          (
            await fetch(`${base}${suffix}`, {
              method,
              headers: unrelatedHeaders,
              ...(body ? { body: JSON.stringify(body) } : {}),
            })
          ).status,
          404,
        );
      const sharing = page.getByRole('region', { name: 'Workflow sharing', exact: true });
      await sharing.getByLabel('Person or team', { exact: true }).click();
      await page.getByRole('option', { name: other.userId, exact: true }).click();
      await sharing.getByRole('checkbox', { name: 'Run workflow', exact: true }).check();
      await sharing.getByRole('button', { name: 'Save sharing', exact: true }).click();
      await sharing.getByText('Sharing saved. Run histories remain private.', { exact: true }).waitFor();
      assert.equal((await service.list(w.id, other.userId))[0].capabilities.invoke, true);
      await page.getByRole('button', { name: 'Activate saved revision', exact: true }).click();
      await page.getByRole('button', { name: 'Disable workflow', exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Runs', exact: true }).click();
      await page.getByLabel('Request to review', { exact: true }).fill('Private creator input');
      await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
      await page.locator('article').getByText('Queued', { exact: true }).waitFor();
      const ownRun = (await service.history(w.id, creator.userId, current.id).then(page => page.runs))[0];
      const otherRun = await service.start(w.id, other.userId, current.id, {
        requestId: randomUUID(),
        input: 'Other requester private value',
      });
      assert.equal((await fetch(`${base}/${current.id}/runs/${ownRun.id}`, { headers: unrelatedHeaders })).status, 404);
      await service.advance({ workspaceId: w.id, runId: ownRun.id });
      await service.advance({ workspaceId: w.id, runId: ownRun.id });
      await page.getByRole('button', { name: 'Check run history', exact: true }).click();
      await page.getByRole('button', { name: 'Approve request', exact: true }).waitFor();
      assert.equal(await page.getByText(otherRun.runId, { exact: false }).count(), 0);
      await page.getByRole('button', { name: 'Approve request', exact: true }).click();
      await service.advance({ workspaceId: w.id, runId: ownRun.id });
      await service.advance({ workspaceId: w.id, runId: ownRun.id });
      await page.getByRole('button', { name: 'Check run history', exact: true }).click();
      await page.locator('article').getByText('Completed', { exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Definition', exact: true }).click();
      const scheduled = await saveWorkflow(
        service,
        author,
        { ...current.definition, trigger: { kind: 'interval', minutes: 60 } },
        current,
      );
      await openWorkflow(page, scheduled);
      await page.getByRole('region', { name: 'Unattended execution', exact: true }).waitFor();
      await page.getByLabel('Execution sponsor', { exact: true }).click();
      await page.getByRole('option', { name: creator.userId, exact: true }).click();
      await page
        .getByRole('region', { name: 'Unattended execution', exact: true })
        .getByRole('checkbox', { name: creator.userId, exact: true })
        .check();
      await page.getByRole('button', { name: 'Save sponsor and audience', exact: true }).click();
      await page
        .getByText('You sponsor this revision. Activate the saved revision to start unattended runs.', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Activate saved revision', exact: true }).click();
      await page.getByRole('button', { name: 'Disable workflow', exact: true }).waitFor();
      await db.platform.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
        [current.id],
      );
      await service.due(w.id);
      assert.equal((await service.history(w.id, creator.userId, current.id).then(page => page.runs)).length, 2);
      assert.equal((await service.history(w.id, other.userId, current.id).then(page => page.runs)).length, 1);
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await service.share(w.id, creator.userId, current.id, {
        principal: { kind: 'person', id: other.membershipId },
        permissions: ['manage'],
      });
      await service.share(w.id, other.userId, current.id, {
        principal: { kind: 'person', id: creator.membershipId },
        permissions: ['read'],
      });
      await page.getByRole('button', { name: 'Refresh workflows', exact: true }).click();
      await page.getByRole('region', { name: 'Workflow sharing', exact: true }).waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
      await page.getByRole('button', { name: 'Edit in chat', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await page.getByRole('button', { name: 'Activate saved revision', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Disable workflow', exact: true }).count(), 0);
      await page.getByRole('heading', { name: current.definition.name, exact: true }).first().waitFor();
      assert.equal(await page.getByRole('region', { name: 'Workflow sharing', exact: true }).count(), 0);
      await db.platform.query(
        `UPDATE ${table('tf_workflows')} SET next_run_at=clock_timestamp()-interval '1 minute' WHERE id=$1`,
        [current.id],
      );
      await service.due(w.id);
      await page.getByRole('button', { name: 'Refresh workflows', exact: true }).click();
      await page
        .getByText(
          'Disabled automatically because its sponsor lost access needed to run it. Ask a workflow manager to restore access or update its trigger.',
          { exact: true },
        )
        .waitFor();
      await showWorkflowList(page);
      await page.getByText('Disabled: sponsor lost access', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (vite && vite.exitCode === null) {
        const stopped = once(vite, 'exit');
        process.kill(-vite.pid, 'SIGTERM');
        await stopped;
      }
      await app?.close();
      await runtime?.close();
      await db.close();
      if (priorOrigin === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = priorOrigin;
    }
  },
);
