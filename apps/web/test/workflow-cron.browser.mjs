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
import { createWorkspaceRuntime } from '../../../packages/workspace-storage/src/runtime.ts';
import { registerWorkflows } from '../../api/src/workflows.ts';
import { protectBusinessRequests } from '../../api/src/business.ts';
import {
  reviewDefinition,
  saveWorkflow,
  openWorkflow,
  assertConfiguration,
  showWorkflowList,
} from './workflow-definition.fixture.mjs';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify'),
  cors = requireApi('@fastify/cors');
const { createWorkflows } = await import(pathToFileURL(requireApi.resolve('@tulipfarm/workflows')).href);
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);

async function choose(page, control, option) {
  await control.click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test(
  'Chromium reads saved and active schedules, shows the next run and preserves skipped-run history',
  { timeout: 120000 },
  async () => {
    const db = await fixture();
    const origin = 'http://127.0.0.1:5373',
      apiOrigin = 'http://127.0.0.1:3373';
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
      const workspace = {
        id: w.id,
        name: 'Schedule proof',
        slug: 'schedule-proof',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'local-test-session', userId: w.userId },
        user: { id: w.userId, name: 'Schedule tester', email: 'schedule@example.com' },
      };
      app = Fastify();
      app.register(cors, { origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'OPTIONS'] });
      app.get('/v1/auth/get-session', async () => session);
      app.get('/v1/workspaces', async () => [workspace]);
      app.get('/v1/workspaces/schedule-proof', async () => workspace);
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
      await app.listen({ host: '127.0.0.1', port: 3373 });
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5373', '--strictPort'],
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
      const sponsor = async name => {
        const workflow = await saved(name);
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
      };
      const formatted = iso =>
        new Date(iso).toLocaleString('en-US', {
          timeZone: 'America/New_York',
          dateStyle: 'medium',
          timeStyle: 'short',
        });

      await page.goto(`${origin}/schedule-proof/workflows`);
      await page.getByRole('heading', { name: 'No workflows yet' }).waitFor();
      const hourly = await saveWorkflow(service, w, reviewDefinition('Hourly sync', { kind: 'interval', minutes: 15 }));
      let viewer = await openWorkflow(page, hourly);
      await assertConfiguration(viewer, 0, hourly.definition.trigger);
      await sponsor('Hourly sync');
      await page.getByRole('button', { name: 'Activate saved revision' }).click();
      await page.getByRole('button', { name: 'Disable workflow' }).waitFor();
      const interval = await saved('Hourly sync');
      assert.deepEqual(interval.definition.trigger, { kind: 'interval', minutes: 15 });
      assert.ok(Math.abs(Date.parse(interval.nextRunAt) - Date.now() - 15 * 60000) < 60000, interval.nextRunAt);
      await page
        .getByRole('region', { name: 'Workflow summary', exact: true })
        .getByText(`Next run ${formatted(interval.nextRunAt)}`, { exact: false })
        .waitFor();
      const savedCronOverInterval = await saveWorkflow(
        service,
        w,
        { ...interval.definition, trigger: { kind: 'cron', expression: '30 8 * * 1', timezone: 'UTC' } },
        interval,
      );
      viewer = await openWorkflow(page, savedCronOverInterval);
      await assertConfiguration(viewer, 0, savedCronOverInterval.definition.trigger);
      await page
        .getByRole('region', { name: 'Workflow summary', exact: true })
        .getByText(`Next run ${formatted(interval.nextRunAt)}`, { exact: false })
        .waitFor();
      assert.deepEqual(savedCronOverInterval.definition.trigger, {
        kind: 'cron',
        expression: '30 8 * * 1',
        timezone: 'UTC',
      });
      assert.deepEqual(savedCronOverInterval.activeTrigger, { kind: 'interval', minutes: 15 });
      const revisions = page.getByRole('group', { name: 'Displayed revision', exact: true });
      await revisions.getByRole('button', { name: 'Active', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Displayed revision"] [aria-pressed="true"]')?.textContent === 'Active',
      );
      await assertConfiguration(viewer, 0, interval.definition.trigger);

      const monday = await saveWorkflow(
        service,
        w,
        reviewDefinition('Monday report', { kind: 'cron', expression: '30 8 * * 1', timezone: 'UTC' }),
      );
      viewer = await openWorkflow(page, monday);
      await assertConfiguration(viewer, 0, monday.definition.trigger);
      await sponsor('Monday report');
      await page.getByRole('button', { name: 'Activate saved revision' }).click();
      await page.getByRole('button', { name: 'Disable workflow' }).waitFor();
      const cron = await saved('Monday report');
      assert.deepEqual(cron.definition.trigger, { kind: 'cron', expression: '30 8 * * 1', timezone: 'UTC' });
      const next = new Date(cron.nextRunAt);
      assert.deepEqual([next.getUTCDay(), next.getUTCHours(), next.getUTCMinutes()], [1, 8, 30]);
      assert.ok(next.getTime() > Date.now() && next.getTime() - Date.now() <= 7 * 86400000, cron.nextRunAt);
      await page
        .getByRole('region', { name: 'Workflow summary', exact: true })
        .getByText(`Next run ${formatted(cron.nextRunAt)}`, { exact: false })
        .waitFor();
      await showWorkflowList(page);
      await page.getByText('Every Monday at 08:30 in UTC', { exact: true }).waitFor();
      await page.getByText(`Next run ${formatted(cron.nextRunAt)}`, { exact: true }).waitFor();
      await page.getByText(`Next run ${formatted(interval.nextRunAt)}`, { exact: true }).waitFor();

      for (const [trigger, status, code] of [
        [{ kind: 'interval', minutes: 0 }, 400, null],
        [{ kind: 'cron', expression: '30 8 * * 1', timezone: 'Not/AZone' }, 409, 'invalid-schedule'],
        [{ kind: 'cron', expression: '0 25 * * *', timezone: 'UTC' }, 409, 'invalid-schedule'],
      ]) {
        const rejected = await fetch(`${apiOrigin}/v1/workspaces/${w.id}/workflows/${cron.id}`, {
          method: 'PUT',
          headers: { cookie: 'workflow-test=1', origin, 'content-type': 'application/json' },
          body: JSON.stringify({
            revision: randomUUID(),
            expectedRevision: cron.revision,
            definition: { ...cron.definition, trigger },
          }),
        });
        assert.equal(rejected.status, status);
        if (code) assert.equal((await rejected.json()).error, code);
        assert.equal((await saved('Monday report')).revision, cron.revision);
      }
      const weekdays = await saveWorkflow(
        service,
        w,
        { ...cron.definition, trigger: { kind: 'cron', expression: '30 7 * * 1-5', timezone: 'UTC' } },
        cron,
      );
      viewer = await openWorkflow(page, weekdays);
      await assertConfiguration(viewer, 0, weekdays.definition.trigger);

      const schedules = `"${w.names.schema}".tf_workflows`;
      const elapse = async (id, interval) =>
        new Date(
          (
            await db.databaseAdmin.query(
              `UPDATE ${schedules} SET next_run_at=clock_timestamp()-$2::interval WHERE id=$1 RETURNING next_run_at`,
              [id, interval],
            )
          ).rows[0].next_run_at,
        ).toISOString();
      const stamped = iso =>
        new Date(iso).toLocaleString('en-US', {
          timeZone: 'America/New_York',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        });
      const lateDue = await elapse(interval.id, '40 minutes');
      await service.due(w.id);
      const alignedNext = Date.parse((await saved('Hourly sync')).nextRunAt);
      assert.ok(Math.abs(alignedNext - Date.parse(lateDue) - 45 * 60000) < 5000, new Date(alignedNext).toISOString());
      const overlapDue = await elapse(interval.id, '1 minute');
      await service.due(w.id);
      await showWorkflowList(page);
      await page.getByRole('link', { name: 'Hourly sync', exact: true }).click();
      await page.getByRole('tab', { name: 'Runs', exact: true }).click();
      await page.getByRole('button', { name: 'Check run history' }).click();
      const history = page.getByRole('region', { name: 'Run history' });
      await history.getByText(`Scheduled for ${stamped(lateDue)}.`).waitFor();
      const scheduled = (await service.history(w.id, w.userId, interval.id)).runs.find(
        run => run.input.scheduledFor === lateDue,
      );
      assert.ok(scheduled);
      await history
        .locator(`#workflow-run-${scheduled.id}`)
        .getByRole('button', { name: 'View run diagram', exact: true })
        .click();
      const pinned = page.getByRole('region', { name: 'Selected run diagram', exact: true });
      await pinned.getByText('Definition used by this run', { exact: true }).waitFor();
      await assertConfiguration(pinned, 0, interval.definition.trigger);
      assert.equal(
        (await service.runDetail(w.id, w.userId, interval.id, scheduled.id)).run.revision,
        interval.revision,
      );
      const [filtered] = await Promise.all([
        page.waitForResponse(
          response =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname.endsWith(`/${interval.id}/runs`) &&
            new URL(response.url()).searchParams.get('status') === 'skipped' &&
            response.ok(),
        ),
        choose(page, history.getByLabel('Show', { exact: true }), 'Skipped'),
      ]);
      assert.ok((await filtered.json()).runs.some(run => run.input.scheduledFor === overlapDue));
      await history
        .getByText(
          `Skipped the run scheduled for ${stamped(overlapDue)} because the previous scheduled run had not finished.`,
        )
        .waitFor();
      await history
        .getByText(
          `Missed 2 scheduled runs from ${stamped(new Date(Date.parse(lateDue) + 15 * 60000).toISOString())} through ${stamped(new Date(Date.parse(lateDue) + 30 * 60000).toISOString())}. One late run started instead of catching up.`,
        )
        .waitFor();
      assert.equal(await history.locator('article').getByText('Skipped', { exact: true }).count(), 2);
      assert.equal(await history.getByRole('alert').count(), 0);
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
