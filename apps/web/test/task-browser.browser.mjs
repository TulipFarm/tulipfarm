import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { taskSummarySchema } from '@tulipfarm/agents/task-contracts';
import { agentBuilderFixture } from './agent-builder.fixture.mjs';
import { startBuiltApp, captureBuilderScreenshot, captureBrowserFailure } from './built-app.fixture.mjs';
import { serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

test(
  'a run waiting for a person shows its live browser, which they take over and hand back',
  { timeout: 120000 },
  async t => {
    const server = await startBuiltApp();
    t.after(() => server.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const pixel = await page.evaluate(() => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 800 });
      return canvas.toDataURL('image/jpeg').split(',')[1];
    });
    const fixture = agentBuilderFixture();
    const task = taskSummarySchema.parse({
      id: randomUUID(),
      agentId: randomUUID(),
      agentLifecycle: 'active',
      activationId: randomUUID(),
      definitionRevision: 'b'.repeat(64),
      parentTaskId: null,
      delegationDepth: 0,
      generation: 0,
      status: 'waiting-approval',
      waitingOn: 'browser',
      skills: [],
      scope: [],
      limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
      flowId: randomUUID(),
      activeMilliseconds: '1000',
      toolCalls: 2,
      createdAt: '2026-11-24T10:00:00Z',
      cost: { chargedCreditUnits: '0', heldCreditUnits: '0' },
      activity: [
        {
          id: randomUUID(),
          tool: 'browser.handoff',
          status: 'waiting',
          presentation: { label: 'Asking you to take over the browser', brand: null },
        },
      ],
    });
    const request = 'Renew the Orchid Club membership.';
    const base = `/v1/workspaces/${fixture.workspace.id}`;
    const browserBase = `${base}/agent-tasks/${task.id}/browser`;
    const state = {
      sessionId: randomUUID(),
      url: 'https://orchid.example/renew',
      title: 'Renew your membership',
      controller: 'agent',
      needsPerson: 'Tick the terms box.',
      signIn: null,
      logins: [],
      controlledBy: null,
    };
    const controls = [];
    const shell = new Map([
      ...workspaceShellReads(fixture.workspace.id),
      ['/v1/feature-flags', { 'browser-use': true }],
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
    await page.route('**/v1/**', async route => {
      if (await serveWorkspaceShellEvent(route, fixture.workspace)) return;
      const req = route.request(),
        path = new URL(req.url()).pathname;
      const send = json => route.fulfill({ json });
      if (path === `${browserBase}/live`)
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: `retry: 60000\nevent: state\ndata: ${JSON.stringify(state)}\n\nevent: frame\ndata: ${JSON.stringify({ data: pixel, width: 1280, height: 800 })}\n\n`,
        });
      if (path === `${browserBase}/control` && req.method() === 'POST') {
        const { controller } = req.postDataJSON();
        controls.push(controller);
        Object.assign(state, { controller, needsPerson: controller === 'agent' ? null : state.needsPerson });
        return send({ browser: state });
      }
      if (path === browserBase) return send({ browser: state });
      if (path === `${base}/agent-tasks`) return send({ tasks: [task], nextCursor: null });
      if (path === `${base}/agent-tasks/${task.id}`) return send(task);
      if (path === `${base}/agent-tasks/${task.id}/history`)
        return send({
          messages: [
            { sequence: 0, generation: 0, role: 'owner', text: request, sources: [], createdAt: task.createdAt },
          ],
          nextCursor: null,
        });
      if (path === `${base}/agent-tasks/${task.id}/proposals`) return send({ proposals: [], nextCursor: null });
      if (path === `${base}/agent-tasks/${task.id}/secret-requests`) return send({ requests: [] });
      if (path === `${base}/agent-tasks/${task.id}/api-calls`) return send({ calls: [] });
      if (path === `${base}/slack/tasks/${task.id}/actions`) return send({ actions: [] });
      if (path === `${base}/github/tasks/${task.id}/batches`) return send({ batches: [] });
      if (path === `${base}/github/tasks/${task.id}/selection`)
        return send({ accountId: null, generation: null, version: 0 });
      if (path === `${base}/github/tasks/${task.id}/investigation`)
        return send({ investigation: false, version: 0, selected: null, choices: [] });
      if (path === `${base}/agents/${task.agentId}`)
        return route.fulfill({ status: 404, json: { error: 'not-found' } });
      if (path === `${base}/conversations`) return send({ chats: [], nextCursor: null });
      if (path.endsWith('/recent')) return send([]);
      if (shell.has(path)) return send(shell.get(path));
      const response = fixture.respond(req.method(), req.url(), req.postDataJSON());
      if (response.status >= 400) unexpected.push(`${req.method()} ${path}`);
      return route.fulfill(response);
    });
    try {
      await page.goto(`${server.origin}/${fixture.workspace.slug}/agent-tasks/${task.id}`);
      await page.getByText('The agent needs you', { exact: true }).waitFor();
      await page.getByRole('img', { name: 'Live view of Renew your membership' }).waitFor();
      // A run waiting on its browser asks for a hand back, not a review.
      await page.getByText('Needs you in the browser', { exact: true }).first().waitFor();
      await page
        .getByText(
          'The agent is waiting for someone to finish a step in its browser. Take over, finish it, then hand back. If no one does, the run stops after 24 hours.',
        )
        .waitFor();
      assert.equal(await page.getByText('Needs your review').count(), 0);
      // Saving and loading logins belong to chats; a run's logins come from its agent.
      assert.equal(await page.getByRole('button', { name: 'Save login' }).count(), 0);
      await page.getByRole('button', { name: 'Take over', exact: true }).click();
      await page.getByText('You’re in control. The agent waits until you hand back.').waitFor();
      await captureBuilderScreenshot(page, 'task-browser-taken-over');
      await page.getByRole('button', { name: 'Hand back to the agent', exact: true }).click();
      await page.getByRole('button', { name: 'Take over', exact: true }).waitFor();
      assert.deepEqual(controls, ['person', 'agent']);
      // Handing a run's browser back wakes the run on the server; nothing is sent as a follow-up.
      assert.equal(await page.getByRole('textbox', { name: 'Follow up on this task' }).count(), 0);
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
    } catch (error) {
      await captureBrowserFailure(page, 'task-browser');
      throw error;
    }
  },
);
