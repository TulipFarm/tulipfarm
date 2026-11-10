import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { taskSummarySchema } from '@tulipfarm/agents/task-contracts';
import { agentBuilderFixture } from './agent-builder.fixture.mjs';
import {
  startBuiltApp,
  captureBuilderScreenshot,
  captureBrowserFailure,
  builderBrowserOptions,
} from './built-app.fixture.mjs';
import { serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';

test(
  'returning to my tasks clears saved paging and search so the newest task comes first',
  { timeout: 60000 },
  async t => {
    const server = await startBuiltApp();
    t.after(() => server.close());
    const browser = await chromium.launch(builderBrowserOptions());
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const fixture = agentBuilderFixture();
    fixture.workspace.name = 'Operations';
    const tasks = ['2026-11-03T09:00:00Z', '2026-11-02T09:00:00Z', '2026-11-01T09:00:00Z'].map(createdAt =>
      taskSummarySchema.parse({
        id: randomUUID(),
        agentId: randomUUID(),
        agentLifecycle: 'archived',
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
        createdAt,
        cost: { chargedCreditUnits: '0', heldCreditUnits: '0' },
      }),
    );
    const names = ['New task request', 'Existing task request', 'Older existing task request'];
    const cursor = Buffer.from(JSON.stringify({ createdAt: '2026-11-02T09:00:00.000000Z', id: tasks[1].id })).toString(
      'base64url',
    );
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
      unexpected = [],
      reads = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route('**/v1/**', async route => {
      if (await serveWorkspaceShellEvent(route, fixture.workspace)) return;
      const req = route.request(),
        url = new URL(req.url()),
        path = url.pathname;
      const send = json => route.fulfill({ json });
      if (path === `${base}/agent-tasks`) {
        reads.push({ after: url.searchParams.get('after'), search: url.searchParams.get('search') });
        if (url.searchParams.has('after')) return send({ tasks: [tasks[2]], nextCursor: null });
        return send({ tasks: url.searchParams.has('search') ? [tasks[1]] : tasks.slice(0, 2), nextCursor: cursor });
      }
      for (const [index, task] of tasks.entries()) {
        if (path === `${base}/agent-tasks/${task.id}`) return send(task);
        if (path === `${base}/agent-tasks/${task.id}/history`)
          return send({
            messages: [
              { sequence: 0, generation: 0, role: 'owner', text: names[index], sources: [], createdAt: task.createdAt },
            ],
            nextCursor: null,
          });
        if (path === `${base}/agent-tasks/${task.id}/proposals`) return send({ proposals: [], nextCursor: null });
        if (path === `${base}/agent-tasks/${task.id}/secret-requests`) return send({ requests: [] });
        if (path === `${base}/agent-tasks/${task.id}/api-calls`) return send({ calls: [] });
        if (path === `${base}/slack/tasks/${task.id}/actions`) return send({ actions: [] });
      }
      if (path.endsWith('/recent')) return send([]);
      if (shell.has(path)) return send(shell.get(path));
      const response = fixture.respond(req.method(), req.url(), req.postDataJSON());
      if (response.status >= 400) unexpected.push(`${req.method()} ${path}`);
      return route.fulfill(response);
    });
    try {
      await page.goto(`${server.origin}/${fixture.workspace.slug}/agent-tasks`);
      await page.getByRole('link', { name: names[1], exact: true }).waitFor();
      await Promise.all([
        page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.pathname === `${base}/agent-tasks` && url.searchParams.get('search') === 'existing';
        }),
        page.getByRole('searchbox', { name: 'Find a task request' }).fill('existing'),
      ]);
      await page.getByRole('button', { name: 'Next task page', exact: true }).click();
      await page.getByRole('link', { name: names[2], exact: true }).waitFor();
      await captureBuilderScreenshot(page, 'tasks-before-return');
      await page.getByRole('link', { name: names[2], exact: true }).click();
      await page.getByRole('heading', { name: names[2], exact: true }).waitFor();
      await page.getByRole('link', { name: 'Back to my tasks', exact: true }).click();
      await page.getByRole('link', { name: names[0], exact: true }).waitFor();
      const rows = page.getByRole('row').filter({ has: page.getByRole('link') });
      assert.ok((await rows.first().innerText()).includes(names[0]));
      assert.equal(await page.getByRole('searchbox', { name: 'Find a task request' }).inputValue(), '');
      assert.ok(reads.some(read => read.after === cursor && read.search === 'existing'));
      assert.equal(await page.getByRole('button', { name: 'Previous task page', exact: true }).count(), 0);
      await captureBuilderScreenshot(page, 'tasks-newest-first');
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
    } catch (error) {
      await captureBrowserFailure(page, 'tasks-newest-first');
      throw error;
    }
  },
);

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

test('task outcomes come first and connected-tool controls match the task state', { timeout: 180000 }, async t => {
  const server = await startBuiltApp();
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const fixture = agentBuilderFixture();
  fixture.workspace.name = 'Operations';
  const task = taskSummarySchema.parse({
    id: randomUUID(),
    agentId: randomUUID(),
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
  const account = {
    id: randomUUID(),
    state: 'active',
    configured: true,
    identity: { id: '123', login: 'example-person' },
    generation: 1,
    scopes: ['repo'],
  };
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
  for (const status of ['completed', 'failed', 'pending', 'waiting-approval', 'paused', 'waiting-clarification']) {
    await t.test(status, async () => {
      const context = await browser.newContext({ viewport: { width: 1512, height: 777 }, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(30000);
        const errors = [],
          unexpected = [],
          selections = [];
        let showAccount = status !== 'completed';
        let selection = { accountId: null, generation: null, version: 0 };
        let mcpSelection = { id: task.id, version: 0, bindings: [], stale: false, choices: [] };
        let actions = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
          if (message.type() === 'error') errors.push(message.text());
        });
        page.on('response', response => {
          if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
        });
        page.on('requestfailed', req => {
          if (req.failure()?.errorText !== 'net::ERR_ABORTED') errors.push(req.failure()?.errorText);
        });
        await page.route('**/v1/**', async route => {
          if (await serveWorkspaceShellEvent(route, fixture.workspace)) return;
          const req = route.request(),
            path = new URL(req.url()).pathname;
          const send = json => route.fulfill({ json });
          if (path === `${base}/agents/${task.agentId}`)
            return send({
              id: task.agentId,
              name: 'Summary assistant',
              owningTeamId: null,
              savedRevision: 'a'.repeat(40),
              definitionRevision: task.definitionRevision,
              definition: { name: 'Summary assistant', instructions: 'Summarize the request.', tools: [] },
              capabilities: ['read', 'invoke'],
              activations: [{ id: task.activationId, revision: task.definitionRevision, scope: [] }],
              admin: false,
            });
          if (path === `${base}/agent-tasks/${task.id}`) return send({ ...task, status });
          if (path.endsWith(`/agent-tasks/${task.id}/history`)) return send({ messages, nextCursor: null });
          if (path.endsWith('/proposals')) return send({ proposals: [], nextCursor: null });
          if (path.endsWith('/secret-requests')) return send({ requests: [] });
          if (path.endsWith('/api-calls')) return send({ calls: [] });
          if (path === `${base}/slack/tasks/${task.id}/actions`) return send({ actions: [] });
          if (path === `${base}/workspace-mcp/capabilities`)
            return send({ enabled: true, canManageShared: false, integrationsEnabled: true, dispatchEnabled: true });
          if (path === `${base}/workspace-mcp/integrations`) return send({ integrations: [] });
          if (path.includes('/workspace-mcp/selections/')) return send(mcpSelection);
          if (path === `${base}/workspace-mcp/actions`) return send({ actions, nextCursor: null });
          if (path === `${base}/github/accounts`)
            return send({ configured: true, accounts: showAccount ? [account] : [] });
          if (path.endsWith('/investigation'))
            return send({ investigation: false, version: 0, selected: null, choices: [] });
          if (path.endsWith('/selection')) {
            if (req.method() === 'PUT') {
              const body = req.postDataJSON();
              selections.push(body);
              selection = { accountId: body.accountId, generation: 1, version: selection.version + 1 };
            }
            return send(selection);
          }
          if (path.endsWith('/batches')) return send({ batches: [] });
          if (path.endsWith('/recent')) return send([]);
          if (shell.has(path)) return send(shell.get(path));
          const response = fixture.respond(req.method(), req.url(), req.postDataJSON());
          if (response.status >= 400) unexpected.push(`${req.method()} ${path}`);
          return route.fulfill(response);
        });
        const open = async () => {
          const receipts = page.waitForResponse(response =>
            new URL(response.url()).pathname.endsWith('/workspace-mcp/actions'),
          );
          await page.goto(`${server.origin}/${fixture.workspace.slug}/agent-tasks/${task.id}`);
          await page.getByRole('heading', { name: request, exact: true }).waitFor();
          await page.getByRole('region', { name: 'Latest task update', exact: true }).waitFor();
          await receipts;
        };
        await open();
        if (status === 'completed') {
          await captureBuilderScreenshot(page, 'completed-task-result');
          const box = await page.getByText(result, { exact: true }).first().boundingBox();
          assert.ok(box && box.y >= 0 && box.y + box.height <= 777, 'The completed result fits on the first screen');
          const heading = page.getByRole('heading', { name: 'Result', exact: true });
          assert.equal(await heading.count(), 1);
          assert.equal(await page.getByRole('region', { name: 'MCP integration selection', exact: true }).count(), 0);
          assert.equal(await page.getByRole('region', { name: 'MCP actions and receipts', exact: true }).count(), 0);
          assert.equal(await page.getByRole('region', { name: 'Choose a GitHub account', exact: true }).count(), 0);
          await page.getByRole('button', { name: 'Usage and technical details', exact: true }).click();
          await page.getByText('Credits used', { exact: true }).waitFor();
          await page.getByText(`Task ID: ${task.id}`, { exact: true }).waitFor();
          actions = [
            {
              id: randomUUID(),
              digest: 'receipt',
              integrationId: randomUUID(),
              integrationName: 'Connected service',
              status: 'succeeded',
              expiresAt: '2026-10-05T10:00:00Z',
              canDecide: false,
              canReconcile: false,
              integrationPaused: false,
              reconciliation: null,
              receipt: null,
              visibility: 'requester-metadata',
            },
          ];
          await open();
          await page.getByText('Provider receipt received', { exact: true }).waitFor();
          showAccount = true;
          mcpSelection = {
            ...mcpSelection,
            bindings: [{ integrationId: account.id, slotId: 'connected-service' }],
            stale: true,
          };
          await open();
          await page.getByRole('button', { name: 'Save MCP selection', exact: true }).waitFor();
          await page.getByText(/A selected integration, tool revision, or account changed/).waitFor();
        }
        await page.getByRole('region', { name: 'Choose a GitHub account', exact: true }).waitFor();
        assert.equal(
          await page.getByText('Account selection is locked while task work is active.', { exact: true }).count(),
          status === 'pending' ? 1 : 0,
        );
        const button = page.getByRole('button', { name: 'example-person', exact: true });
        const canSelect = ['paused', 'waiting-clarification', 'failed'].includes(status);
        assert.equal(await button.isEnabled(), canSelect);
        if (canSelect) {
          await button.click();
          await page.getByRole('button', { name: 'example-person · Selected', exact: true }).waitFor();
          assert.deepEqual(selections, [{ accountId: account.id, expectedVersion: 0 }]);
        }
        assert.deepEqual(unexpected, []);
        assert.deepEqual(errors, []);
      } catch (error) {
        await captureBrowserFailure(context.pages()[0], `task-outcome-${status}`);
        throw error;
      } finally {
        await context.close();
      }
    });
  }
});
