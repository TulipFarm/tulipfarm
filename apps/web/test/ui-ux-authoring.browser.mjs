import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { assertConfiguration } from './workflow-definition.fixture.mjs';

const port = 5464,
  origin = `http://127.0.0.1:${port}`;
const shots = process.env.UI_AUTHORING_SCREENSHOTS;
const id = n =>
  `${n}`.repeat(8) +
  '-' +
  `${n}`.repeat(4) +
  '-4' +
  `${n}`.repeat(3) +
  '-8' +
  `${n}`.repeat(3) +
  '-' +
  `${n}`.repeat(12);
const [wid, mid, tid, aid, rid, sid, integrationId, activationId] = Array.from({ length: 8 }, (_, i) => id(i + 1));
const at = '2026-09-30T09:00:00Z';
const workspace = {
  id: wid,
  slug: 'acme',
  name: 'Acme Operations',
  status: 'ready',
  createdAt: at,
  soulCommit: 'a'.repeat(40),
};
const teams = [{ id: tid, name: 'Customer Operations', description: 'Customer support', membershipIds: [mid] }];
const families = [
  {
    id: 'claude-sonnet',
    displayName: 'Claude Sonnet',
    vendor: 'anthropic',
    provider: 'anthropic',
    currentVersion: 'sonnet-v1',
    inputCreditsPerMillionTokens: 300,
    outputCreditsPerMillionTokens: 1500,
    available: true,
    unavailableReason: null,
    mappingRevision: 'mapping-1',
  },
];
const field = {
  id: sid,
  label: 'Customer name',
  kind: 'text',
  required: true,
  unique: false,
  columnName: `f_${sid.replaceAll('-', '')}`,
};
const definition = {
  formatVersion: 1,
  id: rid,
  label: 'Customers',
  revision: 'a'.repeat(40),
  tableName: `r_${rid.replaceAll('-', '')}`,
  fields: [field],
};
const tableState = {
  id: rid,
  saved: null,
  applied: { revision: definition.revision, definition, appliedAt: at },
  rowPermissions: { create: true, update: true, delete: true },
};
const agent = {
  id: aid,
  name: 'Customer follow-up assistant',
  owningTeamId: tid,
  savedRevision: 'a'.repeat(40),
  definitionRevision: 'b'.repeat(64),
  definition: {
    name: 'Customer follow-up assistant',
    instructions: 'Review customer rows and prepare changes for approval.',
    tools: ['rows.list', 'rows.update'],
    modelFamilyId: 'claude-sonnet',
  },
  capabilities: ['read', 'edit', 'invoke', 'manage', 'delete'],
  admin: true,
  activations: [
    {
      id: activationId,
      revision: 'b'.repeat(64),
      scope: [{ assetId: rid, permissions: ['table.row.read', 'table.row.update'] }],
    },
  ],
};
const prepare = stepId => ({ id: stepId, kind: 'transform', fields: { total: { kind: 'input', path: ['total'] } } });
const workflow = {
  id: id('a'),
  revision: id('b'),
  activeRevision: null,
  enabled: false,
  generation: 1,
  nextRunAt: null,
  activeTrigger: null,
  webhookConfigured: false,
  capabilities: { read: true, invoke: true, manage: true },
  definition: {
    version: 1,
    name: 'Order review',
    trigger: { kind: 'manual' },
    steps: [
      prepare('prepare'),
      {
        id: 'check',
        kind: 'condition',
        when: { left: { kind: 'input', path: ['total'] }, op: 'gt', right: { kind: 'literal', value: 100 } },
        ifMet: ['notify'],
        otherwise: [],
      },
      prepare('notify'),
      {
        id: 'post',
        kind: 'http',
        method: 'POST',
        url: 'https://example.com/orders',
        headers: {},
        body: { kind: 'step', step: 'prepare', path: [] },
        credential: { integrationId, header: 'x-api-key' },
      },
    ],
  },
};
const integration = {
  id: integrationId,
  name: 'Order form',
  source: { provider: 'forms', formId: 'orders' },
  enabled: true,
  generation: 1,
  authorized: true,
  capabilities: { use: true, manage: true, rotate: true },
};

function fixture(state) {
  return async route => {
    const request = route.request(),
      url = new URL(request.url()),
      p = url.pathname;
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (request.method() !== 'GET' && p.includes('/workflows')) {
      state.writes.push(p);
      return send({ error: 'unexpected-write' }, 500);
    }
    if (p === '/v1/auth/get-session')
      return send({
        session: { id: 'fixture', userId: 'ada' },
        user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
      });
    if (p === '/v1/user/visit') return send({ firstSession: false });
    if (p === '/v1/workspaces') return send([workspace]);
    if (p === '/v1/workspaces/acme') return send(workspace);
    if (p.endsWith('/credits'))
      return send({ available: 100, granted: 100, used: 0, held: 0, days: [], breakdown: [], series: [] });
    if (p.endsWith('/governance/me'))
      return send({
        membershipId: mid,
        role: 'admin',
        teams,
        capabilities: { manageGovernance: true, canLeave: true },
      });
    if (p.endsWith('/governance'))
      return send({
        actorMembershipId: mid,
        members: [{ id: mid, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' }],
        teams,
        directory: [],
        tableTeamIds: [tid],
        tables: [],
        grants: [],
      });
    if (p.endsWith('/model-catalog')) return send({ families });
    if (p.endsWith('/model-policy/availability'))
      return send({ items: [{ familyId: 'claude-sonnet', enabled: true, revision: 1 }] });
    if (p.endsWith(`/tables/${rid}`)) return send(tableState);
    if (p.endsWith('/tables')) return send({ tables: [tableState], total: 1, nextCursor: null });
    if (p.endsWith('/agents/sharing-candidates'))
      return send({
        membershipId: mid,
        people: [{ membershipId: mid, userId: 'ada', name: 'Ada', email: 'ada@example.com' }],
        teams: teams.map(({ id, name }) => ({ id, name })),
      });
    if (p.endsWith('/agents/authoring-context'))
      return send({ currentSoulRevision: 'a'.repeat(40), teams, admin: true });
    if (p.endsWith('/agents')) return send({ agents: [agent], count: 1, nextCursor: null });
    if (p.endsWith(`/agents/${aid}`)) return send(agent);
    if (p.endsWith('/policy'))
      return send({
        version: 1,
        owningTeamId: tid,
        grants: [],
        personGrants: [],
        enrollment: [tid],
        enabled: true,
        limits: agent.activations[0].scope,
      });
    if (p.endsWith('/schedules')) return send([]);
    if (p.endsWith('/chat')) return send({ configured: true });
    if (p.endsWith('/skills')) return send({ workspace: [], nextCursor: null });
    if (p.endsWith('/agent-tasks')) return send({ tasks: [], nextCursor: null });
    if (p.endsWith('/conversations')) return send({ chats: [], nextCursor: null });
    if (p.endsWith('/projects')) return send([]);
    if (p.endsWith('/integrations/creation-context'))
      return send({ teams: teams.map(({ id, name }) => ({ id, name })) });
    if (p.endsWith('/integrations')) return send({ integrations: [] });
    if (p.endsWith('/google-workspace/availability')) return send({ configured: false });
    if (p.endsWith('/google-workspace')) return send({ status: 'disconnected' });
    if (p.endsWith('/google-workspace/operations/proposals')) return send({ proposals: [], nextCursor: null });
    if (p.endsWith('/workflows')) return send(url.searchParams.get('archived') === 'true' ? [] : [workflow]);
    if (p.endsWith(`/workflows/${workflow.id}`))
      return state.workflowStatus !== 200
        ? send({ error: 'workflow-unavailable' }, state.workflowStatus)
        : send({
            workflowId: workflow.id,
            revision: workflow.revision,
            savedRevision: workflow.revision,
            activeRevision: null,
            definition: workflow.definition,
            actor: null,
            canManage: true,
            archived: false,
          });
    if (p.endsWith(`/workflows/${workflow.id}/runs`)) return send({ runs: [], nextCursor: null });
    if (p.endsWith('/provider-integrations')) return send([integration]);
    return send({ error: 'fixture-unavailable' }, 404);
  };
}

let server, browser;
before(async () => {
  server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  for (
    let i = 0;
    !(await fetch(origin).then(
      r => r.ok,
      () => false,
    ));
    i++
  ) {
    if (i > 300) throw Error('Vite did not start');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
});

async function open(path) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    timezoneId: 'Europe/Berlin',
    locale: 'en-US',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const state = { writes: [], workflowStatus: 200 };
  await page.route('**/v1/**', fixture(state));
  await page.goto(origin + path);
  return { page, errors, state, close: () => context.close() };
}

// Records the screen even when an assertion fails, so a baseline run still produces its "before" evidence.
async function evidence(page, name, check) {
  try {
    await check();
  } finally {
    if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }).catch(() => {});
  }
}

const choose = async (page, label, option) => {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
};

test('new agents start from suggested read actions, and other actions wait inside their app', async () => {
  const { page, errors, close } = await open('/acme/agents/new');
  const actions = page.getByRole('region', { name: 'Permitted actions', exact: true });
  await evidence(page, 'a03-agent-tool-picker', async () => {
    await actions.getByRole('heading', { name: 'Suggested start: read tables', exact: true }).waitFor();
    await actions.getByRole('button', { name: 'Add 5 suggested read actions', exact: true }).click();
    await actions.getByRole('button', { name: 'Suggested actions added', exact: true }).waitFor();
    const tables = actions.getByRole('region', { name: 'Tables actions', exact: true });
    await tables.getByText('5 of 11 selected', { exact: true }).waitFor();
    assert.equal(
      await tables.getByRole('checkbox', { name: 'Find rows', exact: true }).getAttribute('aria-checked'),
      'true',
    );
    assert.equal(
      await tables.getByRole('checkbox', { name: 'Update rows', exact: true }).getAttribute('aria-checked'),
      'false',
      'suggestions never change data',
    );
    const slack = actions.getByRole('region', { name: 'Slack actions', exact: true });
    await slack.getByText('3 available', { exact: true }).waitFor();
    assert.equal(
      await slack.getByRole('button').first().getAttribute('aria-expanded'),
      'false',
      'apps the agent does not use stay closed',
    );
    await actions.getByText('5 selected', { exact: true }).waitFor();
  });
  assert.deepEqual(errors, []);
  await close();
});

for (const [name, path, title] of [
  ['new', '/acme/agents/new', 'New agent'],
  ['saved', `/acme/agents/${aid}`, agent.name],
]) {
  test(`the workspace header keeps "${title}" readable beside its back link and status from 320px to desktop`, async () => {
    const { page, errors, close } = await open(path);
    const header = page.locator('header[aria-label="Workspace header"]');
    const heading = header.getByRole('heading', { level: 1, name: title, exact: true });
    const back = header.getByRole('link', { name: 'Back to agents', exact: true });
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await evidence(page, `a19-header-${name}-${width}`, async () => {
        await heading.waitFor();
        if (name === 'saved') await header.getByText('Active', { exact: true }).waitFor();
        const shown = await heading.evaluate(element => ({ visible: element.clientWidth, full: element.scrollWidth }));
        assert.ok(
          shown.visible >= Math.min(shown.full, 112),
          `${width}px shows ${shown.visible} of ${shown.full}px of the page title`,
        );
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${width}px has no horizontal page scroll`,
        );
        if (width >= 375 && width < 768)
          assert.ok(
            await header.getByText(workspace.name, { exact: true }).isVisible(),
            `${width}px still names the workspace on mobile`,
          );
        for (const element of await header.locator('a, button, h1, [data-slot="badge"]').all()) {
          if (!(await element.isVisible())) continue;
          const box = await element.boundingBox();
          assert.ok(
            box.x >= 0 && box.x + box.width <= width,
            `${width}px keeps ${await element.evaluate(node => node.outerHTML.slice(0, 80))} inside the header`,
          );
        }
        await header.locator('[data-slot="sidebar-trigger"]').focus();
        await page.keyboard.press('Tab');
        assert.ok(
          await back.evaluate(element => element === document.activeElement),
          `${width}px reaches the back link by keyboard`,
        );
      });
    }
    assert.deepEqual(errors, []);
    await close();
  });
}

test('calendar schedules use days, a time, and a named zone, show the next runs, and keep prompts hourly', async () => {
  const { page, errors, close } = await open(`/acme/agents/${aid}?tab=schedules`);
  const schedules = page.getByRole('region', { name: 'Agent schedules', exact: true });
  await evidence(page, 'a12-calendar-schedule', async () => {
    await schedules.getByRole('button', { name: 'Calendar schedule', exact: true }).click();
    await choose(page, 'Days', 'Monday');
    await schedules.getByLabel('Time', { exact: true }).fill('09:00');
    await choose(page, 'Time zone', 'America/New York');
    await schedules.getByText('Every Monday at 09:00 in America/New York. Next runs:', { exact: true }).waitFor();
    const runs = schedules.getByRole('list', { name: 'Next scheduled runs', exact: true }).getByRole('listitem');
    assert.ok((await runs.count()) >= 3);
    for (const run of await runs.all()) assert.match(await run.textContent(), /^Mon/);
  });
  await schedules.getByRole('button', { name: 'Advanced schedule', exact: true }).click();
  const cron = schedules.getByLabel('Cron expression', { exact: true });
  assert.equal(await cron.inputValue(), '0 9 * * 1');
  await cron.fill('*/5 * * * *');
  await schedules.getByLabel('Prompt', { exact: true }).fill('Summarize overdue invoices.');
  await schedules.getByRole('button', { name: 'Create prompt schedule', exact: true }).click();
  await schedules
    .getByText('Prompt schedules run at most once an hour. Choose runs at least an hour apart.', { exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  await close();
});

test('help explains who manages agents, the path from a chat draft to the first run, earlier steps, and visibility', async () => {
  const { page, errors, close } = await open('/acme/help');
  await evidence(page, 'a14-help-topics', async () => {
    await page.getByText(/called an agent manager, turns on execution/).waitFor();
    for (const heading of [
      'From a chat draft to the first run',
      'Using earlier steps in a workflow',
      'Who can see an agent or a file',
    ])
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    assert.equal(
      await page.getByRole('link', { name: 'Open workflows', exact: true }).getAttribute('href'),
      '/acme/workflows',
    );
  });
  await page.getByText(/separate nested names with \/, such as contract \/ start_date/).waitFor();
  await page.getByText(/visible to everyone in that project\. Being a workspace admin does not add access\./).waitFor();
  assert.deepEqual(errors, []);
  await close();
});

test('workflow inspectors explain conditions and credentials without editing, and recover failed or denied reads', async () => {
  const { page, errors, state, close } = await open(`/acme/workflows?workflow=${workflow.id}`);
  const viewer = page.getByRole('region', { name: 'Order review workflow', exact: true });
  await viewer.getByRole('figure', { name: 'Read-only workflow diagram', exact: true }).waitFor();
  await evidence(page, 'a04-workflow-condition-inspector', async () => {
    const condition = await assertConfiguration(viewer, 2, workflow.definition.steps[1]);
    await condition.getByText(/run input total is greater than 100/).waitFor();
    const branch = await assertConfiguration(viewer, 3, workflow.definition.steps[2]);
    await branch.getByRole('heading', { name: 'Runs only when', exact: true }).waitFor();
    await branch.getByText('Yes', { exact: true }).waitFor();
  });
  await evidence(page, 'a04-http-credential', async () => {
    const request = await assertConfiguration(viewer, 4, workflow.definition.steps[3]);
    await request.getByText('https://example.com/orders', { exact: true }).waitFor();
    await request.getByRole('button', { name: 'Prepare data', exact: true }).click();
    await viewer
      .getByRole('region', { name: 'Step details', exact: true })
      .getByRole('heading', { name: 'Prepare data', exact: true })
      .waitFor();
  });
  assert.equal(
    await page.getByRole('button', { name: /^(Move step|Remove step|Save revision|Add HTTP request)/ }).count(),
    0,
  );
  assert.equal(await page.getByLabel('Workflow definition JSON', { exact: true }).count(), 0);
  await viewer.getByRole('button', { name: 'Edit in chat', exact: true }).waitFor();
  state.workflowStatus = 503;
  await viewer.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  await viewer
    .getByText('Refresh failed. This is the last checked view, not the latest state.', { exact: false })
    .waitFor();
  await assertConfiguration(viewer, 2, workflow.definition.steps[1]);
  state.workflowStatus = 403;
  await viewer.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
  await page.getByRole('heading', { name: 'Workflow unavailable', exact: true }).waitFor();
  assert.equal(await viewer.count(), 0);
  state.workflowStatus = 200;
  await page.getByRole('button', { name: 'Retry loading workflow', exact: true }).click();
  await assertConfiguration(viewer, 2, workflow.definition.steps[1]);
  assert.deepEqual(state.writes, [], 'inspecting and refreshing never writes a definition');
  assert.deepEqual(errors, []);
  await close();
});
