import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { workflowSchema } from '@tulipfarm/workflows/contracts';
import { startBuiltApp } from './built-app.fixture.mjs';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';

const { workspace, session } = createWorkspaceFixture({ slug: 'code-steps', name: 'Code steps' });
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const membershipId = id('2');
const base = `/v1/workspaces/${workspace.id}/workflows`;
const prepare = { id: 'prepare', kind: 'transform', fields: { leads: { kind: 'input', path: ['leads'] } } };
const workflowWith = (steps, overrides = {}) =>
  workflowSchema.parse({
    id: id('3'),
    revision: id('4'),
    activeRevision: id('4'),
    enabled: true,
    generation: 1,
    nextRunAt: null,
    definition: { version: 1, name: 'Lead scoring', triggers: [], steps },
    activeTriggers: [],
    capabilities: { read: true, invoke: true, manage: true },
    sponsorMembershipId: membershipId,
    historyAudience: [membershipId],
    codeStepsAvailable: true,
    ...overrides,
  });

let app, browser;
before(async () => {
  app = await startBuiltApp();
  browser = await chromium.launch();
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    await app?.close();
  }
});

async function open(t, current, { failWith } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  const errors = [],
    saves = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
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
      { membershipId, role: 'admin', teams: [], capabilities: { manageGovernance: true, canLeave: true } },
    ],
  ]);
  await page.route('**/*', async route => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (!path.startsWith('/v1/')) return url.origin === app.origin ? route.continue() : route.abort();
    if (await serveWorkspaceShellEvent(route, workspace)) return;
    if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
    if (reads.has(path)) return route.fulfill({ json: reads.get(path) });
    if (path === base) return route.fulfill({ json: url.searchParams.has('archived') ? [] : [current] });
    if (path === `${base}/${current.id}/runs`) return route.fulfill({ json: { runs: [], nextCursor: null } });
    if (path === `${base}/${current.id}` && request.method() === 'PUT') {
      const body = request.postDataJSON();
      saves.push(body);
      if (failWith) return route.fulfill({ status: 409, json: { error: failWith } });
      current = workflowSchema.parse({ ...current, revision: body.revision, definition: body.definition });
      return route.fulfill({ json: current });
    }
    if (path === `${base}/${current.id}`)
      return route.fulfill({
        json: {
          workflowId: current.id,
          revision: current.revision,
          savedRevision: current.revision,
          activeRevision: current.activeRevision,
          definition: current.definition,
          actor: null,
          canManage: true,
          archived: false,
        },
      });
    if (path === `${base}/sharing-candidates`) return route.fulfill({ json: { membershipId, people: [], teams: [] } });
    if (path === `${base}/${current.id}/grants`) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  });
  await page.goto(`${app.origin}/${workspace.slug}/workflows/${current.id}`);
  await page.getByRole('heading', { name: 'Triggers', exact: true }).waitFor();
  return { page, saves };
}

test('a manager adds, edits and removes a code step, and each change saves a revision', async t => {
  const { page, saves } = await open(t, workflowWith([prepare]));
  await page.getByText('No code steps yet.').waitFor();
  await page.getByRole('button', { name: 'Add code step' }).click();
  await page.getByRole('menuitem', { name: 'Python' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a code step' });
  assert.equal(await dialog.getByRole('textbox', { name: 'Step ID' }).inputValue(), 'code');
  assert.match(await dialog.getByRole('textbox', { name: 'Code', exact: true }).inputValue(), /^# `input`/);
  await dialog.getByRole('textbox', { name: 'Step ID' }).fill('prepare');
  await dialog.getByText('Another step already uses this ID.').waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Add step' }).isDisabled(), true);
  await dialog.getByRole('textbox', { name: 'Step ID' }).fill('score');
  await dialog.getByRole('textbox', { name: 'Code', exact: true }).fill('return {"count": len(input["leads"])}');
  await dialog.getByRole('button', { name: 'Add step' }).click();
  await page.getByText('Step saved. Activate the saved revision to use it.').waitFor();
  assert.equal(saves[0].expectedRevision, id('4'));
  assert.deepEqual(saves[0].definition.steps.at(-1), {
    id: 'score',
    kind: 'code',
    language: 'python',
    source: 'return {"count": len(input["leads"])}',
    input: { kind: 'step', step: 'prepare', path: [] },
  });
  await page.getByText('Python · reads').waitFor();

  await page.getByRole('button', { name: 'Edit score' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit score' });
  assert.equal(await edit.getByRole('textbox', { name: 'Step ID' }).isDisabled(), true);
  await edit.getByRole('combobox', { name: 'Input' }).click();
  await page.getByRole('option', { name: 'No input' }).click();
  await edit.getByRole('button', { name: 'Save step' }).click();
  await edit.waitFor({ state: 'hidden' });
  assert.equal(saves[1].expectedRevision, saves[0].revision);
  assert.deepEqual(saves[1].definition.steps.at(-1).input, { kind: 'literal', value: null });
  await page.getByText('Python · no input').waitFor();

  await page.getByRole('button', { name: 'Remove score' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove step' }).click();
  await page.getByText('Step removed. Activate the saved revision to stop running it.').waitFor();
  assert.deepEqual(saves[2].definition.steps, [prepare]);
  await page.getByText('No code steps yet.').waitFor();
});

test('a server without a code runner explains why the step was not saved', async t => {
  const { page } = await open(t, workflowWith([prepare]), { failWith: 'code-steps-unavailable' });
  await page.getByRole('button', { name: 'Add code step' }).click();
  await page.getByRole('menuitem', { name: 'Bash' }).click();
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByText('Code steps aren’t available on this server yet.').waitFor();
  await page.getByRole('textbox', { name: 'Step ID' }).fill('Bad id');
  await page.getByText('Start the ID with a lowercase letter.').waitFor();
  assert.equal(await page.getByText('Code steps aren’t available on this server yet.').count(), 0);
});

test('the editor is hidden where code cannot run, and steps another step reads cannot be removed', async t => {
  const score = { id: 'score', kind: 'code', language: 'bash', source: 'echo 1', input: { kind: 'input', path: [] } };
  const report = { id: 'report', kind: 'transform', fields: { count: { kind: 'step', step: 'score', path: [] } } };
  const blocked = await open(t, workflowWith([prepare], { codeStepsAvailable: false }));
  assert.equal(await blocked.page.getByRole('heading', { name: 'Code steps', exact: true }).count(), 0);

  const { page } = await open(t, workflowWith([score, report]));
  await page.getByText('Bash · reads').waitFor();
  const remove = page.getByRole('button', { name: 'Remove score' });
  assert.equal(await remove.getAttribute('aria-disabled'), 'true');
});
