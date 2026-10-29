import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

const origin = 'http://127.0.0.1:5493';
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5493', '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
const { workspace, session } = createWorkspaceFixture();
const id = '11111111-1111-4111-8111-111111111111';
let browser;
try {
  for (
    let i = 0;
    !(await fetch(origin).then(
      r => r.ok,
      () => false,
    ));
    i++
  ) {
    assert.ok(i < 100);
    await delay(100);
  }
  browser = await chromium.launch();
  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      colorScheme: mobile ? 'dark' : 'light',
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const task = {
      id,
      agentId: id,
      activationId: id,
      definitionRevision: 'a'.repeat(64),
      parentTaskId: null,
      delegationDepth: 0,
      skills: [],
      scope: [],
      limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
      flowId: id,
      generation: 0,
      status: 'pending',
      activeMilliseconds: '100',
      toolCalls: 1,
      createdAt: new Date().toISOString(),
      cost: { chargedCreditUnits: '0', heldCreditUnits: '0' },
      activity: [
        {
          id,
          tool: 'github.personal.read',
          status: 'running',
          presentation: { label: 'Search GitHub issues', brand: 'github' },
        },
      ],
    };
    const run = {
      id,
      workflowId: id,
      revision: id,
      status: 'running',
      source: 'manual',
      input: {},
      createdAt: new Date().toISOString(),
      error: null,
      steps: [{ stepId: 'review', ordinal: 0, status: 'waiting', output: null, prompt: 'Review the request' }],
    };
    await page.route('**/v1/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let json;
      if (path === '/v1/auth/get-session') json = session;
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
      else if (path.endsWith('/governance/me')) json = membership;
      else if (path.endsWith('/credits')) json = credits;
      else if (path.endsWith(`/agent-tasks/${id}`)) json = task;
      else if (path.endsWith('/history'))
        json = {
          messages: [
            {
              sequence: 0,
              generation: 0,
              role: 'owner',
              text: 'Find the issues',
              sources: [],
              createdAt: task.createdAt,
            },
          ],
          nextCursor: null,
        };
      else if (path.endsWith('/proposals')) json = { proposals: [], nextCursor: null };
      else if (path.endsWith('/batches')) json = { batches: [] };
      else if (path.endsWith('/actions')) json = { actions: [] };
      else if (path.endsWith('/accounts')) json = { configured: true, accounts: [] };
      else if (path.endsWith('/selection')) json = { accountId: null, generation: null, version: 0 };
      else if (path.endsWith('/workflows'))
        json = [
          {
            id,
            revision: id,
            activeRevision: id,
            enabled: true,
            generation: 1,
            nextRunAt: null,
            activeTrigger: { kind: 'manual' },
            webhookConfigured: false,
            definition: {
              version: 1,
              name: 'Review request',
              trigger: { kind: 'manual' },
              steps: [{ id: 'review', kind: 'human', prompt: 'Review the request', timeoutSeconds: 3600 }],
            },
          },
        ];
      else if (path.endsWith('/runs')) json = { runs: [run], nextCursor: null };
      else return route.fulfill({ status: 404, json: { error: 'not-found' } });
      return route.fulfill({ json });
    });
    await page.goto(`${origin}/${workspace.slug}/agent-tasks/${id}`);
    // Cloud 51d9a255 (#1053) shows task actions as an Activity result card whose details open on request (pages/agent-tasks.tsx:84,
    // features/chat/activity-result-card.tsx:20-30) instead of an inline tool list.
    const card = page.getByRole('region', { name: 'Activity: Task actions', exact: true });
    await card.getByRole('status').getByText('Actions in progress', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-slot="tool-activity"]').count(), 0, 'details stay closed until requested');
    task.activity[0].status = 'completed';
    task.status = 'completed';
    await card.getByRole('status').getByText('1 of 1 actions completed', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'View activity', exact: true }).click();
    const details = page.getByRole('button', { name: 'Activity details', exact: true });
    await details.click();
    await page.locator('[data-slot="tool-activity"]').getByText('Search GitHub issues', { exact: true }).waitFor();
    if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
    await page.goto(`${origin}/${workspace.slug}/workflows`);
    await page.getByText('Review request', { exact: true }).first().click();
    await page.getByRole('tab', { name: 'Runs', exact: true }).click();
    const history = page.getByRole('region', { name: 'Run history', exact: true });
    // Cloud 4a3eb8e3 (#1021) moved live run progress to the run diagram; run history lists steps in a closed disclosure with
    // "step / status" lines (pages/workflows.tsx:183,190).
    await history.getByRole('status').getByText('Running workflow', { exact: true }).waitFor();
    assert.equal(
      await history.getByRole('button', { name: '1 workflow steps', exact: true }).getAttribute('aria-expanded'),
      'false',
    );
    run.status = 'completed';
    run.steps[0].status = 'completed';
    await history.getByRole('status').getByText('Completed', { exact: true }).waitFor();
    await history.getByRole('button', { name: '1 workflow steps', exact: true }).click();
    await history.getByText('review / Completed', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS task tool progress and workflow progress/collapse on desktop light and mobile dark.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
