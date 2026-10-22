import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { outboundFixture } from '../../../packages/agents/test/slack-actions.integration.mjs';
import { createWorkflows } from '../../../packages/workflows/src/service.ts';
import { registerWorkflows } from '../../api/src/workflows.ts';

const requireApi = createRequire(new URL('../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify'),
  cors = requireApi('@fastify/cors');

test(
  'native Slack workflow editor and pending approval show sent, rejected, expired and unknown outcomes',
  { timeout: 60000 },
  async () => {
    const f = await outboundFixture({ channelName: 'tech' }),
      w = f.workspace;
    const origin = 'http://127.0.0.1:5478',
      apiOrigin = 'http://127.0.0.1:3478';
    const oldOrigin = process.env.WEB_ORIGIN;
    let app, browser, vite;
    try {
      process.env.WEB_ORIGIN = origin;
      await f.db.platform.query(`DELETE FROM ${f.table('tf_grants')} WHERE asset_id=$1`, [f.destinationId]);
      const service = createWorkflows(f.runtime, { slackActions: f.service });
      const id = randomUUID(),
        revision = randomUUID();
      await service.save(w.id, w.userId, id, {
        revision,
        expectedRevision: null,
        definition: {
          version: 1,
          name: 'Tickets to Slack',
          trigger: { kind: 'manual' },
          steps: [
            {
              id: 'notify',
              kind: 'slack-message',
              destinationId: f.destinationId,
              text: { kind: 'input', path: ['title'] },
            },
          ],
        },
      });
      await service.activate(w.id, w.userId, id, {
        commandId: randomUUID(),
        expectedGeneration: 1,
        revision,
        enabled: true,
      });
      const { runId } = await service.start(w.id, w.userId, id, {
        requestId: randomUUID(),
        input: { title: 'Synthetic ticket' },
      });
      const work = { workspaceId: w.id, runId };
      await service.advance(work);
      const workspace = {
        id: w.id,
        name: 'Slack proof',
        slug: 'slack-proof',
        createdAt: new Date().toISOString(),
        status: 'ready',
        soulCommit: 'a'.repeat(40),
      };
      const session = {
        session: { id: 'local-slack', userId: w.userId },
        user: { id: w.userId, name: 'Slack tester', email: 'slack@example.com' },
      };
      const auth = { api: { getSession: async () => session } };
      app = Fastify();
      app.register(cors, { origin, credentials: true, methods: ['GET', 'POST', 'PUT', 'OPTIONS'] });
      app.get('/v1/auth/get-session', async () => session);
      app.get('/v1/workspaces', async () => [workspace]);
      app.get('/v1/workspaces/slack-proof', async () => workspace);
      app.get(`/v1/workspaces/${w.id}/governance/me`, async () => ({
        membershipId: w.membershipId,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: true },
      }));
      app.register(async routes => registerWorkflows(routes, { service, auth }), { prefix: '/v1' });
      app.get(`/v1/workspaces/${w.id}/slack/destinations`, () => f.service.destinations(w.id, w.userId));
      app.get(`/v1/workspaces/${w.id}/slack/destinations/:destinationId`, request =>
        f.service.destination(w.id, w.userId, request.params.destinationId),
      );
      app.get(`/v1/workspaces/${w.id}/slack/actions/:actionId`, request =>
        f.service.read(w.id, w.userId, request.params.actionId),
      );
      app.put(`/v1/workspaces/${w.id}/slack/actions/:actionId`, async request => {
        const result = await f.decide(w.id, w.userId, request.params.actionId, request.body);
        const pending = { workspaceId: w.id, runId: result.runId };
        await service.advance(pending);
        await service.advance(pending);
        return result;
      });
      await app.listen({ host: '127.0.0.1', port: 3478 });
      vite = spawn(
        'pnpm',
        ['--filter', '@tulipfarm/web', 'dev', '--host', '127.0.0.1', '--port', '5478', '--strictPort'],
        { env: { ...process.env, VITE_API_URL: apiOrigin }, stdio: 'ignore' },
      );
      for (
        let i = 0;
        !(await fetch(origin).then(
          r => r.ok,
          () => false,
        ));
        i++
      ) {
        assert.ok(i < 150 && vite.exitCode === null);
        await delay(100);
      }
      const cdpPort = process.env.SLACK_WORKFLOW_CDP_PORT;
      browser = await chromium.launch(cdpPort ? { args: [`--remote-debugging-port=${cdpPort}`] } : {});
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`${origin}/slack-proof/workflows`);
      await page.getByRole('button', { name: 'Tickets to Slack', exact: true }).click();
      await page.getByRole('heading', { name: '1. Send a Slack message', exact: true }).waitFor();
      await page.getByText('#tech · Slack workspace TTEST', { exact: true }).waitFor();
      await page.getByText(`Destination ID: ${f.destinationId}`, { exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Slack destination', exact: true }).waitFor();
      await page.getByText(/Saving or activating this workflow does not approve messages/).waitFor();
      if (cdpPort) {
        await mkdir('reports/check/workflow-slack', { recursive: true });
        execFileSync(
          'agent-browser',
          ['--cdp', cdpPort, 'screenshot', resolve('reports/check/workflow-slack/destination.png')],
          { stdio: 'inherit' },
        );
      }
      await page.getByRole('button', { name: 'Runs', exact: true }).click();
      await page.getByText('Waiting for your approval. Nothing has been sent.', { exact: true }).waitFor();
      assert.equal(f.effects.length, 0);
      await mkdir('reports/check/workflow-slack', { recursive: true });
      await page.getByRole('button', { name: 'Approve action', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'reports/check/workflow-slack/pending.png', fullPage: true });
      if (cdpPort) {
        execFileSync('agent-browser', ['--cdp', cdpPort, 'snapshot', '-i'], { stdio: 'inherit' });
        execFileSync(
          'agent-browser',
          ['--cdp', cdpPort, 'screenshot', resolve('reports/check/workflow-slack/agent-browser-pending.png')],
          { stdio: 'inherit' },
        );
      }
      await page.getByRole('button', { name: 'Approve action', exact: true }).click();
      await page.getByRole('button', { name: 'Check Slack action status', exact: true }).click();
      await page.getByText('Slack confirmed this action.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Delivery details', exact: true }).click();
      await page.getByText('Sent message timestamp: 6.000001', { exact: true }).waitFor();
      assert.equal(f.effects.length, 1);
      await page.screenshot({ path: 'reports/check/workflow-slack/sent.png', fullPage: true });
      for (const outcome of ['rejected', 'expired', 'unknown']) {
        f.setMode('success');
        const { runId } = await service.start(w.id, w.userId, id, {
          requestId: randomUUID(),
          input: { title: `Synthetic ${outcome}` },
        });
        const next = { workspaceId: w.id, runId };
        await service.advance(next);
        const actionId = (await service.history(w.id, w.userId, id)).runs.find(run => run.id === runId).steps[0].output
          .actionId;
        if (outcome === 'expired') {
          await f.db.databaseAdmin.query(
            `UPDATE ${f.table('tf_slack_actions')} SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
            [actionId],
          );
          await service.advance(next);
        }
        await page.getByRole('button', { name: 'Check run history', exact: true }).click();
        const section = page.getByRole('region', { name: `Slack action for run ${runId}`, exact: true });
        if (outcome === 'rejected') await section.getByRole('button', { name: 'Reject action', exact: true }).click();
        if (outcome === 'unknown') {
          f.setMode('lost');
          await section.getByRole('button', { name: 'Approve action', exact: true }).click();
        }
        await section.getByRole('button', { name: 'Check Slack action status', exact: true }).click();
        await section
          .getByText(outcome === 'unknown' ? /Delivery outcome is unknown/ : new RegExp(`Action ${outcome}\\.`))
          .waitFor();
        assert.equal(await section.getByRole('button', { name: 'Approve action', exact: true }).count(), 0);
      }
      assert.equal(f.effects.length, 2);
      await page.getByText(/Delivery outcome is unknown/).scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'reports/check/workflow-slack/unknown.png', fullPage: true });
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      vite?.kill('SIGTERM');
      await app?.close();
      await f.close();
      if (oldOrigin === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = oldOrigin;
    }
  },
);
