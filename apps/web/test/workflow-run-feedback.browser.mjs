import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { workflowSchema, runDetailSchema } from '@tulipfarm/workflows/contracts';
import { startBuiltApp } from './built-app.fixture.mjs';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';

const { workspace, session } = createWorkspaceFixture({ slug: 'workflow-feedback', name: 'Workflow feedback' });
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const membershipId = id('2');
const base = `/v1/workspaces/${workspace.id}/workflows`;
const steps = [
  { id: 'prepare', kind: 'transform', fields: {} },
  { id: 'finish', kind: 'transform', fields: {} },
];
const definition = { version: 1, name: 'Daily review', triggers: [], steps };
const workflow = workflowSchema.parse({
  id: id('3'),
  revision: id('4'),
  activeRevision: id('5'),
  enabled: true,
  generation: 1,
  nextRunAt: null,
  definition,
  activeTriggers: [],
  capabilities: { read: true, invoke: true, manage: true },
  sponsorMembershipId: membershipId,
  historyAudience: [membershipId],
});
const receipt = (ordinal, status = 'completed') => ({
  ordinal,
  stepId: steps[ordinal].id,
  status,
  output: {},
  prompt: null,
  dueAt: null,
});
function run(n, status, receipts, error = null) {
  return runDetailSchema.parse({
    definition,
    actor: null,
    canManage: true,
    run: {
      id: id(n),
      workflowId: workflow.id,
      revision: workflow.activeRevision,
      status,
      source: 'manual',
      input: {},
      createdAt: '2026-10-12T12:00:00Z',
      startedAt: '2026-10-12T12:00:00Z',
      finishedAt: '2026-10-12T12:00:01Z',
      steps: receipts,
      error,
    },
  }).run;
}
let app, browser;
before(async () => {
  app = await startBuiltApp();
  browser = await chromium.launch({
    args: process.env.WORKFLOW_FEEDBACK_CDP_PORT
      ? [`--remote-debugging-port=${process.env.WORKFLOW_FEEDBACK_CDP_PORT}`]
      : [],
  });
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    await app?.close();
  }
});

async function open(
  t,
  { current = structuredClone(workflow), runs = [], saveFails = false, holdRefresh = false } = {},
) {
  current = workflowSchema.parse(current);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let saved = false,
    refreshStatus = 200,
    release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  t.after(async () => {
    release();
    await page.close();
    assert.deepEqual(errors, []);
  });
  const reads = new Map([
    ...workspaceShellReads(workspace.id),
    ['/v1/auth/get-session', session],
    ['/v1/workspaces', [workspace]],
    [`/v1/workspaces/${workspace.slug}`, workspace],
    [
      `/v1/workspaces/${workspace.id}/governance/me`,
      {
        membershipId,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: true },
      },
    ],
  ]);
  await page.route('**/*', async route => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (!path.startsWith('/v1/')) {
      return url.origin === app.origin ? route.continue() : route.abort();
    }
    if (await serveWorkspaceShellEvent(route, workspace)) return;
    if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
    if (reads.has(path)) return route.fulfill({ json: reads.get(path) });
    if (path === `${base}/${current.id}/sponsorship` && request.method() === 'PUT') {
      assert.deepEqual(request.postDataJSON(), { sponsorMembershipId: membershipId, historyAudience: [membershipId] });
      if (saveFails) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      saved = true;
      return route.fulfill({ json: current });
    }
    if (path === `${base}/sharing-candidates` || path === `${base}/${current.id}/grants`) {
      if (saved && holdRefresh) await held;
      if (refreshStatus !== 200) return route.fulfill({ status: refreshStatus, json: { error: 'unavailable' } });
      return route.fulfill({
        json: path.endsWith('/grants')
          ? []
          : {
              membershipId,
              people: [{ id: membershipId, userId: session.user.id, name: session.user.name }],
              teams: [],
            },
      });
    }
    if (path === base) return route.fulfill({ json: url.searchParams.has('archived') ? [] : [current] });
    if (path === `${base}/${current.id}/runs`) return route.fulfill({ json: { runs, nextCursor: null } });
    if (path.startsWith(`${base}/${current.id}/runs/`)) {
      const selected = runs.find(run => path.endsWith(run.id));
      return route.fulfill({ json: { run: selected, definition, actor: null, canManage: true } });
    }
    if (path === `${base}/${current.id}`)
      return route.fulfill({
        json: {
          workflowId: current.id,
          revision: url.searchParams.get('revision') === 'saved' ? current.revision : current.activeRevision,
          savedRevision: current.revision,
          activeRevision: current.activeRevision,
          definition,
          actor: null,
          canManage: true,
          archived: false,
        },
      });
    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  });
  await page.goto(`${app.origin}/${workspace.slug}/workflows/${current.id}?view=runs`);
  await page.getByRole('heading', { name: 'Run history', exact: true }).waitFor();
  return {
    page,
    release,
    failRefresh: (status = 503) => {
      refreshStatus = status;
    },
  };
}

async function screenshot(page, name) {
  const directory = process.env.WORKFLOW_FEEDBACK_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const path = `${directory}/${name}.png`;
  if (process.env.WORKFLOW_FEEDBACK_CDP_PORT)
    execFileSync('agent-browser', [
      '--session',
      'workflow-feedback',
      '--cdp',
      process.env.WORKFLOW_FEEDBACK_CDP_PORT,
      'screenshot',
      path,
    ]);
  else await page.screenshot({ path, fullPage: true });
}

test('history counts attempted steps, keeps singular/plural copy, and explains step failures', async t => {
  const runs = [
    run('6', 'completed', [receipt(0)]),
    run('7', 'completed', [receipt(0), receipt(1)]),
    run('8', 'failed', [], 'table-input-invalid'),
    run('9', 'failed', [receipt(0), receipt(1, 'waiting')], 'unrecognized-step-error'),
  ];
  const { page } = await open(t, { runs });
  await page.getByRole('button', { name: '1 workflow step', exact: true }).waitFor();
  await page.getByRole('button', { name: '2 workflow steps', exact: true }).waitFor();
  await page.getByRole('button', { name: '1 workflow step · failed at step 1', exact: true }).click();
  await page.getByText('prepare / Failed', { exact: true }).waitFor();
  await page.getByRole('button', { name: '2 workflow steps · failed at step 2', exact: true }).waitFor();
  const failed = page.locator(`#workflow-run-${id('8')}`);
  assert.match(
    await failed.getByRole('alert').innerText(),
    /A table step received missing or invalid input.*Check the input/s,
  );
  await screenshot(page, 'run-history');
  await failed.getByRole('button', { name: 'View run diagram', exact: true }).click();
  await page.getByRole('button', { name: 'Steps', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect Prepare data', exact: true }).first().click();
  await page
    .getByLabel('Step details')
    .getByRole('alert')
    .filter({ hasText: 'A table step received missing or invalid input.' })
    .waitFor();
  await page.getByRole('button', { name: 'Close run diagram', exact: true }).click();
  await page
    .locator(`#workflow-run-${id('9')}`)
    .getByRole('button', { name: 'View run diagram', exact: true })
    .click();
  await page.getByRole('button', { name: 'Steps', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect Prepare data', exact: true }).nth(1).click();
  await page.getByRole('alert').filter({ hasText: 'This step could not complete.' }).waitFor();
  assert.match(
    await page.getByRole('alert').filter({ hasText: 'This step could not complete.' }).innerText(),
    /Check its settings and input/,
  );
});

test('empty history directs active workflows to run and disabled workflows to activate', async t => {
  const active = await open(t);
  await active.page.getByText('No runs yet. Choose Start a run.', { exact: true }).waitFor();
  await screenshot(active.page, 'active-empty');
  await active.page.setViewportSize({ width: 390, height: 844 });
  await active.page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await active.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await screenshot(active.page, 'active-empty-mobile');
  const disabled = await open(t, { current: { ...workflow, enabled: false } });
  await disabled.page
    .getByText('No runs yet. Activate the workflow, then choose Start a run.', { exact: true })
    .waitFor();
});

test('scheduled save confirms before refresh finishes, retains success after refresh failure, and reports write failure', async t => {
  const current = {
    ...workflow,
    definition: { ...definition, triggers: [{ id: 'daily', kind: 'interval', minutes: 1440 }] },
  };
  const saved = await open(t, { current, holdRefresh: true });
  await saved.page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const sharing = saved.page.getByRole('region', { name: 'Workflow sharing', exact: true });
  await sharing.getByRole('button', { name: 'Save scheduled runs', exact: true }).click();
  await sharing
    .getByRole('status')
    .filter({ hasText: /^Scheduled runs saved\./ })
    .waitFor({ timeout: 2000 });
  saved.failRefresh();
  saved.release();
  await sharing
    .getByText('The change was saved, but the latest access could not load. Reload access to check it.', {
      exact: true,
    })
    .waitFor();
  await sharing
    .getByRole('status')
    .filter({ hasText: /^Scheduled runs saved\./ })
    .waitFor();
  await screenshot(saved.page, 'scheduled-save');
  const failed = await open(t, { current, saveFails: true });
  await failed.page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await failed.page.getByRole('button', { name: 'Save scheduled runs', exact: true }).click();
  await failed.page.getByRole('alert').filter({ hasText: 'This change could not be confirmed.' }).waitFor();
  assert.equal(await failed.page.getByText(/^Scheduled runs saved\./).count(), 0);
  const revoked = await open(t, { current, holdRefresh: true });
  await revoked.page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await revoked.page.getByRole('button', { name: 'Save scheduled runs', exact: true }).click();
  await revoked.page.getByText(/^Scheduled runs saved\./).waitFor({ timeout: 2000 });
  revoked.failRefresh(403);
  revoked.release();
  await revoked.page.getByRole('heading', { name: 'Access could not load', exact: true }).waitFor();
  assert.equal(await revoked.page.getByRole('button', { name: 'Save scheduled runs', exact: true }).count(), 0);
});
