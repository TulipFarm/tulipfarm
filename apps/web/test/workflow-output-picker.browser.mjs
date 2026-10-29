import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { authoredDefinitionSchema } from '../../../packages/workflows/src/contracts.ts';
import { openWorkflow, assertConfiguration } from './workflow-definition.fixture.mjs';

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const wid = id('1'),
  mid = id('2'),
  workflowId = id('3'),
  revision = id('4'),
  tableId = id('5'),
  fieldId = id('6');
const origin = 'http://127.0.0.1:5487';
const at = new Date().toISOString();
const reference = (step, path) => ({ kind: 'step', step, path });
const literal = value => ({ kind: 'literal', value });
const initial = () => ({
  id: workflowId,
  revision,
  activeRevision: null,
  enabled: false,
  generation: 1,
  nextRunAt: null,
  activeTrigger: null,
  webhookConfigured: false,
  capabilities: { read: true, manage: true, invoke: true },
  definition: {
    version: 1,
    name: 'Output picker proof',
    trigger: { kind: 'manual' },
    steps: [
      {
        id: 'source',
        kind: 'transform',
        fields: { total: literal(12), details: literal({ 'due.date': '2027-01-31', nested: { label: 'Example' } }) },
      },
      { id: 'find', kind: 'find-rows', tableId, filters: [], limit: 10 },
      { id: 'review', kind: 'human', prompt: 'Review the order', timeoutSeconds: 600 },
      {
        id: 'check',
        kind: 'condition',
        when: { left: reference('source', ['total']), op: 'gt', right: literal(10) },
        ifMet: ['copy'],
        otherwise: [],
      },
      { id: 'wait', kind: 'wait-until', at: reference('source', ['details', 'due.date']) },
      { id: 'copy', kind: 'transform', fields: { total: reference('source', ['total']) } },
      {
        id: 'code',
        kind: 'code',
        language: 'javascript',
        source: 'return input;',
        input: reference('source', ['details', 'due.date']),
      },
      {
        id: 'agent',
        kind: 'agent',
        agentId: mid,
        prompt: reference('source', ['details', 'due.date']),
        limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
      },
      {
        id: 'http',
        kind: 'http',
        method: 'POST',
        url: 'https://example.com',
        headers: { 'x-value': reference('source', ['total']) },
        body: reference('source', ['total']),
      },
      { id: 'add', kind: 'create-row', tableId, fields: { [fieldId]: reference('source', ['total']) } },
      {
        id: 'update',
        kind: 'update-row',
        tableId,
        row: reference('find', ['rows', '0']),
        fields: { [fieldId]: reference('source', ['total']) },
      },
    ],
  },
});
const field = { id: fieldId, label: 'Invoice total', kind: 'numeric', required: false, precision: 10, scale: 2 };
const tableDefinition = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: mid,
  label: 'Invoices',
  fields: [field],
  uniqueKeys: [],
};

test(
  'read-only inspectors preserve output paths and recover definition and connected-name reads without fetching run hints',
  { timeout: 120000 },
  async () => {
    let vite, browser;
    const shots = process.env.OUTPUT_PICKER_SCREENSHOTS,
      cdp = process.env.OUTPUT_PICKER_CDP_PORT;
    const state = {
      workflow: initial(),
      writes: [],
      historyReads: 0,
      tableStatus: 200,
      definitionStatus: 200,
      waitDefinition: null,
    };
    try {
      vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5487', '--strictPort'], {
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
        if (i > 200) throw Error('Vite did not start');
        await delay(100);
      }
      browser = await chromium.launch({ headless: true, args: cdp ? [`--remote-debugging-port=${cdp}`] : [] });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          url = new URL(request.url()),
          p = url.pathname;
        const send = (json, status = 200) => route.fulfill({ status, json });
        if (request.method() === 'PUT' && p.endsWith(`/workflows/${workflowId}`)) {
          state.writes.push(request.postDataJSON());
          return send({ error: 'read-only-fixture' }, 405);
        }
        if (p === '/v1/auth/get-session')
          return send({
            session: { id: 'fixture', userId: 'ada' },
            user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
          });
        if (p === '/v1/user/visit') return send({ firstSession: false });
        const workspace = {
          id: wid,
          slug: 'picker',
          name: 'Picker proof',
          status: 'ready',
          createdAt: at,
          soulCommit: 'a'.repeat(40),
        };
        if (p === '/v1/workspaces') return send([workspace]);
        if (p === '/v1/workspaces/picker') return send(workspace);
        if (p.endsWith('/governance/me'))
          return send({
            membershipId: mid,
            role: 'admin',
            teams: [],
            capabilities: { manageGovernance: true, canLeave: true },
          });
        if (p.endsWith(`/tables/${tableId}`))
          return state.tableStatus === 200
            ? send({
                id: tableId,
                saved: null,
                applied: { revision: 'a'.repeat(40), definition: tableDefinition, appliedAt: at },
              })
            : send({ error: 'unavailable' }, state.tableStatus);
        if (p.endsWith('/workflows')) return send(url.searchParams.has('archived') ? [] : [state.workflow]);
        if (p.endsWith(`/workflows/${workflowId}`)) {
          await state.waitDefinition;
          if (state.definitionStatus !== 200) return send({ error: 'unavailable' }, state.definitionStatus);
          return send({
            workflowId,
            revision: state.workflow.revision,
            savedRevision: state.workflow.revision,
            activeRevision: null,
            definition: state.workflow.definition,
            actor: null,
            canManage: true,
            archived: false,
          });
        }
        if (p.endsWith(`/workflows/${workflowId}/runs`)) {
          state.historyReads++;
          return send({ runs: [], nextCursor: null });
        }
        if (p.endsWith('/provider-integrations')) return send([]);
        if (p.endsWith('/sharing-candidates'))
          return send({ membershipId: mid, people: [{ id: mid, userId: 'ada', name: 'Ada' }], teams: [] });
        if (p.endsWith('/grants')) return send([]);
        if (p.endsWith('/credits'))
          return send({ available: 100, granted: 100, used: 0, held: 0, days: [], breakdown: [], series: [] });
        if (p.endsWith('/agent-tasks')) return send({ tasks: [], nextCursor: null });
        if (p.endsWith('/conversations')) return send({ chats: [], nextCursor: null });
        return send({ error: 'fixture-unavailable' }, 404);
      });
      const capture = async name => {
        if (!shots) return;
        await mkdir(shots, { recursive: true });
        const path = resolve(shots, `${name}.png`);
        if (cdp) execFileSync('agent-browser', ['--cdp', cdp, 'screenshot', path], { stdio: 'pipe' });
        else await page.screenshot({ path, fullPage: true });
      };
      const invalid = structuredClone(state.workflow.definition);
      invalid.steps[5].fields.total = reference('source', ['nonsense']);
      const rejected = authoredDefinitionSchema.safeParse(invalid);
      assert.equal(rejected.success, false);
      assert.match(rejected.error.message, /nonsense/);
      assert.equal(authoredDefinitionSchema.safeParse(state.workflow.definition).success, true);

      let release;
      state.waitDefinition = new Promise(resolve => {
        release = resolve;
      });
      await page.goto(`${origin}/picker/workflows`);
      await page.getByRole('link', { name: 'Output picker proof', exact: true }).click();
      await page.getByRole('status', { name: 'Loading workflow diagram', exact: true }).waitFor();
      assert.equal(await page.getByRole('region', { name: 'Output picker proof workflow', exact: true }).count(), 0);
      state.definitionStatus = 503;
      release();
      await page.getByRole('heading', { name: 'Workflow could not load', exact: true }).waitFor();
      state.definitionStatus = 200;
      await page.getByRole('button', { name: 'Retry loading workflow', exact: true }).click();
      let viewer = page.getByRole('region', { name: 'Output picker proof workflow', exact: true });
      await viewer.getByRole('button', { name: 'Edit in chat', exact: true }).waitFor();
      await viewer.getByRole('figure', { name: 'Read-only workflow diagram', exact: true }).waitFor();
      for (const [index, step] of state.workflow.definition.steps.entries()) {
        const inspector = await assertConfiguration(viewer, index + 1, step);
        if (['find-rows', 'create-row', 'update-row'].includes(step.kind))
          await inspector.getByText('Invoices', { exact: true }).first().waitFor();
      }
      const referenceInspector = await assertConfiguration(viewer, 5, state.workflow.definition.steps[4]);
      await referenceInspector.getByRole('button', { name: 'Prepare data', exact: true }).click();
      await viewer
        .getByRole('region', { name: 'Step details', exact: true })
        .getByRole('heading', { name: 'Prepare data', exact: true })
        .waitFor();
      const gated = await assertConfiguration(viewer, 6, state.workflow.definition.steps[5]);
      await gated.getByRole('heading', { name: 'Runs only when', exact: true }).waitFor();
      await gated.getByText('Yes', { exact: true }).waitFor();
      await capture('after-inspector');

      state.tableStatus = 503;
      await viewer.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
      await viewer
        .getByText('Some names could not refresh. Refresh the workflow to check them again.', { exact: true })
        .waitFor();
      await assertConfiguration(viewer, 5, state.workflow.definition.steps[4]);
      state.tableStatus = 404;
      await viewer.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
      await viewer.getByText(/Table.*names are unavailable with your access/).waitFor();
      const unavailable = await assertConfiguration(viewer, 2, state.workflow.definition.steps[1]);
      await unavailable.getByText('Table name unavailable', { exact: true }).first().waitFor();
      state.tableStatus = 200;
      await viewer.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
      await unavailable.getByText('Invoices', { exact: true }).first().waitFor();
      state.definitionStatus = 503;
      await viewer.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
      await viewer
        .getByText('Refresh failed. This is the last checked view, not the latest state.', { exact: false })
        .waitFor();
      await assertConfiguration(viewer, 11, state.workflow.definition.steps[10]);
      state.definitionStatus = 404;
      await viewer.getByRole('button', { name: 'Refresh workflow', exact: true }).click();
      await page.getByRole('heading', { name: 'Workflow unavailable', exact: true }).waitFor();
      assert.equal(await viewer.count(), 0);
      state.definitionStatus = 200;
      await page.getByRole('button', { name: 'Retry loading workflow', exact: true }).click();
      viewer = await openWorkflow(page, state.workflow);
      await page.setViewportSize({ width: 375, height: 850 });
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await assertConfiguration(viewer, 5, state.workflow.definition.steps[4]);
      const step = viewer.getByRole('list', { name: 'Workflow steps', exact: true }).getByRole('button').nth(5);
      await step.focus();
      await page.keyboard.press('Enter');
      assert.equal(await step.getAttribute('aria-pressed'), 'true');
      await capture('after-mobile-dark');
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'narrow inspector has no horizontal overflow',
      );
      assert.deepEqual(state.writes, []);
      assert.equal(state.historyReads, 0, 'definition reads must not fetch private run output as picker hints');
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      vite?.kill('SIGTERM');
    }
  },
);
