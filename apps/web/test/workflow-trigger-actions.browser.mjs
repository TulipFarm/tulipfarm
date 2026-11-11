import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { workflowSchema } from '@tulipfarm/workflows/contracts';
import { createWorkspaceFixture, workspaceShellReads, serveWorkspaceShellEvent } from './workspace.fixture.mjs';

const require = createRequire(import.meta.url);
const { workspace, session } = createWorkspaceFixture({ slug: 'trigger-actions', name: 'Workflow triggers' });
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const membershipId = id('2');
const base = `/v1/workspaces/${workspace.id}/workflows`;
const initial = workflowSchema.parse({
  id: id('3'),
  revision: id('4'),
  activeRevision: id('4'),
  enabled: true,
  generation: 3,
  nextRunAt: null,
  definition: {
    version: 1,
    name: 'Order intake',
    triggers: [{ id: 'manual', kind: 'event', name: 'manual' }],
    steps: [{ id: 'prepare', kind: 'transform', fields: {} }],
  },
  activeTriggers: [{ id: 'manual', kind: 'event', name: 'manual' }],
  capabilities: { read: true, invoke: true, manage: true },
  sponsorMembershipId: membershipId,
  sponsor: { id: membershipId, userId: session.user.id, name: 'Ada' },
  sponsorshipAccepted: true,
  historyAudience: [membershipId],
});
let server, browser, origin;
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({
    args: process.env.TRIGGER_ACTIONS_CDP_PORT
      ? [`--remote-debugging-port=${process.env.TRIGGER_ACTIONS_CDP_PORT}`]
      : [],
  });
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.close();
  }
});

async function open(t, { inactive = false, failActivation = false, start = false, manager = true } = {}) {
  let current = structuredClone(initial);
  current.capabilities.manage = manager;
  if (inactive) current = { ...current, enabled: false, activeRevision: null, activeTriggers: null };
  const writes = [],
    errors = [];
  let activationFails = failActivation;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(60000);
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
      path = url.pathname,
      method = request.method();
    if (!path.startsWith('/v1/')) return url.origin === origin ? route.continue() : route.abort();
    if (await serveWorkspaceShellEvent(route, workspace)) return;
    if (reads.has(path)) return route.fulfill({ json: reads.get(path) });
    if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
    if (method !== 'GET') writes.push({ path, body: request.postDataJSON() });
    if (path === base) return route.fulfill({ json: url.searchParams.has('archived') ? [] : [current] });
    if (path === `${base}/sharing-candidates`)
      return route.fulfill({
        json: {
          membershipId,
          people: [{ id: membershipId, userId: session.user.id, name: 'Ada' }],
          teams: [],
        },
      });
    if (path.endsWith('/grants')) return route.fulfill({ json: [] });
    if (path.endsWith('/webhook-deliveries')) return route.fulfill({ json: { deliveries: [], nextCursor: null } });
    if (path === `${base}/${current.id}` && method === 'PUT') {
      const body = request.postDataJSON();
      assert.equal(body.expectedRevision, current.revision);
      current = {
        ...current,
        revision: body.revision,
        definition: body.definition,
        generation: current.generation + 1,
      };
      return route.fulfill({ json: current });
    }
    if (path.endsWith('/activation')) {
      const body = request.postDataJSON();
      assert.equal(body.revision, current.revision);
      assert.equal(body.expectedGeneration, current.generation);
      if (activationFails) {
        activationFails = false;
        return route.fulfill({ status: 409, json: { error: 'stale-generation' } });
      }
      current = {
        ...current,
        enabled: true,
        activeRevision: current.revision,
        activeTriggers: current.definition.triggers,
        generation: current.generation + 1,
        triggers: current.definition.triggers.map(trigger => ({
          id: trigger.id,
          kind: trigger.kind,
          enabled: true,
          summary: trigger.kind,
          nextRunAt: null,
          webhook: null,
        })),
      };
      return route.fulfill({ json: current });
    }
    if (path.endsWith('/webhook-key')) {
      const triggerId = path.split('/').at(-2);
      assert.equal(request.postDataJSON().expectedGeneration, current.generation);
      const state = current.triggers.find(item => item.id === triggerId);
      const previous = state.webhook?.configured
        ? { mode: state.webhook.mode, expiresAt: '2026-11-12T12:00:00Z' }
        : null;
      state.webhook = { configured: true, mode: request.postDataJSON().mode, rotation: true, previous };
      current.generation++;
      return route.fulfill({ json: { workflow: current, key: 'a1'.repeat(32) } });
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
    if (path.endsWith('/runs')) return route.fulfill({ json: { runs: [], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  });
  await page.goto(`${origin}/${workspace.slug}/workflows/${current.id}${start ? '?view=runs&start=true' : ''}`);
  await page.getByRole('tab', { name: 'Overview', exact: true }).waitFor({ timeout: 60000 });
  if (!start) await page.getByRole('heading', { name: 'Triggers', exact: true }).waitFor();
  return { page, writes, current: () => current };
}

async function shot(page, name) {
  const directory = process.env.TRIGGER_ACTIONS_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const path = `${directory}/${name}.png`;
  if (process.env.TRIGGER_ACTIONS_CDP_PORT)
    execFileSync('agent-browser', [
      '--session',
      'trigger-actions',
      '--cdp',
      process.env.TRIGGER_ACTIONS_CDP_PORT,
      'screenshot',
      path,
    ]);
  else await page.screenshot({ path, fullPage: true });
}
async function accessible(page) {
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const violations = await page.evaluate(async () =>
    (await window.axe.run(document)).violations.filter(item => ['serious', 'critical'].includes(item.impact)),
  );
  assert.deepEqual(
    violations.map(item => ({
      id: item.id,
      nodes: item.nodes.map(node => ({ target: node.target, html: node.html, failure: node.failureSummary })),
    })),
    [],
  );
}

test('three clicks save and activate a webhook, with a direct route to its one-time key and accessible tabs', async t => {
  const { page, writes, current } = await open(t);
  assert.equal(await page.getByText('App event manual', { exact: true }).count(), 0);
  await page.getByText('Started by hand', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('manual', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Add trigger', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Webhook', exact: true }).click();
  await accessible(page);
  await shot(page, 'trigger-editor');
  await page.getByRole('button', { name: 'Save and activate', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Order intake is active. Set up a webhook key so the webhook can start runs.' })
    .waitFor();
  assert.equal(writes.length, 2, 'one save and one activation, without accepting sponsorship');
  assert.equal(current().activeRevision, current().revision);
  await page.getByText('No key yet', { exact: true }).waitFor();
  await accessible(page);
  await shot(page, 'overview');
  await page.getByRole('button', { name: 'Set up webhook key', exact: true }).click();
  const setup = page.getByRole('region', { name: 'Webhook setup for Webhook', exact: true });
  await setup.waitFor();
  await page.waitForFunction(() => document.activeElement?.id.startsWith('webhook-setup-'));
  await setup.getByRole('button', { name: 'Create webhook key', exact: true }).click();
  assert.equal(await setup.getByLabel('New webhook key').inputValue(), 'a1'.repeat(32));
  await setup.getByRole('button', { name: 'Replace webhook key', exact: true }).click();
  assert.match(
    await setup.getByLabel('Previous webhook key status').innerText(),
    /The previous key keeps working until .+\./,
  );
  await accessible(page);
  await shot(page, 'webhook-key');
  await page.setViewportSize({ width: 375, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot(page, 'webhook-key-mobile');
  await page.reload();
  assert.equal(await page.getByLabel('New webhook key').count(), 0, 'a page reload never reads the issued key again');
});

test('save only keeps the active revision, and a failed activation keeps a saved revision ready to activate', async t => {
  const { page, writes, current } = await open(t, { failActivation: true });
  const active = current().activeRevision;
  await page.getByRole('button', { name: 'Add trigger', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Webhook', exact: true }).click();
  await page.getByRole('button', { name: 'Save only', exact: true }).click();
  await page
    .getByText('Revision saved. Runs still use the active revision until you activate this one.', { exact: true })
    .waitFor();
  assert.equal(writes.length, 1);
  assert.equal(current().activeRevision, active);
  await page.getByRole('button', { name: 'Add trigger', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Webhook', exact: true }).click();
  await page.getByRole('button', { name: 'Save and activate', exact: true }).click();
  await page
    .getByText(
      'Revision saved, but not activated. This workflow changed. Open the workflow to review its current state before activating. Runs still use the active revision.',
      { exact: true },
    )
    .waitFor();
  assert.equal(current().activeRevision, active);
  await page.getByRole('button', { name: 'Activate saved revision', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Order intake is active. Set up a webhook key so the webhook can start runs.' })
    .waitFor();
});

test('a first activation uses the workflow label and explains why runs are blocked', async t => {
  const { page, current } = await open(t, { inactive: true });
  await page.getByText('Activate the workflow to start runs.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Activate saved revision', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Activate workflow', exact: true }).click();
  await page.getByRole('button', { name: 'Disable workflow', exact: true }).waitFor();
  assert.equal(current().enabled, true);
});

test('a member without management access sees who can activate an inactive workflow', async t => {
  const { page } = await open(t, { inactive: true, manager: false });
  await page.getByText('Ask a workflow manager to activate this workflow.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Activate workflow', exact: true }).count(), 0);
});

test('the run link opens the input form, and activation feedback counts only triggers that can start runs', async t => {
  const { page, current } = await open(t, { start: true });
  await page.getByRole('button', { name: 'Run workflow', exact: true }).waitFor();
  const messages = await page.evaluate(async workflow => {
    const { workflowLiveMessage } = await import('/src/features/workflows/activation-feedback.ts');
    const interval = { id: 'hourly', kind: 'interval', minutes: 60 };
    const hook = { id: 'orders', kind: 'webhook' };
    const once = { id: 'expired', kind: 'once', at: '2020-01-01T00:00:00Z' };
    const state = (trigger, enabled = true) => ({
      id: trigger.id,
      kind: trigger.kind,
      enabled,
      summary: '',
      nextRunAt: null,
      webhook: null,
    });
    const one = {
      ...workflow,
      activeTriggers: [interval, hook, once],
      triggers: [state(interval), state(hook, false), state(once)],
    };
    const second = { id: 'second', kind: 'interval', minutes: 120 };
    return [
      workflowLiveMessage(one),
      workflowLiveMessage({ ...one, activeTriggers: [interval, second], triggers: [state(interval), state(second)] }),
      workflowLiveMessage({
        ...workflow,
        activeTriggers: [],
        capabilities: { ...workflow.capabilities, invoke: false },
      }),
    ];
  }, current());
  assert.deepEqual(messages, [
    'Order intake is active with 1 trigger.',
    'Order intake is active with 2 triggers.',
    'Order intake is active.',
  ]);
});
