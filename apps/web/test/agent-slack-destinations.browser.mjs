import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { shellRead } from './shell-reads.mjs';

const port = Number(process.env.AGENT_SLACK_BROWSER_PORT ?? 5262);
const origin = `http://127.0.0.1:${port}`;
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-09-30T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const engineering = '33333333-3333-4333-8333-333333333333';
const agentId = '66666666-6666-4666-8666-666666666666';
const membershipId = '88888888-8888-4888-8888-888888888888';
const teams = [{ id: engineering, name: 'Engineering' }];
const destination = {
  id: '99999999-9999-4999-8999-999999999999',
  name: 'Escalations',
  channel: 'C0ESCALATE',
  version: 1,
  permissions: ['slack.message.send'],
};
const detail = {
  id: agentId,
  name: 'Customer reviewer',
  owningTeamId: engineering,
  savedRevision: 'a'.repeat(40),
  definitionRevision: 'b'.repeat(64),
  definition: { name: 'Customer reviewer', instructions: 'Review customer requests.', tools: ['schema.inspect'] },
  capabilities: ['read', 'edit', 'invoke', 'delete', 'manage'],
  admin: true,
  activations: [],
};
const policy = {
  version: 1,
  owningTeamId: engineering,
  grants: [],
  personGrants: [{ membershipId, permissions: ['manage'] }],
  enrollment: [engineering],
  enabled: false,
  limits: [],
};

test(
  'Slack destinations show their own loading, unavailable, error, empty, and refresh states',
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
        try {
          if ((await fetch(origin)).ok) break;
        } catch {}
        assert.ok(attempt < 150 && server.exitCode === null, 'Slack destinations browser server must start');
        await delay(100);
      }
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(60000);
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      // Hold the first read until loading is observed; the agent page can start it before the Execution tab renders.
      let destinations = { status: 404, hold: true };
      let release = () => {};
      await page.route('**/v1/**', async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        let json;
        if (path === '/v1/auth/get-session')
          json = {
            session: { id: 'session-ada', userId: 'ada' },
            user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
          };
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === '/v1/workspaces/acme') json = workspace;
        else if (path.endsWith('/credits'))
          json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
        else if (path.endsWith('/governance/me'))
          json = { membershipId, role: 'admin', teams, capabilities: { manageGovernance: true, canLeave: true } };
        else if (path.endsWith('/agents/sharing-candidates'))
          json = {
            membershipId,
            people: [{ membershipId, userId: 'ada', name: 'Ada', email: 'ada@example.com' }],
            teams,
          };
        else if (path.endsWith('/agents/authoring-context'))
          json = { currentSoulRevision: 'a'.repeat(40), teams, admin: true };
        else if (path.endsWith(`/agents/${agentId}`)) json = detail;
        else if (path.endsWith(`/agents/${agentId}/policy`)) json = policy;
        else if (path.endsWith(`/agents/${agentId}/schedules`)) json = [];
        else if (path.endsWith(`/agents/${agentId}/chat`)) json = { configured: true };
        // No unfinished setup: cloud pages/agents.tsx:190 treats only this code as an empty draft (3e124b0f #1004).
        else if (path.endsWith(`/agents/${agentId}/setup-draft`))
          return route.fulfill({ status: 404, json: { error: 'setup-draft-not-found' } });
        else if (path.endsWith('/tables')) json = { tables: [], nextCursor: null };
        else if (path.endsWith('/slack/destinations')) {
          const current = destinations;
          if (current.hold)
            await new Promise(resolve => {
              release = resolve;
            });
          if (current.delay) await delay(current.delay);
          if (current.status !== 200) return route.fulfill({ status: current.status, json: { error: 'unavailable' } });
          json = { destinations: current.items };
        } else if (shellRead(request.method(), path, workspace))
          return route.fulfill(shellRead(request.method(), path, workspace));
        else return route.fulfill({ status: 404, json: { error: 'unavailable' } });
        await route.fulfill({ json });
      });

      await page.goto(`${origin}/acme/agents/${agentId}`);
      await page.getByRole('heading', { name: 'Customer reviewer', exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Execution', exact: true }).click();
      const execution = page.getByRole('region', { name: 'Execution', exact: true });
      const slack = page.getByRole('region', { name: 'Slack destinations', exact: true });
      const addDestination = slack.getByRole('button', { name: 'Add Slack destination', exact: true });

      await slack.getByRole('status', { name: 'Loading Slack destinations', exact: true }).waitFor();
      assert.equal(
        await slack.getByText('No Slack destinations', { exact: true }).count(),
        0,
        'empty never flashes while loading',
      );
      release();

      await slack.getByRole('heading', { name: 'Slack destinations unavailable', exact: true }).waitFor();
      assert.equal(
        await page.getByText('Agent unavailable', { exact: true }).count(),
        0,
        'a Slack read failure is not reported as the agent being unavailable',
      );
      assert.equal(await addDestination.count(), 0, 'the destination form is replaced while Slack is unavailable');
      assert.equal(await slack.getByRole('combobox', { name: 'Destination team', exact: true }).count(), 0);
      assert.equal(
        await slack.getByRole('link', { name: 'Open Integrations', exact: true }).getAttribute('href'),
        '/acme/integrations',
      );
      await execution.getByRole('button', { name: 'Save execution settings', exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Access', exact: true }).click();
      await page
        .getByRole('region', { name: 'Team enrollment', exact: true })
        .getByRole('button', { name: 'Save enrollment', exact: true })
        .waitFor();
      await page.getByRole('tab', { name: 'Execution', exact: true }).click();

      destinations = { status: 503 };
      await slack.getByRole('button', { name: 'Check Slack access again', exact: true }).click();
      await slack.getByRole('heading', { name: 'Couldn’t load Slack destinations', exact: true }).waitFor();
      assert.equal(
        await slack.getByRole('alert').getByText('Couldn’t load Slack destinations', { exact: true }).count(),
        1,
        'the load failure is announced',
      );
      assert.equal(
        await slack.evaluate(node => node.contains(document.activeElement)),
        true,
        'focus stays in the section after the retry replaces its control',
      );
      assert.equal(await page.getByText('Could not load agents', { exact: true }).count(), 0);
      assert.equal(await addDestination.count(), 0, 'the destination form is replaced while destinations cannot load');

      destinations = { status: 200, items: [], hold: true };
      await slack.getByRole('button', { name: 'Reload Slack destinations', exact: true }).click();
      await slack.getByRole('status', { name: 'Loading Slack destinations', exact: true }).waitFor();
      assert.equal(
        await slack.getByText('No Slack destinations', { exact: true }).count(),
        0,
        'empty never flashes while retrying',
      );
      release();
      await slack.getByText('No Slack destinations', { exact: true }).waitFor();
      await addDestination.waitFor();

      destinations = { status: 200, items: [], hold: true };
      await slack.getByRole('button', { name: 'Reload Slack destinations', exact: true }).click();
      const reloading = slack.getByRole('button', { name: 'Reloading Slack destinations…', exact: true });
      await reloading.waitFor();
      assert.equal(await reloading.getAttribute('aria-disabled'), 'true');
      assert.equal(
        await slack.getByText('No Slack destinations', { exact: true }).count(),
        1,
        'a reload keeps the loaded content',
      );
      release();
      await slack.getByRole('button', { name: 'Reload Slack destinations', exact: true }).waitFor();

      destinations = { status: 200, items: [destination] };
      await slack.getByRole('button', { name: 'Reload Slack destinations', exact: true }).click();
      await slack.getByText('Escalations', { exact: true }).waitFor();
      await slack.getByLabel('Destination name', { exact: true }).fill('Sales alerts');

      destinations = { status: 503 };
      await slack.getByRole('button', { name: 'Reload Slack destinations', exact: true }).click();
      await slack
        .getByText('We couldn’t refresh Slack destinations. Showing the last loaded list.', { exact: true })
        .waitFor();
      assert.equal(
        await slack.getByText('Escalations', { exact: true }).count(),
        1,
        'a failed refresh keeps the last loaded list',
      );
      assert.equal(
        await slack.getByLabel('Destination name', { exact: true }).inputValue(),
        'Sales alerts',
        'a failed refresh keeps the draft',
      );

      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        'passed: Slack destinations loading, unavailable, error, retry busy, empty, success, and refresh failure stay inside their section.',
      );
    } finally {
      await browser?.close();
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
  },
);
