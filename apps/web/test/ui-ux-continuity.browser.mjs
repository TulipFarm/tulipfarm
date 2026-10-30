import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { showWorkflowList } from './workflow-definition.fixture.mjs';

const port = 5463,
  origin = `http://127.0.0.1:${port}`;
const shots = process.env.UI_CONTINUITY_SCREENSHOTS;
const cdpPort = process.env.UI_CONTINUITY_CDP_PORT;
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
const [wid, mid, tid, aid, rid, sid, runId, activationId] = Array.from({ length: 8 }, (_, i) => id(i + 1));
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
    pricingRevision: 'pricing-1',
    fallbackFor: [],
  },
];
const field = {
  id: sid,
  label: 'Customer name',
  kind: 'text',
  required: true,
  maxLength: 120,
  unique: false,
  columnName: `f_${sid.replaceAll('-', '')}`,
};
const definition = {
  formatVersion: 2,
  id: rid,
  owningTeamId: tid,
  label: 'Customers',
  revision: 'a'.repeat(40),
  tableName: `r_${rid.replaceAll('-', '')}`,
  fields: [field],
  uniqueKeys: [],
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
const workflow = {
  id: id('a'),
  revision: id('b'),
  activeRevision: null,
  enabled: false,
  generation: 1,
  capabilities: { read: true, invoke: true, manage: true },
  nextRunAt: null,
  activeTrigger: null,
  webhookConfigured: false,
  definition: {
    version: 1,
    name: 'Customer review',
    trigger: { kind: 'manual' },
    steps: [{ id: 'review', kind: 'human', prompt: 'Review the customer request.', timeoutSeconds: 86400 }],
  },
};
const invoices = { ...workflow, id: id('d'), definition: { ...workflow.definition, name: 'Invoice check' } };
const run = {
  id: runId,
  workflowId: workflow.id,
  revision: workflow.revision,
  status: 'completed',
  source: 'manual',
  input: {},
  createdAt: at,
  startedAt: at,
  finishedAt: at,
  error: null,
  steps: [],
};

function fixture(state) {
  return async route => {
    const request = route.request(),
      url = new URL(request.url()),
      p = url.pathname;
    const send = (json, status = 200) => route.fulfill({ status, json });
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
    if (p.endsWith(`/tables/${rid}`)) {
      state.tableReads = (state.tableReads ?? 0) + 1;
      await state.tableHold;
      if (state.tableRead === 'network') return route.abort('failed');
      return state.tableRead
        ? send({ error: state.tableRead === 403 ? 'forbidden' : 'unavailable' }, state.tableRead)
        : send(tableState);
    }
    if (p.endsWith('/tables')) return send({ tables: [], total: 0, nextCursor: null });
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
    if (p.endsWith('/workflows')) {
      if (state.workflowReadError) return send({ error: 'unavailable' }, state.workflowReadError);
      return send(
        url.searchParams.get('archived') === 'true'
          ? (state.archived ?? [])
          : (state.workflows ?? [workflow, invoices]),
      );
    }
    const detail = /\/workflows\/([\w-]+)$/.exec(p);
    if (detail && request.method() === 'GET') {
      await state.workflowDetailHold;
      if (state.workflowDetailError) return send({ error: 'unavailable' }, state.workflowDetailError);
      const current = [...(state.workflows ?? [workflow, invoices]), ...(state.archived ?? [])].find(
        item => item.id === detail[1],
      );
      if (!current) return send({ error: 'not-found' }, 404);
      const active = url.searchParams.get('revision') === 'active';
      return send({
        workflowId: current.id,
        revision: active ? current.activeRevision : current.revision,
        savedRevision: current.revision,
        activeRevision: current.activeRevision,
        definition: active ? (state.activeDefinition ?? current.definition) : current.definition,
        actor: { id: mid, userId: 'ada', name: 'Ada' },
        canManage: current.capabilities.manage,
        archived: !!current.archivedAt,
      });
    }
    if (p.endsWith(`/workflows/${workflow.id}/runs/${runId}`))
      return send({
        run,
        definition: workflow.definition,
        actor: { id: mid, userId: 'ada', name: 'Ada' },
        canManage: true,
      });
    if (state.workflows && p.endsWith(`/workflows/${workflow.id}`) && request.method() === 'PUT') {
      const body = request.postDataJSON();
      state.saves.push(body);
      if (state.saveDenied) return send({ error: 'forbidden' }, 403);
      if (body.expectedRevision !== state.workflows[0].revision) return send({ error: 'conflict' }, 409);
      state.workflows[0] = { ...state.workflows[0], revision: body.revision, definition: body.definition };
      return send(state.workflows[0]);
    }
    if (state.workflows && p.endsWith(`/workflows/${workflow.id}/activation`)) {
      state.workflows[0] = {
        ...state.workflows[0],
        enabled: true,
        activeRevision: state.workflows[0].revision,
        activeTrigger: state.workflows[0].definition.trigger,
      };
      return send(state.workflows[0]);
    }
    if (state.workflows && p.endsWith(`/workflows/${workflow.id}/archive`)) {
      state.archived = [{ ...state.workflows[0], archivedAt: at }];
      state.workflows = state.workflows.slice(1);
      return send(state.archived[0]);
    }
    if (p.endsWith(`/workflows/${invoices.id}/runs`)) return send({ runs: [], nextCursor: null });
    if (p.endsWith(`/workflows/${workflow.id}/runs`)) return send({ runs: [run], nextCursor: null });
    if (p.endsWith('/provider-integrations')) return send([]);
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
  browser = await chromium.launch({ headless: true, args: cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [] });
});
after(async () => {
  try {
    if (cdpPort) execFileSync('agent-browser', ['--session', 'workflow-edit-session', 'close']);
  } finally {
    try {
      await browser?.close();
    } finally {
      server?.kill('SIGTERM');
    }
  }
});

async function open(path, state = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/v1/**', fixture(state));
  await page.goto(origin + path);
  return { page, errors, close: () => context.close() };
}

// Records the screen even when an assertion fails, so a baseline run still produces its "before" evidence.
async function evidence(page, name, check) {
  try {
    await check();
  } finally {
    if (shots) {
      await page.screenshot({ path: `${shots}/${name}.png` });
      if (cdpPort)
        execFileSync(
          'agent-browser',
          ['--session', 'workflow-edit-session', '--cdp', cdpPort, 'screenshot', `${shots}/${name}-agent-browser.png`],
          { stdio: 'inherit' },
        );
    }
  }
}

const composerText = page =>
  page.evaluate(() => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent ?? '');
const waitForPrompt = (page, start) =>
  page.waitForFunction(
    text => document.querySelector('[role="textbox"][aria-label="Message"]')?.textContent?.startsWith(text),
    start,
  );

test('table chat handoffs name the table and its current revision instead of a raw ID to copy', async () => {
  const { page, errors, close } = await open(`/acme?intent=edit-table&tableId=${rid}`);
  await evidence(page, 'a02-edit-table-handoff', async () => {
    await waitForPrompt(page, 'Help me change the fields of');
    assert.equal(
      await composerText(page),
      `Help me change the fields of the “Customers” table (table ID ${rid}, current revision ${definition.revision}). Read its current fields first, ask what I want to change, then propose the schema change for my review.`,
    );
  });
  await page.waitForURL(`${origin}/acme`);
  assert.deepEqual(errors, []);
  await close();

  const rows = await open(`/acme?intent=add-rows&tableId=${rid}`);
  await waitForPrompt(rows.page, 'Help me add rows to');
  assert.equal(
    await composerText(rows.page),
    `Help me add rows to the “Customers” table (table ID ${rid}, current revision ${definition.revision}). Read its current fields first, ask which rows I want to add, then prepare them for my review.`,
  );
  assert.deepEqual(rows.errors, []);
  await rows.close();
});

test('a table handoff whose table read fails says so, keeps the request, and recovers', async () => {
  const state = { tableRead: 503 };
  const { page, errors, close } = await open(`/acme?intent=edit-table&tableId=${rid}`, state);
  const failure = page.getByRole('alert').filter({ hasText: 'Table details didn’t load' });
  const reload = page.getByRole('button', { name: /^(Load table details again|Loading table details…)$/ });
  await evidence(page, 'b2-table-handoff-failed', async () => {
    await failure.waitFor();
    assert.equal(
      await failure.innerText(),
      'Table details didn’t load\nYour request to change this table’s fields is kept. Load the details again, or continue and the message will name the table only by its ID.',
    );
    assert.equal(await composerText(page), '', 'no prompt is written as if the handoff succeeded');
    assert.match(page.url(), /intent=edit-table/, 'the request stays in the link until it is handed off');
  });
  let release;
  state.tableHold = new Promise(resolve => {
    release = resolve;
  });
  await reload.click();
  await page.waitForFunction(
    () => document.querySelector('[aria-busy="true"]')?.textContent === 'Loading table details…',
  );
  assert.equal(await reload.isDisabled(), true, 'a retry in flight cannot be sent twice');
  release();
  state.tableHold = undefined;
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      button => button.textContent === 'Load table details again' && !button.disabled,
    ),
  );
  await failure.waitFor();
  assert.equal(await composerText(page), '', 'a failed retry returns to the same actionable error');

  state.tableRead = undefined;
  await reload.click();
  await evidence(page, 'b2-table-handoff-recovered', async () => {
    await waitForPrompt(page, 'Help me change the fields of the “Customers” table');
    await page.waitForURL(`${origin}/acme`);
    assert.equal(await failure.count(), 0);
  });
  assert.equal(state.tableReads, 3);
  assert.deepEqual(errors, []);
  await close();

  const offline = { tableRead: 'network' };
  const network = await open(`/acme?intent=add-rows&tableId=${rid}`, offline);
  await network.page
    .getByRole('alert')
    .filter({ hasText: 'Your request to add rows to this table is kept.' })
    .waitFor();
  await network.page.getByRole('textbox', { name: 'Message', exact: true }).fill('Start with the March orders.');
  await network.page.getByRole('button', { name: 'Continue without table details', exact: true }).click();
  await waitForPrompt(network.page, 'Help me add rows to this table');
  assert.equal(
    await composerText(network.page),
    `Help me add rows to this table (table ID ${rid}). Read its current fields first, ask which rows I want to add, then prepare them for my review.Start with the March orders.`,
    'text typed while the notice waited stays after the request',
  );
  await network.page.waitForURL(`${origin}/acme`);
  assert.equal(
    await network.page.getByRole('alertdialog').count(),
    0,
    'handing off the request is not leaving the draft',
  );
  assert.equal(await network.page.getByRole('alert').filter({ hasText: 'Table details didn’t load' }).count(), 0);
  assert.deepEqual(network.errors, []);
  await network.close();

  const denied = await open(`/acme?intent=edit-table&tableId=${rid}`, { tableRead: 403 });
  const unavailable = denied.page.getByRole('alert').filter({ hasText: 'This table is unavailable' });
  await evidence(denied.page, 'b2-table-handoff-denied', async () => {
    await unavailable.waitFor();
    assert.equal(
      await unavailable.innerText(),
      'This table is unavailable\nIt was deleted, or your access to it changed. A workspace admin can review your access.',
    );
    assert.equal(
      await denied.page.getByRole('link', { name: 'Open tables', exact: true }).getAttribute('href'),
      '/acme/tables',
    );
    assert.equal(
      await denied.page.getByRole('button', { name: 'Continue without table details' }).count(),
      0,
      'a denied table is not handed to the agent',
    );
    assert.equal(await denied.page.getByRole('button', { name: 'Load table details again' }).count(), 0);
    assert.equal(await composerText(denied.page), '');
  });
  assert.deepEqual(denied.errors, []);
  await denied.close();
});

test('a table handoff retry that never gets an answer stops waiting and offers the same choices', async () => {
  const state = { tableRead: 503 };
  const { page, errors, close } = await open(`/acme?intent=edit-table&tableId=${rid}`, state);
  await page.getByRole('alert').filter({ hasText: 'Table details didn’t load' }).waitFor();
  state.tableHold = new Promise(() => {});
  await page.getByRole('button', { name: 'Load table details again', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-busy="true"]')?.textContent === 'Loading table details…',
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button')].some(
        button => button.textContent === 'Load table details again' && !button.disabled,
      ),
    null,
    { timeout: 25000 },
  );
  assert.equal(
    await page.getByRole('button', { name: 'Continue without table details', exact: true }).isDisabled(),
    false,
  );
  assert.equal(await composerText(page), '');
  assert.match(page.url(), /intent=edit-table/);
  assert.deepEqual(errors, []);
  await close();
});

test('the agent tab lives in the URL, survives reload, and keeps unsaved edits without a leave prompt', async () => {
  const { page, errors, close } = await open(`/acme/agents/${aid}?tab=execution`);
  const tab = name => page.getByRole('tab', { name, exact: true });
  await evidence(page, 'a09-agent-tab-link', async () => {
    await page.waitForFunction(() =>
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes('Execution'),
    );
  });
  await tab('Instructions').click();
  await page.waitForURL(/[?&]tab=instructions/);
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes('Instructions'),
  );
  const instructions = page.getByRole('textbox', { name: 'Instructions' });
  await instructions.fill('Draft follow-ups for approval.');
  await tab('Access').click();
  await page.waitForURL(/[?&]tab=access/);
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'switching tabs is not leaving the page');
  await tab('Instructions').click();
  assert.equal(await instructions.inputValue(), 'Draft follow-ups for approval.');
  await tab('Overview').click();
  await page.waitForURL(url => !url.search.includes('tab='));
  const prompt = page.getByLabel('What should this agent do?', { exact: true });
  await prompt.fill('Check new rows.');
  await tab('Instructions').click();
  await page.waitForURL(/[?&]tab=instructions/);
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'an unsent task prompt stays mounted across tabs');
  await tab('Overview').click();
  assert.equal(await prompt.inputValue(), 'Check new rows.');
  await page.goto(`${origin}/acme/agents/${aid}?tab=bogus`);
  await page.waitForFunction(() =>
    document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes('Overview'),
  );
  assert.deepEqual(errors, []);
  await close();
});

test('new workflow request survives composer initialization without sending', async () => {
  const { page, errors, close } = await open('/acme/workflows');
  try {
    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    await waitForPrompt(page, 'Help me create a workflow.');
    await page.waitForURL(url => !url.searchParams.has('intent'));
    assert.match(await composerText(page), /without saving or activating it/);
    assert.equal(await page.getByRole('button', { name: 'Stop reply', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('workflow saved and active diagrams stay exact, refresh independently, and edit only in chat', async () => {
  const state = {
    workflows: [{ ...structuredClone(workflow), enabled: true, activeRevision: id('e') }],
    activeDefinition: { ...workflow.definition, name: 'Active customer review' },
    saves: [],
  };
  const { page, errors, close } = await open(`/acme/workflows?workflow=${workflow.id}`, state);
  try {
    await page.getByRole('heading', { name: 'Customer review', exact: true }).first().waitFor();
    assert.equal(await page.getByLabel('Name', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Workflow definition JSON').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Save revision', exact: true }).count(), 0);
    const revisions = page.getByRole('group', { name: 'Displayed revision', exact: true });
    await revisions.getByRole('button', { name: 'Active', exact: true }).click();
    await page.getByRole('region', { name: 'Active customer review workflow', exact: true }).waitFor();
    await revisions.getByRole('button', { name: 'Saved', exact: true }).click();
    await page.getByRole('region', { name: 'Customer review workflow', exact: true }).waitFor();
    state.workflows[0] = {
      ...state.workflows[0],
      revision: id('f'),
      definition: { ...workflow.definition, name: 'Fresh customer review' },
    };
    await page.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
    await page.getByRole('region', { name: 'Fresh customer review workflow', exact: true }).waitFor();
    assert.deepEqual(state.saves, []);
    await page.getByRole('button', { name: 'Edit in chat', exact: true }).click();
    await waitForPrompt(page, 'Help me edit workflow "Fresh customer review"');
    assert.match(await composerText(page), new RegExp(id('f')));
    await page.getByRole('region', { name: 'Fresh customer review workflow', exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('workflow read recovery, access loss and archive keep their existing screen resets', async () => {
  const state = { workflows: [structuredClone(workflow)], saves: [], workflowReadError: 503 };
  const { page, errors, close } = await open('/acme/workflows', state);
  try {
    await page.getByRole('heading', { name: 'Workflows could not load' }).waitFor();
    state.workflowReadError = undefined;
    await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
    await page.getByRole('link', { name: 'Customer review', exact: true }).click();
    await page.getByRole('heading', { name: 'Customer review', exact: true }).first().waitFor();
    state.workflowReadError = 503;
    await page.getByRole('button', { name: 'Refresh workflows', exact: true }).click();
    await page.getByText('Refresh failed. These are your last checked workflows.', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Customer review', exact: true }).first().waitFor();
    state.workflowReadError = 403;
    await page.getByRole('button', { name: 'Refresh workflows', exact: true }).click();
    await page.getByRole('heading', { name: 'Workflow access unavailable' }).waitFor();
    assert.equal(await page.getByLabel('Name', { exact: true }).count(), 0);
    state.workflowReadError = undefined;
    await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
    await showWorkflowList(page);
    await page.getByRole('link', { name: 'Customer review', exact: true }).click();
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Archive workflow', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archive workflow', exact: true }).click();
    await page.getByRole('heading', { name: 'No workflows yet', exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement === document.querySelector('#workflow-views button'));
    await page.getByRole('button', { name: /^Archived( \d+)?$/ }).click();
    await page.getByRole('link', { name: 'Customer review', exact: true }).click();
    await page.getByText(/Its run history is read-only/).waitFor();
    await page.getByRole('region', { name: 'Run history' }).waitFor();
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await page.getByRole('heading', { name: 'Customer review', exact: true }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Edit in chat', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('a workflow run link reopens the workflow run history at that run, and unknown links explain themselves', async () => {
  const { page, errors, close } = await open(`/acme/workflows?workflow=${workflow.id}&view=runs&run=${runId}`);
  await evidence(page, 'a09-workflow-run-link', async () => {
    await page.getByRole('region', { name: 'Run history' }).waitFor();
    await page.getByRole('region', { name: 'Selected run diagram', exact: true }).waitFor();
  });
  await page.locator(`#workflow-run-${runId}`).getByText('0 workflow steps', { exact: true }).click();
  const runLink = page.getByRole('link', { name: `Run ${runId}`, exact: true });
  assert.equal(await runLink.getAttribute('href'), `/acme/workflows/${workflow.id}?view=runs&run=${runId}`);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.waitForURL(url => url.pathname === `/acme/workflows/${workflow.id}` && !url.searchParams.has('view'));
  await page.getByRole('heading', { name: 'Customer review', exact: true }).first().waitFor();
  await page.getByRole('tab', { name: 'Runs', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('view') === 'runs');
  assert.equal(await page.getByRole('alertdialog').count(), 0, 'read-only view changes need no leave prompt');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('heading', { name: 'Customer review', exact: true }).first().waitFor();
  await evidence(page, 'workflow-definition', async () => {});
  assert.deepEqual(errors, []);
  await close();

  const history = await open(`/acme/workflows?workflow=${workflow.id}`);
  const shows = value => history.page.getByRole('heading', { name: value, exact: true }).first().waitFor();
  await shows('Customer review');
  await history.page.getByRole('link', { name: 'Workflows', exact: true }).first().click();
  await history.page.getByRole('link', { name: 'Invoice check', exact: true }).click();
  await history.page.waitForURL(url => url.pathname === `/acme/workflows/${invoices.id}`);
  await shows('Invoice check');
  await history.page.goBack();
  await history.page.waitForURL(url => url.pathname === `/acme/workflows/${workflow.id}`);
  await shows('Customer review');
  await history.page.goForward();
  await history.page.waitForURL(url => url.pathname === `/acme/workflows/${invoices.id}`);
  await shows('Invoice check');
  assert.deepEqual(history.errors, []);
  await history.close();

  const missing = await open(`/acme/workflows?workflow=${id('c')}&view=runs`);
  await evidence(missing.page, 'a09-workflow-link-missing', async () => {
    await missing.page
      .getByText(
        'The linked workflow is not available to you. It isn’t shared with you, or it belongs to another workspace.',
        { exact: true },
      )
      .waitFor();
  });
  assert.deepEqual(missing.errors, []);
  await missing.close();
});
