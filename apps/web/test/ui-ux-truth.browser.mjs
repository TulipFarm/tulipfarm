import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { libraryItem } from './files-library.fixture.mjs';

const port = 5462,
  origin = `http://127.0.0.1:${port}`;
const shots = process.env.UI_TRUTH_SCREENSHOTS;
const cdpPort = process.env.UI_TRUTH_CDP_PORT;
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
const [wid, mid, tid, aid, rid, fid, taskId, cid, activationId] = Array.from({ length: 9 }, (_, i) => id(i + 1));
const at = '2026-09-30T09:00:00Z';
const workspace = {
  id: wid,
  slug: 'acme',
  name: 'Acme Operations',
  status: 'ready',
  createdAt: at,
  soulCommit: 'a'.repeat(40),
};
const teams = [
  {
    id: tid,
    name: 'Customer Operations',
    description: 'Customer support',
    membershipIds: [mid],
    managerIds: [mid],
    canManage: true,
    canLeave: true,
  },
];
const members = [
  { id: mid, userId: 'ada', name: 'Ada', email: 'ada@example.com', role: 'admin' },
  { id: id('a'), userId: 'ben', name: 'Ben', email: 'ben@example.com', role: 'member' },
];
const chat = {
  id: cid,
  title: 'Plan customer follow-ups',
  titleRevision: 0,
  archived: false,
  activityAt: at,
  createdAt: at,
};
const scope = [{ assetId: rid, permissions: ['table.row.read', 'table.row.update'] }];
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
  capabilities: ['read', 'edit', 'invoke', 'delete'],
  admin: true,
  activations: [{ id: activationId, revision: 'b'.repeat(64), scope }],
};
const task = {
  id: taskId,
  generation: 1,
  status: 'paused',
  parentTaskId: null,
  delegationDepth: 0,
  agentId: aid,
  activationId,
  definitionRevision: 'b'.repeat(64),
  skills: [],
  scope,
  limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
  flowId: cid,
  activeMilliseconds: '18000',
  toolCalls: 3,
  createdAt: at,
  cost: { chargedCreditUnits: '2500000000000', heldCreditUnits: '0' },
};
const notes = libraryItem({
  id: fid,
  kind: 'file',
  name: 'Pricing notes.md',
  creatorMembershipId: mid,
  mediaType: 'text/markdown',
  size: 2048,
});

function fixture(state) {
  return async route => {
    const request = route.request(),
      url = new URL(request.url()),
      p = url.pathname,
      method = request.method();
    const send = async (json, status = 200) => {
      await route.fulfill({ status, json });
      return true;
    };
    const handled = await state.override?.({ p, method, request, route, send });
    if (handled !== undefined) return handled;
    if (p === '/v1/auth/get-session')
      return send(
        state.signedOut
          ? null
          : { session: { id: 'fixture', userId: 'ada' }, user: { id: 'ada', name: 'Ada', email: 'ada@example.com' } },
      );
    if (p === '/v1/auth/options') return send({ turnstileSiteKey: null, google: true, magicLink: true });
    if (p === '/v1/user/visit') return send({ firstSession: false });
    if (p === '/v1/workspaces') return send([workspace]);
    if (p === '/v1/workspaces/acme') return send(workspace);
    if (p.endsWith('/settings'))
      return send({ workspaceId: wid, name: workspace.name, slug: 'acme', revision: 1, canManage: true });
    if (p.endsWith('/personal-memory')) return send({ content: '', revision: 1 });
    if (p.endsWith('/credits'))
      return send({ available: 100, granted: 100, used: 0, held: 0, days: [], breakdown: [], series: [] });
    if (p.endsWith('/governance/me'))
      return send({
        membershipId: mid,
        role: 'admin',
        teams: state.teams ?? teams,
        capabilities: { manageGovernance: true, canLeave: true },
      });
    if (p.endsWith('/governance/person-grants')) return send({ grants: [] });
    if (p.endsWith('/governance/invitations')) return send({ items: [], nextCursor: null });
    if (p.endsWith('/governance'))
      return send({
        actorMembershipId: mid,
        members,
        teams: state.teams ?? teams,
        directory: [],
        tableTeamIds: (state.teams ?? teams).map(team => team.id),
        tables: [{ id: rid, name: 'Customers', owningTeamId: tid }],
        grants: [],
      });
    if (p.endsWith('/model-catalog')) return send({ families: [] });
    if (p.endsWith('/model-policy/availability')) return send({ items: [] });
    if (p.endsWith('/agents/authoring-context'))
      return send({ currentSoulRevision: 'a'.repeat(40), teams, admin: true });
    if (p.endsWith('/agents')) return send({ agents: [agent], count: 1, nextCursor: null });
    if (p.endsWith(`/agents/${aid}`)) return send(agent);
    if (p.endsWith('/policy'))
      return send({ version: 1, owningTeamId: tid, grants: [], enrollment: [tid], enabled: true, limits: scope });
    if (p.endsWith('/schedules')) return send([]);
    if (p.includes('/agent-tasks/') && p.endsWith('/history'))
      return send({
        messages: [
          {
            sequence: 0,
            generation: 1,
            role: 'owner',
            text: 'Review customers needing follow-up this week.',
            sources: [],
            createdAt: at,
          },
          {
            sequence: 1,
            generation: 1,
            role: 'agent',
            text: 'Northwind Traders needs a follow-up.',
            sources: [],
            createdAt: at,
          },
        ],
        nextCursor: null,
      });
    if (p.includes('/agent-tasks/') && p.endsWith('/proposals')) return send({ proposals: [], nextCursor: null });
    if (p.endsWith(`/agent-tasks/${taskId}`)) return send(state.task ?? task);
    if (p.endsWith('/agent-tasks')) return send({ tasks: [state.task ?? task], nextCursor: null });
    if (p.includes('/github/tasks/') && p.endsWith('/selection'))
      return send({ accountId: null, generation: null, version: 0 });
    if (p.endsWith('/github/accounts')) return send({ configured: true, accounts: [] });
    if (p.endsWith('/tables')) return send({ tables: [], total: 0, nextCursor: null });
    if (p.endsWith('/skills')) return send({ workspace: [], nextCursor: null });
    if (p.endsWith('/conversations')) return send({ chats: [state.chat ?? chat], nextCursor: null });
    if (p.endsWith(`/conversations/${cid}`)) return send(state.chat ?? chat);
    if (p.endsWith('/messages')) return send({ messages: [], nextBefore: null });
    if (p.endsWith('/chat')) return send({ configured: true });
    if (p.endsWith('/projects')) return send([]);
    if (p.endsWith('/files/usage')) return send({ usedBytes: 8192, quotaBytes: 1073741824, maxFileBytes: 10485760 });
    if (p.endsWith('/files/library')) return send({ items: [notes], next: null, breadcrumbs: [], owners: [] });
    if (p.endsWith('/integrations/creation-context'))
      return send({ teams: teams.map(({ id, name }) => ({ id, name })) });
    if (p.endsWith('/integrations')) return send({ integrations: [] });
    if (p.endsWith('/google-workspace/availability')) return send({ configured: false });
    if (p.endsWith('/google-workspace')) return send({ status: 'disconnected' });
    if (p.endsWith('/google-workspace/operations/proposals')) return send({ proposals: [], nextCursor: null });
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
  browser = await chromium.launch({
    headless: true,
    ...(cdpPort ? { args: [`--remote-debugging-port=${cdpPort}`] } : {}),
  });
});
after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
});

async function open(path, state = {}, { init, clock = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  if (init) await page.addInitScript(init.script, init.arg);
  if (clock) await page.clock.install();
  await page.route('**/v1/**', fixture(state));
  await page.goto(origin + path);
  return { page, errors, close: () => context.close() };
}

// Records the screen even when an assertion fails, so a baseline run still produces its "before" evidence.
async function evidence(page, name, check) {
  try {
    await check();
  } finally {
    if (shots) await page.screenshot({ path: `${shots}/${name}.png` }).catch(() => {});
  }
}

test('the sign-in activity panel is labeled as an example and claims no measured results', async () => {
  const { page, errors, close } = await open('/login', { signedOut: true });
  await evidence(page, 'a01-sign-in-example', async () => {
    const panel = page.locator('aside');
    await panel.getByText('Example', { exact: true }).waitFor();
    const text = await panel.textContent();
    assert.doesNotMatch(text, /\bLive\b/, 'the simulated panel never claims to be live');
    assert.doesNotMatch(
      text,
      /\d[\d,]*\s+(customers|leads)|\d+x faster|all tests pass|test suite|run(ning)? (the )?tests/i,
      'no invented customer counts or performance results',
    );
  });
  assert.deepEqual(errors, []);
  await close();
});

for (const outcome of ['conflict', 'unavailable', 'timeout', 'rejected']) {
  test(`a ${outcome} chat rename keeps the typed title and explains how to recover`, async () => {
    const state = { renames: [] };
    state.override = async ({ p, method, request, route, send }) => {
      if (!(p.endsWith(`/conversations/${cid}`) && method === 'PATCH')) return undefined;
      const body = request.postDataJSON();
      state.renames.push(body);
      if (state.renames.length > 1) {
        state.chat = { ...chat, title: body.title, titleRevision: body.expectedRevision + 1 };
        return send({ titleRevision: body.expectedRevision + 1 });
      }
      if (outcome === 'conflict') {
        state.chat = { ...chat, title: 'Q4 renewal outreach', titleRevision: 1 };
        return send({ error: 'title-conflict' }, 409);
      }
      if (outcome === 'unavailable') return send({ error: 'unavailable' }, 503);
      if (outcome === 'timeout') {
        await route.abort('timedout');
        return true;
      }
      return send({ error: 'invalid-title' }, 400);
    };
    const { page, errors, close } = await open('/acme/chat', state);
    await page.getByRole('button', { name: `More actions for ${chat.title}` }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const input = page.getByRole('textbox', { name: 'Chat title', exact: true });
    await input.fill('Renewal follow-ups');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await evidence(page, `a05-rename-${outcome}`, async () => {
      const message = {
        conflict:
          'Someone else renamed this chat. Your title is kept. Save again to replace the current title, or cancel to keep it.',
        unavailable:
          'The rename was not confirmed. Your title is kept. Save again, or cancel to keep the current title.',
        timeout: 'The rename was not confirmed. Your title is kept. Save again, or cancel to keep the current title.',
        rejected: 'The server rejected this input. Review its length and characters. Your title is kept.',
      }[outcome];
      await page.getByRole('alert').filter({ hasText: message }).waitFor();
      assert.equal(await input.inputValue(), 'Renewal follow-ups', 'the typed title stays in the field');
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.equal(
        await input.evaluate(element => document.getElementById(element.getAttribute('aria-describedby'))?.textContent),
        message,
      );
      if (outcome === 'conflict')
        await page.getByText('Current title: “Q4 renewal outreach”', { exact: true }).waitFor();
    });
    await page.getByRole('button', { name: 'Save again', exact: true }).click();
    await input.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Renewal follow-ups', exact: true }).waitFor();
    assert.equal(state.renames.length, 2);
    assert.equal(state.renames[1].title, 'Renewal follow-ups');
    assert.equal(
      state.renames[1].expectedRevision,
      outcome === 'conflict' ? 1 : 0,
      'saving again after a conflict replaces the title the person was shown',
    );
    if (outcome === 'unavailable' || outcome === 'timeout')
      assert.equal(
        state.renames[1].commandId,
        state.renames[0].commandId,
        'an unconfirmed rename is retried under its own command id',
      );
    else
      assert.notEqual(state.renames[1].commandId, state.renames[0].commandId, 'a confirmed refusal ends that command');
    assert.deepEqual(errors, []);
    await close();
  });
}

// Mirrors the conversation command contract (packages/conversations/src/index.ts command() and rename()):
// a recorded command id replays its first outcome, a reused id with a different body is a command-conflict,
// and a new command applies only at the expected title revision.
function renameServer(state) {
  state.renames = [];
  state.commands = new Map();
  let release = () => {};
  state.list = new Promise(resolve => {
    release = resolve;
  });
  state.releaseList = () => release();
  return async ({ p, method, request, route, send }) => {
    if (p.endsWith('/conversations') && method === 'GET') {
      await state.list;
      return send({ chats: [state.chat ?? chat], nextCursor: null });
    }
    if (!(p.endsWith(`/conversations/${cid}`) && method === 'PATCH')) return undefined;
    const body = request.postDataJSON(),
      digest = JSON.stringify(body);
    state.renames.push(body);
    const prior = state.commands.get(body.commandId);
    if (prior) return prior.digest === digest ? send(prior.outcome) : send({ error: 'command-conflict' }, 409);
    const lose = state.lose?.(state.renames.length);
    if (lose === 'before-commit') {
      await route.abort('timedout');
      return true;
    }
    const current = state.chat ?? chat;
    if (current.titleRevision !== body.expectedRevision) return send({ error: 'title-conflict' }, 409);
    state.chat = { ...current, title: body.title, titleRevision: current.titleRevision + 1 };
    const outcome = { titleRevision: state.chat.titleRevision };
    state.commands.set(body.commandId, { digest, outcome });
    if (lose === 'after-commit') {
      await route.abort('timedout');
      return true;
    }
    return send(outcome);
  };
}

async function renameUnconfirmed(page, title) {
  await page.getByRole('button', { name: `More actions for ${chat.title}` }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const input = page.getByRole('textbox', { name: 'Chat title', exact: true });
  await input.fill(title);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'The rename was not confirmed.' }).waitFor();
  return input;
}

const someoneElse = 'Someone else renamed this chat.';

test('saving again after a rename whose response was lost replays that rename instead of calling it a conflict', async () => {
  const state = { lose: n => (n === 1 ? 'after-commit' : undefined) };
  state.override = renameServer(state);
  state.releaseList();
  const { page, errors, close } = await open('/acme/chat', state);
  await page.getByRole('button', { name: chat.title, exact: true }).waitFor();
  state.list = new Promise(() => {});
  const input = await renameUnconfirmed(page, 'Renewal follow-ups');
  await page.getByRole('button', { name: 'Save again', exact: true }).click();
  await evidence(page, 'a05-rename-lost-response-retried', async () => {
    await input.waitFor({ state: 'detached' });
    assert.equal(
      await page.getByRole('alert').filter({ hasText: someoneElse }).count(),
      0,
      'the person’s own committed rename is never reported as someone else’s',
    );
    assert.equal(state.renames.length, 2);
    assert.deepEqual(state.renames[1], state.renames[0], 'the retry resends the exact unconfirmed command');
    assert.equal(state.chat.titleRevision, 1, 'the retry did not write the title a second time');
  });
  assert.deepEqual(errors, []);
  await close();
});

test('a changed title after an unconfirmed rename is a new rename and a conflict does not blame someone else', async () => {
  const state = { lose: n => (n === 1 ? 'after-commit' : undefined) };
  state.override = renameServer(state);
  state.releaseList();
  const { page, errors, close } = await open('/acme/chat', state);
  await page.getByRole('button', { name: chat.title, exact: true }).waitFor();
  let release = () => {};
  state.list = new Promise(resolve => {
    release = resolve;
  });
  const input = await renameUnconfirmed(page, 'Renewal follow-ups');
  await input.fill('Renewal follow-ups for Q4');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const ambiguous =
    'The title changed after you started editing, possibly by your earlier save. Your title is kept. Save again to replace the current title, or cancel to keep it.';
  await evidence(page, 'a05-rename-changed-after-lost-response', async () => {
    await page.getByRole('alert').filter({ hasText: ambiguous }).waitFor();
    assert.equal(await page.getByRole('alert').filter({ hasText: someoneElse }).count(), 0);
    assert.notEqual(state.renames[1].commandId, state.renames[0].commandId, 'a different title is a different rename');
    assert.equal(await input.inputValue(), 'Renewal follow-ups for Q4');
  });
  release();
  await page.getByText('Current title: “Renewal follow-ups”', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save again', exact: true }).click();
  await input.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Renewal follow-ups for Q4', exact: true }).waitFor();
  assert.equal(state.renames.length, 3);
  assert.notEqual(state.renames[2].commandId, state.renames[1].commandId);
  assert.equal(state.renames[2].expectedRevision, 1, 'the replacement is based on the title the person was shown');
  assert.deepEqual(errors, []);
  await close();
});

test('an unconfirmed rename that never landed reports a real conflict when its retry finds another title', async () => {
  const state = { lose: n => (n === 1 ? 'before-commit' : undefined) };
  state.override = renameServer(state);
  state.releaseList();
  const { page, errors, close } = await open('/acme/chat', state);
  await page.getByRole('button', { name: chat.title, exact: true }).waitFor();
  let release = () => {};
  state.list = new Promise(resolve => {
    release = resolve;
  });
  const input = await renameUnconfirmed(page, 'Renewal follow-ups');
  state.chat = { ...chat, title: 'Q4 renewal outreach', titleRevision: 1 };
  await page.getByRole('button', { name: 'Save again', exact: true }).click();
  await evidence(page, 'a05-rename-lost-request-conflict', async () => {
    await page.getByRole('alert').filter({ hasText: someoneElse }).waitFor();
    assert.deepEqual(state.renames[1], state.renames[0], 'the retry asks the server about the same command');
  });
  release();
  await page.getByText('Current title: “Q4 renewal outreach”', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save again', exact: true }).click();
  await input.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Renewal follow-ups', exact: true }).waitFor();
  assert.equal(state.renames.length, 3);
  assert.notEqual(
    state.renames[2].commandId,
    state.renames[0].commandId,
    'after a confirmed conflict, replacing the title is a new rename',
  );
  assert.equal(state.renames[2].expectedRevision, 1);
  assert.deepEqual(errors, []);
  await close();
});

for (const [reason, label, recovery] of [
  [
    undefined,
    'Paused',
    'This task is paused and keeps its progress. Read the latest update, then reply below when you want it to continue.',
  ],
  [
    null,
    'Paused',
    'This task is paused and keeps its progress. Read the latest update, then reply below when you want it to continue.',
  ],
  ['user', 'Paused by you', 'Your progress is saved. Reply to continue when you are ready.'],
  [
    'limit.toolCalls',
    'Paused at the tool call limit',
    'The next work needs more tool calls. Raise the tool call limit when you reply to continue.',
  ],
  [
    'limit.activeTime',
    'Paused at the active time limit',
    'The next work needs more active time. Raise the active time limit when you reply to continue.',
  ],
  [
    'limit.credits',
    'Paused at the task credit limit',
    'The next work needs more task credits. Raise the credit limit when you reply to continue.',
  ],
  [
    'limit.steps',
    'Paused at the step limit',
    'This task reached its step limit. Start a new task with a smaller request and the useful results from this one.',
  ],
  [
    'limit.workspaceCredits',
    'Paused because workspace credits are unavailable',
    'Ask a workspace admin to add credits, then reply to continue. Raising this task limit alone will not help.',
  ],
  [
    'model',
    'Paused because the model is unavailable',
    'Read the latest update. Ask a workspace admin to check the model settings, then reply to retry.',
  ],
  [
    'context',
    'Paused because the context is too large',
    'Start a new task with a shorter request and only the sources it needs. This task keeps its history.',
  ],
  [
    'file',
    'Paused because a file could not be read',
    'Read the latest update for the file problem. Check file access, the integration, and the supported format before replying to retry.',
  ],
  [
    'plan',
    'Paused because its plan was stopped',
    'Review the stopped plan and this task progress. Reply here only if you want this task to continue on its own.',
  ],
  [
    'approval',
    'Paused for approval',
    'Review the pending changes before replying to continue. Continuing does not approve any changes.',
  ],
]) {
  test(`a task paused with reason ${reason} shows its cause and recovery in list and detail`, async () => {
    const state = { task: { ...task, pauseReason: reason, ...(reason == null ? { toolCalls: 100 } : {}) } };
    const { page, errors, close } = await open(`/acme/agent-tasks/${taskId}`, state);
    await evidence(page, `a06-paused-${reason}`, async () => {
      const header = page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) });
      const status = header.getByRole('status');
      await status.waitFor();
      const limits = page.getByRole('button', { name: 'Task limits', exact: true });
      await limits.waitFor();
      assert.equal(await status.textContent(), label);
      await header.getByText(recovery, { exact: true }).waitFor();
      assert.equal(await limits.getAttribute('aria-expanded'), 'true');
      if (cdpPort && shots && reason === 'limit.credits')
        execFileSync('agent-browser', [
          '--session',
          'task-pause-evidence',
          '--cdp',
          cdpPort,
          'screenshot',
          `${shots}/task-credit-detail.png`,
        ]);
    });
    await page.goto(`${origin}/acme/agent-tasks`);
    await page.getByText(label, { exact: true }).waitFor();
    await page.getByText(recovery, { exact: true }).waitFor();
    if (reason === 'limit.workspaceCredits') {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.emulateMedia({ colorScheme: 'dark' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (shots) await page.screenshot({ path: `${shots}/task-workspace-credit-list-mobile.png` });
    }
    if (cdpPort && shots && reason === 'limit.credits')
      execFileSync('agent-browser', [
        '--session',
        'task-pause-evidence',
        '--cdp',
        cdpPort,
        'screenshot',
        `${shots}/task-credit-list.png`,
      ]);
    assert.deepEqual(errors, []);
    await close();
  });
}

test('table grants stay discoverable for one person when the workspace has no teams', async () => {
  const { page, errors, close } = await open('/acme/grants', { teams: [] });
  await evidence(page, 'a07-grants-no-teams', async () => {
    await page.getByRole('heading', { name: 'Team table grants', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'No team grants yet', exact: true }).waitFor();
    await page
      .getByText(
        'Team grants give everyone in a team the same table access. Create a team to grant access to several people at once, or give one person access in Individual table grants below.',
        { exact: true },
      )
      .waitFor();
    await page.getByRole('heading', { name: 'Individual table grants', exact: true }).waitFor();
    await page
      .getByText("A person's table access combines their teams' grants with any individual grants below.", {
        exact: false,
      })
      .waitFor();
    assert.equal(
      await page.getByText('Table access is granted to teams, not to individual people.', { exact: false }).count(),
      0,
      'the page never denies that direct grants exist',
    );
  });
  assert.deepEqual(errors, []);
  await close();
});

test('closing a workspace never reads as erasing it', async () => {
  const { page, errors, close } = await open('/acme/settings');
  await evidence(page, 'a08-close-workspace', async () => {
    await page.getByRole('heading', { name: 'Close workspace', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Close this workspace for everyone?' });
    await dialog.waitFor();
    await dialog
      .getByText('Everyone loses access to this workspace. Closing does not erase stored data.', { exact: false })
      .waitFor();
    await dialog.getByRole('button', { name: 'Close workspace for everyone', exact: true }).waitFor();
    const text = await page.locator('body').textContent();
    assert.doesNotMatch(
      text,
      /Delete (this )?workspace|permanently/i,
      'nothing says the workspace is deleted for good',
    );
  });
  assert.deepEqual(errors, []);
  await close();
});

test('Add to Knowledge shows the delayed state at its original two-minute deadline while extraction continues', async () => {
  const state = { polls: 0, document: null };
  state.override = async ({ p, method, request, send }) => {
    if (p.endsWith('/knowledge/documents') && method === 'GET') return send({ items: [], nextCursor: null });
    const match = /\/knowledge\/documents\/([\w-]+)$/.exec(p);
    if (!match) return undefined;
    if (method === 'PUT') {
      const body = request.postDataJSON();
      state.document = {
        documentId: match[1],
        revisionId: match[1],
        title: body.title,
        parsing: 'queued',
        failure: null,
        publicationId: null,
        canRetry: false,
        kind: 'file',
        fileId: body.input.fileId,
      };
      return send(state.document);
    }
    state.polls++;
    return send({ ...state.document, parsing: 'parsing' });
  };
  const { page, errors, close } = await open('/acme/files', state, { clock: true });
  await page.getByRole('button', { name: `More actions for ${notes.name}` }).click();
  await page.getByRole('menuitem', { name: 'Add to Knowledge' }).click();
  const dialog = page.getByRole('dialog', { name: /to Knowledge/ });
  await dialog.getByRole('button', { name: 'Add to Knowledge' }).click();
  await dialog.getByText('Extracting text…').waitFor();
  const slow = dialog.getByText('Extraction is taking longer than usual. It continues after you close this dialog.');
  // Each jump fires the pending poll once; waiting for its answer lets every poll update the dialog before time moves on.
  const advance = async ms => {
    const polls = state.polls;
    await page.clock.fastForward(ms);
    for (let i = 0; state.polls === polls; i++) {
      assert.ok(i < 100, 'the dialog keeps checking extraction');
      await delay(50);
    }
    await delay(100);
  };
  for (let elapsed = 0; elapsed < 116_000; elapsed += 29_000) await advance(29_000);
  assert.equal(await slow.count(), 0, 'the delayed state waits for its two-minute deadline');
  await evidence(page, 'a13-knowledge-delayed', async () => {
    await page.clock.fastForward(6_000);
    await slow.waitFor({ timeout: 3000 });
    await dialog.getByRole('button', { name: 'Check status', exact: true }).waitFor();
  });
  assert.ok(state.polls >= 4);
  assert.deepEqual(errors, []);
  await close();
});

for (const icon of ['data:image/png;base64,iVBORw0KGgo=', null]) {
  test(`workspace recovery names an icon ${icon ? 'change' : 'removal'} as an icon change`, async () => {
    const requestId = '33333333-3333-4333-8333-333333333333';
    const pending = {
      userId: 'ada',
      workspaceId: wid,
      channel: 'settings',
      command: { kind: 'icon', requestId, expectedRevision: 1, icon },
    };
    const state = {};
    state.override = async ({ p, send }) =>
      p === `/v1/workspace-settings/${wid}/commands/${requestId}` ? send({ requestId, icon, revision: 2 }) : undefined;
    const init = {
      script: pending =>
        sessionStorage.setItem(
          `tulipfarm.pending-command.${JSON.stringify(['ada', pending.workspaceId, 'settings'])}`,
          JSON.stringify(pending),
        ),
      arg: pending,
    };
    const { page, errors, close } = await open('/account/workspace-recovery', state, { init });
    await evidence(page, `a15-recovery-icon-${icon ? 'set' : 'removed'}`, async () => {
      await page.getByRole('heading', { name: `${workspace.name} · Workspace icon`, exact: true }).waitFor();
      await page.getByText(icon ? 'Set a new workspace icon' : 'Remove the workspace icon', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Check command status', exact: true }).click();
      await page
        .getByRole('status')
        .filter({ hasText: icon ? 'Workspace icon saved.' : 'Workspace icon removed.' })
        .waitFor();
      assert.equal(await page.getByText('Workspace name saved.', { exact: true }).count(), 0);
    });
    assert.deepEqual(errors, []);
    await close();
  });
}
