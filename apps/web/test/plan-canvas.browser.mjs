import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { planListItemSchema, planViewSchema } from '../../../packages/agents/src/plan-contracts.ts';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const port = Number(process.env.PLAN_BROWSER_PORT ?? 5244);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.PLAN_SCREENSHOTS;
const chatId = '11111111-1111-4111-8111-111111111111';
const { workspace, session } = createWorkspaceFixture({ slug: 'plan-qa', name: 'Plan QA' });
const chat = {
  id: chatId,
  title: 'Waitlist launch',
  titleRevision: 1,
  archived: false,
  activityAt: workspace.createdAt,
  createdAt: workspace.createdAt,
};
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const states = [
  'pending',
  'ready',
  'running',
  'waiting-input',
  'waiting-approval',
  'blocked',
  'completed',
  'failed',
  'cancelled',
];
const counts = tasks => {
  const result = Object.fromEntries([...states, 'total'].map(key => [key, 0]));
  for (const task of tasks.filter(task => task.kind === 'work')) {
    result[task.state] += 1;
    if (task.state !== 'cancelled') result.total += 1;
  }
  return result;
};
const agentId = uuid(900);
let next = 1;
const task = (key, title, extra = {}) => ({
  id: uuid(next++),
  key,
  parent: null,
  position: 0,
  kind: 'work',
  order: 'parallel',
  title,
  brief: '',
  criteria: [],
  dependsOn: [],
  state: 'pending',
  reason: null,
  assignee: null,
  summary: null,
  waitingTaskId: null,
  ...extra,
});
const group = (key, title, children, extra = {}) => {
  const summary = {
    counts: counts(children),
    outcome: children.some(child => child.state === 'failed') ? 'failed' : 'active',
  };
  return task(key, title, { kind: 'group', summary, ...extra });
};

function waitlistTasks() {
  next = 1;
  const frontend = [
    task('page', 'Write the waitlist page copy and layout', {
      parent: 'frontend',
      state: 'completed',
      assignee: { kind: 'specialist', specialist: 'frontend', name: 'Frontend specialist' },
    }),
    task(
      'form',
      'Build the signup form with email validation and a thank-you state that explains what happens next for people who join late',
      {
        parent: 'frontend',
        position: 1,
        dependsOn: ['page'],
        state: 'running',
        brief: 'Use the approved page copy. Keep the form to a single email field.',
        criteria: ['Invalid email addresses show a clear message', 'The thank-you state names the launch month'],
        assignee: { kind: 'specialist', specialist: 'frontend', name: 'Frontend specialist' },
      },
    ),
  ];
  const backend = [
    task('shape', 'Define the waitlist table', {
      parent: 'backend',
      state: 'completed',
      assignee: { kind: 'agent', agentId, name: 'Operations analyst' },
    }),
    task('reads', 'Read the signups back for the weekly report', {
      parent: 'backend',
      position: 1,
      dependsOn: ['shape'],
      state: 'waiting-input',
      waitingTaskId: uuid(800),
      reason: 'Which timezone should the weekly report use?',
      assignee: { kind: 'agent', agentId, name: 'Operations analyst' },
    }),
    task('import', 'Import the old spreadsheet', {
      parent: 'backend',
      position: 2,
      state: 'cancelled',
      reason: 'The spreadsheet is already in the table.',
    }),
  ];
  return [
    group('frontend', 'Frontend', frontend),
    ...frontend,
    group('backend', 'Backend', backend, { position: 1, order: 'serial' }),
    ...backend,
    task('connect', 'Hook the form up to the waitlist table', {
      position: 2,
      dependsOn: ['frontend', 'backend'],
      assignee: { kind: 'specialist', specialist: 'integrator', name: 'Integration specialist' },
    }),
    task('qa', 'Check the whole flow end to end', {
      position: 3,
      dependsOn: ['connect'],
      criteria: ['A test signup appears in the weekly report'],
      assignee: { kind: 'specialist', specialist: 'qa', name: 'QA specialist' },
    }),
  ];
}

const budget = { toolCalls: 300, activeMilliseconds: 1800000, credits: 300 };
function view(id, title, tasks, extra = {}) {
  const work = counts(tasks);
  return planViewSchema.parse({
    id,
    chatId,
    title,
    brief: '',
    lifecycle: 'active',
    version: 3,
    canControl: true,
    createdAt: workspace.createdAt,
    updatedAt: workspace.createdAt,
    counts: work,
    outcome: 'active',
    pause: null,
    budget,
    specialists: [],
    tasks,
    ...extra,
  });
}

function fixtures() {
  return {
    waitlist: view(uuid(101), 'Build a waitlist', waitlistTasks(), {
      brief: 'A single page where people join the launch waitlist, stored in a table we can report on.',
    }),
    budget: view(
      uuid(102),
      'Research competitor pricing',
      [task('collect', 'Collect public pricing pages', { state: 'ready' })],
      { lifecycle: 'paused', pause: 'budget' },
    ),
    later: view(uuid(103), 'Draft the launch email', [task('draft', 'Draft the email', { state: 'running' })]),
  };
}

test(
  'plans open as a read-only outline, starters control them in chat, and viewers only read',
  { timeout: 180000 },
  async () => {
    const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: new URL('..', import.meta.url),
      stdio: 'ignore',
      detached: true,
    });
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
        assert.ok(attempt < 150 && server.exitCode === null, 'Vite starts');
        await delay(100);
      }
      if (shots) mkdirSync(shots, { recursive: true });
      const plans = fixtures();
      let listed = [plans.waitlist, plans.budget];
      let failRead = null;
      const controls = [];
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(60000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await context.route('**/v1/**', route => {
        const path = new URL(route.request().url()).pathname;
        const plan = Object.values(plans).find(
          candidate =>
            path.endsWith(`/agent-plans/${candidate.id}`) || path.endsWith(`/agent-plans/${candidate.id}/control`),
        );
        let json;
        if (path === '/v1/user/visit') json = { firstSession: false };
        else if (path === '/v1/auth/get-session') json = session;
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path.endsWith('/governance/me'))
          json = {
            membershipId: chatId,
            role: 'member',
            teams: [],
            capabilities: { manageGovernance: false, canLeave: true },
          };
        else if (path.endsWith('/model-catalog')) json = chatCatalog;
        else if (path.endsWith(`/conversations/${chatId}/plans`))
          json = { plans: listed.map(item => planListItemSchema.parse(item)) };
        else if (plan && path.endsWith('/control')) {
          const body = route.request().postDataJSON();
          controls.push({ plan: plan.title, ...body });
          if (body.action === 'pause') Object.assign(plan, { lifecycle: 'paused', pause: 'starter' });
          if (body.action === 'resume')
            Object.assign(plan, { lifecycle: 'active', pause: null, budget: body.budget ?? plan.budget });
          if (body.action === 'stop') Object.assign(plan, { lifecycle: 'stopped', pause: null });
          plan.version += 1;
          if (body.action === 'pause') listed = [plans.waitlist, plans.budget, plans.later];
          json = { id: plan.id, version: plan.version, added: [], yielded: false };
        } else if (plan) {
          if (failRead?.id === plan.id)
            return route.fulfill({
              status: failRead.status,
              json: { error: failRead.status === 404 ? 'plan-not-found' : 'unavailable' },
            });
          json = plan;
        } else if (path.endsWith('/messages'))
          json = {
            messages: [
              {
                id: chatId,
                sequence: 1,
                author: 'human',
                createdAt: workspace.createdAt,
                parts: [{ kind: 'text', text: 'Build me a waitlist page for the launch.' }],
                turn: { id: chatId, status: 'completed', generation: 0 },
                tools: [],
              },
            ],
            nextBefore: null,
            hasGitHubProposals: false,
          };
        else if (/\/conversations\/[\w-]+$/.test(path)) json = chat;
        else return route.fulfill({ status: 404, json: { error: 'not-found' } });
        return route.fulfill({ json });
      });

      await page.goto(`${origin}/${workspace.slug}/chat/${chatId}`);
      const reference = page.getByRole('region', { name: 'Plan: Build a waitlist' });
      await reference.waitFor();
      const panel = page.getByRole('region', { name: 'Canvas', exact: true });
      const canvas = panel.locator('.sprout-canvas-body');
      assert.equal(await panel.count(), 0, 'saved plans remain in chat until opened');
      await reference.getByText('2 of 6 done · 1 working · 1 waiting for input').waitFor();

      await reference.getByRole('button', { name: 'Open plan' }).click();
      await canvas.getByRole('heading', { name: 'Build a waitlist' }).waitFor();
      await canvas.getByText('A task needs your input').waitFor();
      assert.equal(
        await canvas
          .locator('input, textarea, select, [role=checkbox], [contenteditable=true], [draggable=true]')
          .count(),
        0,
        'the outline has nothing to edit',
      );

      const form = canvas.getByRole('button', { name: /Build the signup form/ });
      assert.equal(await form.getAttribute('aria-expanded'), 'false');
      await form.click();
      assert.equal(await form.getAttribute('aria-expanded'), 'true');
      await canvas.getByText('Invalid email addresses show a clear message').waitFor();
      await canvas.getByRole('link', { name: /Write the waitlist page copy/ }).waitFor();
      await canvas.getByRole('button', { name: /Read the signups back/ }).click();
      assert.match(
        await canvas.locator('a', { hasText: 'Answer in task' }).getAttribute('href'),
        new RegExp(`/${workspace.slug}/agent-tasks/${uuid(800)}$`),
      );
      await canvas.getByRole('button', { name: /Hook the form up/ }).click();
      await canvas.getByRole('link', { name: 'Frontend' }).waitFor();
      const frontend = canvas.getByRole('button', { name: /^Frontend/ });
      await frontend.click();
      assert.equal(await frontend.getAttribute('aria-expanded'), 'false');
      await canvas.locator('[data-slot="plan-outline-panel"][data-ending-style]').waitFor({ state: 'detached' });
      assert.equal(
        await canvas
          .getByText('Write the waitlist page copy and layout')
          .evaluateAll(elements => elements.some(element => element.checkVisibility())),
        false,
      );
      await frontend.click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
        true,
      );
      if (shots) await page.screenshot({ path: `${shots}/plan-desktop.png` });

      await reference.getByRole('button', { name: 'Pause plan' }).click();
      await reference.getByRole('button', { name: 'Resume plan' }).waitFor();
      await page.getByRole('region', { name: 'Plan: Draft the launch email' }).waitFor();
      assert.equal(
        await panel.getByRole('tab', { name: 'Draft the launch email' }).count(),
        0,
        'a new plan does not replace an explicit selection',
      );
      assert.equal(await panel.getByRole('tab', { name: 'Build a waitlist' }).getAttribute('aria-selected'), 'true');
      await canvas.getByText('Paused', { exact: true }).first().waitFor();

      await reference.getByRole('button', { name: 'Stop plan' }).click();
      const confirm = page.getByRole('alertdialog');
      await confirm.getByRole('button', { name: 'Keep running' }).click();
      await confirm.waitFor({ state: 'detached' });
      await reference.getByRole('button', { name: 'Stop plan' }).click();
      await confirm.getByRole('button', { name: 'Stop plan' }).click();
      await canvas.getByText('Unfinished tasks were cancelled. Finished work is kept.').waitFor();
      assert.equal(
        await reference.getByRole('button', { name: /Pause plan|Stop plan|Resume plan/ }).count(),
        0,
        'a stopped plan has no controls',
      );

      const pricing = page.getByRole('region', { name: 'Plan: Research competitor pricing' });
      await pricing.getByRole('button', { name: 'Add budget and resume' }).click();
      await pricing.getByRole('button', { name: 'Pause plan' }).waitFor();
      assert.deepEqual(
        controls.map(({ plan, action, budget }) => [plan, action, budget]),
        [
          ['Build a waitlist', 'pause', undefined],
          ['Build a waitlist', 'stop', undefined],
          ['Research competitor pricing', 'resume', { toolCalls: 600, activeMilliseconds: 3600000, credits: 600 }],
        ],
      );
      assert.equal(new Set(controls.map(control => control.requestId)).size, 3);

      failRead = { id: plans.later.id, status: 500 };
      await page.reload();
      await page
        .getByRole('region', { name: 'Plan: Draft the launch email' })
        .getByRole('button', { name: 'Open plan' })
        .click();
      await canvas.getByText('Couldn’t load this plan').waitFor();
      failRead = null;
      await canvas.getByRole('button', { name: 'Load plan again' }).click();
      await canvas.getByRole('heading', { name: 'Draft the launch email' }).waitFor();

      failRead = { id: plans.budget.id, status: 404 };
      await page
        .getByRole('region', { name: 'Plan: Research competitor pricing' })
        .getByRole('button', { name: 'Open plan' })
        .click();
      await canvas.getByText('Plan unavailable').waitFor();
      assert.equal(
        await canvas.getByText('Collect public pricing pages').count(),
        0,
        'nothing from an unavailable plan is shown',
      );
      failRead = null;

      for (const plan of Object.values(plans)) plan.canControl = false;
      Object.assign(plans.waitlist, { lifecycle: 'active', pause: null });
      await page.reload();
      await reference.getByRole('button', { name: 'Open plan' }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: /Pause plan|Stop plan|Resume plan|Add budget/ }).count(),
        0,
        'viewers see no controls',
      );

      await page.setViewportSize({ width: 375, height: 812 });
      await reference.getByRole('button', { name: 'Open plan' }).click();
      const sheet = page.getByRole('dialog', { name: 'Canvas' });
      await canvas.getByRole('heading', { name: 'Build a waitlist' }).waitFor();
      await sheet.getByRole('button', { name: /Build the signup form/ }).click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
        true,
      );
      if (shots) await page.screenshot({ path: `${shots}/plan-mobile.png` });
      await sheet.getByRole('button', { name: 'Back to chat', exact: true }).click();
      await sheet.waitFor({ state: 'detached' });
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
  },
);
