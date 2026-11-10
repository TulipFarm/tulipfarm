import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { taskSummarySchema } from '@tulipfarm/agents/task-contracts';
import { agentBuilderFixture } from './agent-builder.fixture.mjs';
import { startBuiltApp, captureBuilderScreenshot, captureBrowserFailure } from './built-app.fixture.mjs';
import { serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

for (const lifecycle of ['deleted', 'archived']) {
  test(`task history stays readable after its agent is ${lifecycle}`, { timeout: 120000 }, async t => {
    const server = await startBuiltApp();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const fixture = agentBuilderFixture();
    fixture.workspace.name = 'Operations';
    const task = taskSummarySchema.parse({
      id: randomUUID(),
      agentId: randomUUID(),
      agentLifecycle: lifecycle,
      activationId: randomUUID(),
      definitionRevision: 'b'.repeat(64),
      parentTaskId: null,
      delegationDepth: 0,
      generation: 0,
      status: 'completed',
      skills: [],
      scope: [],
      limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
      flowId: randomUUID(),
      activeMilliseconds: '1000',
      toolCalls: 0,
      createdAt: '2026-10-05T09:00:00Z',
      cost: { chargedCreditUnits: '0', heldCreditUnits: '0' },
    });
    const request = 'Summarize the completed work.';
    const result = 'The work is complete. All requested details are retained.';
    const messages = [request, result].map((text, sequence) => ({
      sequence,
      generation: 0,
      role: sequence === 0 ? 'owner' : 'agent',
      text,
      sources: [],
      createdAt: task.createdAt,
    }));
    const base = `/v1/workspaces/${fixture.workspace.id}`;
    const shell = new Map([
      ...workspaceShellReads(fixture.workspace.id),
      ['/v1/google-workspace/availability', { configured: false }],
      [`${base}/google-workspace`, { status: 'disconnected' }],
      [
        `${base}/governance`,
        {
          actorMembershipId: fixture.membership.membershipId,
          members: [],
          teams: [],
          directory: [],
          tableTeamIds: [],
          tables: [],
          grants: [],
        },
      ],
    ]);
    const errors = [],
      unexpected = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route('**/v1/**', async route => {
      if (await serveWorkspaceShellEvent(route, fixture.workspace)) return;
      const req = route.request(),
        path = new URL(req.url()).pathname;
      const send = json => route.fulfill({ json });
      if (path === `${base}/agents/${task.agentId}`) {
        unexpected.push('unavailable agent definition requested');
        return route.fulfill({ status: 404, json: { error: 'agent-not-found' } });
      }
      if (path === `${base}/agent-tasks`) return send({ tasks: [task], nextCursor: null });
      if (path === `${base}/agent-tasks/${task.id}`) return send(task);
      if (path === `${base}/agent-tasks/${task.id}/history`) return send({ messages, nextCursor: null });
      if (path === `${base}/agent-tasks/${task.id}/proposals`) return send({ proposals: [], nextCursor: null });
      if (path === `${base}/agent-tasks/${task.id}/secret-requests`) return send({ requests: [] });
      if (path === `${base}/agent-tasks/${task.id}/api-calls`) return send({ calls: [] });
      if (path === `${base}/slack/tasks/${task.id}/actions`) return send({ actions: [] });
      if (path.endsWith('/recent')) return send([]);
      if (shell.has(path)) return send(shell.get(path));
      const response = fixture.respond(req.method(), req.url(), req.postDataJSON());
      if (response.status >= 400) unexpected.push(`${req.method()} ${path}`);
      return route.fulfill(response);
    });
    try {
      await page.goto(`${server.origin}/${fixture.workspace.slug}/agent-tasks`);
      const row = page.getByRole('row').filter({ hasText: request }).filter({ hasText: 'Completed' });
      await row.waitFor();
      assert.equal(await page.getByText('Task request unavailable.', { exact: false }).count(), 0);
      assert.equal(await page.getByRole('button', { name: /Retry task identity/ }).count(), 0);
      await row.getByRole('link', { name: request, exact: true }).click();
      await page.getByRole('heading', { name: request, exact: true }).waitFor();
      await page
        .getByText(`The agent for this task was ${lifecycle}. You can read this task but not continue it.`, {
          exact: true,
        })
        .waitFor();
      await page.getByRole('heading', { name: 'Result', exact: true }).waitFor();
      await page.getByText(result, { exact: true }).first().waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Follow up on this task', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Send follow-up', exact: true }).count(), 0);
      assert.equal(await page.getByText(/Send a follow-up to continue this task/).count(), 0);
      assert.equal(
        await page
          .getByText(
            /Only the task owner can view it|no longer available to your current membership|Your access changed/,
          )
          .count(),
        0,
      );
      await page.getByRole('button', { name: 'Request and history', exact: true }).click();
      await page.getByRole('heading', { name: 'You', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Agent', exact: true }).waitFor();
      await captureBuilderScreenshot(page, `task-agent-${lifecycle}`);
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
    } catch (error) {
      await captureBrowserFailure(page, `task-agent-${lifecycle}`);
      throw error;
    }
  });
}
