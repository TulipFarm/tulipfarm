import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { serveWorkspaceShellEvent, workspaceShellReads } from './workspace.fixture.mjs';
import { assertConfiguration, reviewDefinition } from './workflow-definition.fixture.mjs';

const port = Number(process.env.P1_BROWSER_PORT ?? 5307);
const origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-09-30T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const teamId = '33333333-3333-4333-8333-333333333333';
const otherTeam = '44444444-4444-4444-8444-444444444444';
const tableId = '55555555-5555-4555-8555-555555555555';
const agentId = '66666666-6666-4666-8666-666666666666';
const teams = [
  { id: teamId, name: 'Engineering' },
  { id: otherTeam, name: 'Support' },
];
const capabilities = {
  manageSchema: true,
  createRecord: true,
  readRecords: true,
  updateRecord: true,
  deleteRecord: true,
  confirmMigration: true,
};
const appliedTable = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: teamId,
  label: 'Customers',
  fields: [],
  uniqueKeys: [],
};
const definition = {
  formatVersion: 1,
  id: tableId,
  label: 'Customers',
  revision: 'a'.repeat(40),
  tableName: `r_${tableId.replaceAll('-', '')}`,
  fields: [],
};
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    if (
      await fetch(origin).then(
        response => response.ok,
        () => false,
      )
    )
      break;
    assert.ok(attempt < 100, 'Vite starts');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile,
      hasTouch: mobile,
      reducedMotion: 'reduce',
      colorScheme: mobile ? 'dark' : 'light',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const workflows = [
      {
        id: '77777777-7777-4777-8777-777777777777',
        revision: '88888888-8888-4888-8888-888888888888',
        activeRevision: null,
        enabled: false,
        generation: 1,
        nextRunAt: null,
        activeTrigger: null,
        webhookConfigured: false,
        capabilities: { read: true, invoke: true, manage: true },
        definition: reviewDefinition('Expense review'),
      },
    ];
    let tableAccess = true;
    let grantTeams = [teamId];
    let grantVersion = 'a'.repeat(64);
    let grantConflict = false;
    const grantWrites = [];
    const executionWrites = [];
    const runWrites = [];
    const activationWrites = [];
    let runStarted = false;
    let responded = false;
    const currentRun = () => ({
      id: agentId,
      workflowId: workflows[0].id,
      revision: workflows[0].revision,
      status: responded ? 'completed' : 'waiting',
      source: 'manual',
      input: { request: 'Review expenses' },
      createdAt: workspace.createdAt,
      error: null,
      steps: [
        {
          stepId: 'request',
          ordinal: 0,
          status: 'completed',
          output: { request: { request: 'Review expenses' } },
          prompt: null,
        },
        {
          stepId: 'review',
          ordinal: 1,
          status: responded ? 'completed' : 'waiting',
          output: responded ? { approved: true, comment: '' } : null,
          prompt: responded ? null : 'Approve this expense?',
        },
        ...(responded
          ? [
              {
                stepId: 'result',
                ordinal: 2,
                status: 'completed',
                output: { decision: { approved: true, comment: '' } },
                prompt: null,
              },
            ]
          : []),
      ],
    });
    // Agent policies carry person grants (cloud e445ed86 #478, packages/agents/src/saved-contracts.ts:28).
    const policy = {
      version: 1,
      owningTeamId: teamId,
      grants: [],
      personGrants: [],
      enrollment: [teamId],
      enabled: true,
      limits: [{ assetId: tableId, permissions: ['table.row.read'] }],
    };
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (await serveWorkspaceShellEvent(route, workspace)) return;
      const shell = workspaceShellReads(workspace.id).find(([url]) => url === path);
      if (shell) return route.fulfill({ json: shell[1] });
      let json;
      if (path === '/v1/auth/get-session')
        json = {
          session: { id: 'session-ada', userId: 'ada' },
          user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
        };
      else if (path === '/v1/user/visit') json = { firstSession: false };
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === '/v1/workspaces/acme') json = workspace;
      else if (path.endsWith('/credits'))
        json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: agentId,
          role: 'admin',
          teams,
          capabilities: { manageGovernance: true, canLeave: true },
        };
      else if (path.endsWith('/model-catalog')) json = chatCatalog;
      else if (path.endsWith('/projects')) json = [];
      else if (path.endsWith('/conversations')) json = { chats: [], nextCursor: null };
      else if (path.endsWith('/google-workspace/availability')) json = { configured: false };
      else if (path.endsWith('/google-workspace')) json = { status: 'disconnected' };
      else if (path.endsWith('/google-workspace/operations/proposals')) json = { proposals: [], nextCursor: null };
      else if (path.endsWith('/workflows')) json = workflows;
      else if (path.endsWith('/workflows/sharing-candidates')) json = { membershipId: agentId, people: [], teams: [] };
      else if (path.includes('/workflows/') && path.endsWith('/grants')) json = [];
      else if (path.endsWith(`/workflows/${workflows[0].id}`)) {
        assert.equal(method, 'GET', 'workflow definitions are prepared in chat, never edited on this page');
        json = {
          workflowId: workflows[0].id,
          revision: workflows[0].revision,
          savedRevision: workflows[0].revision,
          activeRevision: workflows[0].activeRevision,
          definition: workflows[0].definition,
          actor: null,
          canManage: true,
          archived: false,
        };
      } else if (path.endsWith('/activation')) {
        const body = route.request().postDataJSON();
        activationWrites.push(body);
        assert.equal(body.revision, workflows[0].revision);
        workflows[0].enabled = body.enabled;
        workflows[0].activeRevision = body.revision;
        workflows[0].activeTrigger = workflows[0].definition.trigger;
        workflows[0].generation++;
        json = workflows[0];
      } else if (path.includes('/workflows/') && path.endsWith('/runs')) {
        if (method === 'POST') {
          runWrites.push(route.request().postDataJSON());
          runStarted = true;
          json = { runId: agentId };
        } else json = { runs: runStarted ? [currentRun()] : [], nextCursor: null };
      } else if (path.endsWith(`/runs/${agentId}`))
        json = { run: currentRun(), definition: workflows[0].definition, actor: null, canManage: true };
      else if (path.endsWith('/input')) {
        runWrites.push(route.request().postDataJSON());
        responded = true;
        json = {};
      } else if (path.endsWith('/provider-integrations')) json = [];
      else if (path.endsWith('/governance'))
        json = {
          actorMembershipId: agentId,
          members: [{ id: agentId, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }],
          teams: teams.map(team => ({ ...team, description: '', membershipIds: [] })),
          tables: [],
          grants: [],
        };
      else if (path.endsWith('/integrations/creation-context')) json = { teams };
      else if (path.includes('/integrations/creation-grants/'))
        json = { owningTeamId: path.split('/').at(-1), teamIds: grantTeams, version: grantVersion };
      else if (path.endsWith('/integrations/creation-grants')) {
        const body = route.request().postDataJSON();
        grantWrites.push(body);
        if (grantConflict) {
          grantConflict = false;
          grantTeams = [otherTeam];
          grantVersion = 'b'.repeat(64);
          return route.fulfill({ status: 409, json: { error: 'conflict' } });
        }
        assert.equal(body.expectedVersion, grantVersion);
        grantTeams = body.teamIds;
        grantVersion = 'c'.repeat(64);
        json = { owningTeamId: body.owningTeamId, teamIds: grantTeams };
      } else if (path.endsWith('/integrations'))
        json = {
          integrations: [
            {
              id: tableId,
              name: 'Billing GitHub',
              owningTeamId: teamId,
              enabled: true,
              generation: 1,
              grantsVersion: 1,
              capabilities: { read: true, use: true, manage: true, administer: true },
            },
          ],
        };
      else if (path.endsWith('/tables/authoring-context'))
        json = {
          currentSoulRevision: 'a'.repeat(40),
          savedDefinition: null,
          appliedDefinition: null,
          teams: tableAccess ? teams : [],
          capabilities,
        };
      // Table list and detail reads carry the applied definition state (cloud 7e345588 #844, features/tables/api.ts:10-11,19).
      else if (path.endsWith('/tables'))
        json = {
          tables: [
            { id: tableId, revision: 'a'.repeat(40), definition: appliedTable, appliedAt: null, recordCount: '0' },
          ],
          nextCursor: null,
        };
      else if (path.endsWith(`/tables/${tableId}/authoring-context`))
        json = {
          currentSoulRevision: 'a'.repeat(40),
          savedDefinition: definition,
          appliedDefinition: definition,
          teams,
          capabilities,
        };
      else if (path.endsWith(`/tables/${tableId}`))
        json = {
          id: tableId,
          saved: null,
          applied: { revision: 'a'.repeat(40), definition: appliedTable, appliedAt: null },
          rowPermissions: { create: true, update: true, delete: true },
        };
      else if (path.endsWith('/rows/page')) json = { records: [], total: '0', nextCursor: null };
      else if (path.endsWith('/migrations')) json = [];
      else if (path.endsWith('/rows/query')) json = { records: [], total: '0', nextCursor: null };
      else if (path.endsWith('/agents/authoring-context'))
        json = { currentSoulRevision: 'a'.repeat(40), teams, admin: true };
      // Access and Triggers tabs need the manage capability; workspace admin is not enough (cloud 5fbb6c7c #566 and e445ed86 #478, features/agents/setup.ts:8-12).
      else if (path.endsWith(`/agents/${agentId}`))
        json = {
          id: agentId,
          name: 'Customer reviewer',
          owningTeamId: teamId,
          savedRevision: 'a'.repeat(40),
          definitionRevision: 'b'.repeat(64),
          definition: {
            name: 'Customer reviewer',
            instructions: 'Review customer requests.',
            tools: ['schema.inspect'],
          },
          capabilities: ['read', 'edit', 'invoke', 'manage'],
          admin: true,
          activations: [{ id: otherTeam, revision: 'b'.repeat(64), scope: policy.limits }],
        };
      else if (path.endsWith(`/agents/${agentId}/setup-draft`))
        return route.fulfill({ status: 404, json: { error: 'setup-draft-not-found' } });
      else if (path.endsWith('/policy')) json = policy;
      else if (path.endsWith('/enrollment')) {
        const body = route.request().postDataJSON();
        executionWrites.push(body);
        Object.assign(policy, {
          version: body.version + 1,
          enabled: body.enabled,
          limits: body.limits,
          enrollment: body.teamIds,
        });
        json = {};
      } else if (path.endsWith('/schedules')) json = [];
      else if (path.endsWith('/chat')) json = { configured: true };
      else return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      await route.fulfill({ json });
    });
    await page.goto(`${origin}/acme/workflows`);
    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    await page.waitForURL(url => /^\/acme\/?$/.test(url.pathname));
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .getByText(/^Help me create a workflow\./)
      .waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('');
    await page.goto(`${origin}/acme/workflows?workflow=${workflows[0].id}`);
    {
      const viewer = page.getByRole('region', { name: 'Expense review workflow', exact: true });
      await viewer.getByRole('figure', { name: 'Read-only workflow diagram', exact: true }).waitFor();
      await assertConfiguration(viewer, 0, workflows[0].definition.trigger);
      await assertConfiguration(viewer, 2, workflows[0].definition.steps[1]);
      await viewer.getByRole('button', { name: 'Edit in chat', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Name', { exact: true }).count(), 0);
      assert.equal(await page.getByLabel('Workflow definition JSON', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Save revision', exact: true }).count(), 0);
      await page.reload();
      await assertConfiguration(viewer, 2, workflows[0].definition.steps[1]);
      assert.equal(await page.getByLabel('Bearer token for new source or rotation').count(), 0);
      await page.getByRole('button', { name: 'Activate saved revision', exact: true }).click();
      await page.getByRole('button', { name: 'Disable workflow', exact: true }).waitFor();
      assert.equal(activationWrites.length, 1);
      assert.deepEqual(
        { enabled: activationWrites[0].enabled, revision: activationWrites[0].revision },
        { enabled: true, revision: workflows[0].revision },
      );
      await page
        .getByRole('region', { name: 'Workflow summary', exact: true })
        .getByText('Active', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: 'Start a run', exact: true }).click();
      await page.getByLabel('Request to review', { exact: true }).fill('Review expenses');
      await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
      await page.getByRole('button', { name: 'View run diagram', exact: true }).click();
      const runViewer = page.getByRole('region', { name: 'Selected run diagram', exact: true });
      await runViewer.getByText('Definition used by this run', { exact: true }).waitFor();
      await assertConfiguration(runViewer, 2, workflows[0].definition.steps[1]);
      assert.equal(await runViewer.getByRole('button', { name: 'Edit in chat', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Approve request', exact: true }).click();
      await page.getByText('Your response was recorded. The run can now resume.', { exact: true }).waitFor();
      await page.waitForFunction(
        () => ![...document.querySelectorAll('button')].find(button => button.textContent === 'Run workflow')?.disabled,
      );
      assert.deepEqual(runWrites[0].input, { request: 'Review expenses' });
      assert.deepEqual(runWrites[1].output, { approved: true, comment: '' });
      assert.equal(runWrites[1].stepId, 'review');
      if (process.env.P1_SCREENSHOT_DIR) {
        await runViewer.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${process.env.P1_SCREENSHOT_DIR}/workflows-${mobile ? 'mobile' : 'desktop'}.png`,
        });
      }
      await page.goto(`${origin}/acme/tables`);
      await page.getByRole('heading', { name: 'Tables', exact: true }).last().waitFor();
      // Table creation moved to a reviewed chat handoff; the list no longer gates it on authoring context (cloud 0c6cac9d, 5e9daa6e #880, features/tables/tables.tsx:51; features/chat/private-conversations.tsx:143).
      await page.getByRole('link', { name: 'New table', exact: true }).first().click();
      await page.waitForURL(url => url.pathname === '/acme' && url.searchParams.get('intent') === 'create-table');
      const tablePrompt = page
        .locator('main')
        .getByRole('textbox', { name: 'Message', exact: true })
        .filter({ visible: true })
        .first();
      await tablePrompt.waitFor();
      assert.match(await tablePrompt.innerText(), /^Help me create a new table\./);
      await page.goto(`${origin}/acme/tables/${tableId}`);
      await page.getByRole('heading', { name: 'Rows', exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Saved fields', exact: true }).isVisible(), false);
      if (process.env.P1_SCREENSHOT_DIR)
        await page.screenshot({ path: `${process.env.P1_SCREENSHOT_DIR}/tables-${mobile ? 'mobile' : 'desktop'}.png` });
      await page.goto(`${origin}/acme/integrations#github-integrations`);
      await page.getByRole('button', { name: 'Open Billing GitHub', exact: true }).waitFor();
      assert.equal(await page.getByLabel('GitHub token', { exact: true }).isVisible(), false);
      // Team creation grants for integrations are no longer offered; IntegrationCreationGrants is unrendered since cloud e445ed86 (#478), features/integrations/setup.tsx:82.
      assert.equal(
        await page.getByRole('button', { name: 'Who can create GitHub integrations', exact: true }).count(),
        0,
      );
      assert.equal(await page.getByRole('heading', { name: 'Integration creation access', exact: true }).count(), 0);
      if (process.env.P1_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.P1_SCREENSHOT_DIR}/permissions-${mobile ? 'mobile' : 'desktop'}.png`,
          fullPage: true,
        });
      // On mobile Bud's launcher is fixed bottom-right over the last form footer; move it as a user would (cloud features/chat/bud-position.ts:3-12).
      if (mobile) await page.evaluate(() => localStorage.setItem('tulipfarm:bud-corner', 'bottom-left'));
      await page.goto(`${origin}/acme/agents/${agentId}`);
      await page.getByRole('heading', { name: 'Customer reviewer', exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Access', exact: true }).click();
      await page.getByRole('button', { name: 'Save enrollment', exact: true }).click();
      await page.getByText('Administration saved.', { exact: true }).waitFor();
      assert.equal(executionWrites[0].enabled, true);
      assert.deepEqual(executionWrites[0].limits, policy.limits);
      await page.getByRole('tab', { name: 'Triggers', exact: true }).click();
      // Schedules default to a saved prompt; table inspection is the second kind (cloud 5aaf3243 #657, features/agents/schedules.tsx:37-38).
      await page.getByRole('radio', { name: 'Inspect a table', exact: true }).click();
      await page.getByLabel('Table to inspect', { exact: true }).click();
      await page.getByRole('option', { name: `Customers · Engineering · ${tableId.slice(0, 8)}`, exact: true }).click();
      assert.match(await page.getByLabel('Table to inspect', { exact: true }).textContent(), /Customers · Engineering/);
      if (process.env.P1_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.P1_SCREENSHOT_DIR}/p1-${mobile ? 'mobile' : 'desktop'}.png`,
          fullPage: true,
        });
      console.log(
        `${mobile ? 'Mobile' : 'Desktop'} passed: read-only workflow and pinned run, chat authoring handoff, approval, table creation handoff, enrollment preservation, named table selection.`,
      );
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
