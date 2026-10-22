import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { shellRead } from './shell-reads.mjs';

const port = Number(process.env.AGENT_ADMIN_BROWSER_PORT ?? 5261);
const origin = `http://127.0.0.1:${port}`;
const shots = process.env.AGENT_ADMIN_SCREENSHOT_DIR;
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-09-30T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const maximumTaskLimits = { toolCalls: 1000, activeMilliseconds: 3600000, credits: 10000 };
const engineering = '33333333-3333-4333-8333-333333333333';
const support = '44444444-4444-4444-8444-444444444444';
const tableId = '55555555-5555-4555-8555-555555555555';
const agentId = '66666666-6666-4666-8666-666666666666';
const activationId = '77777777-7777-4777-8777-777777777777';
const destination = {
  id: '99999999-9999-4999-8999-999999999999',
  name: 'Escalations',
  channel: 'C0ESCALATE',
  version: 1,
  permissions: ['slack.message.send'],
};
const teams = [
  { id: engineering, name: 'Engineering' },
  { id: support, name: 'Support' },
];
const membershipId = '88888888-8888-4888-8888-888888888888';
const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resource = {
  id: tableId,
  revision: 'a'.repeat(40),
  definition: {
    formatVersion: 2,
    id: tableId,
    owningTeamId: engineering,
    label: 'Customers',
    fields: [],
    uniqueKeys: [],
  },
};
const limits = [{ assetId: tableId, permissions: ['table.row.read'] }];
const widened = [{ assetId: tableId, permissions: ['table.row.read', 'table.row.update'] }];
const detail = {
  id: agentId,
  name: 'Customer reviewer',
  owningTeamId: engineering,
  savedRevision: 'a'.repeat(40),
  definitionRevision: 'b'.repeat(64),
  definition: {
    name: 'Customer reviewer',
    instructions: 'Review customer requests.',
    tools: ['schema.inspect', 'rows.list'],
  },
  capabilities: ['read', 'edit', 'invoke', 'delete', 'manage'],
  admin: true,
  activations: [{ id: activationId, revision: 'b'.repeat(64), scope: limits }],
};

const describedTexts = locator =>
  locator.evaluate(node =>
    (node.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter(Boolean)
      .map(id => document.getElementById(id)?.textContent ?? null),
  );
const isFocused = locator => locator.evaluate(node => node === document.activeElement);

async function eventually(read, expected) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      assert.deepEqual(await read(), expected);
      return;
    } catch {
      await delay(50);
    }
  }
  assert.deepEqual(await read(), expected);
}

test(
  'agent administration saves one section at a time and explains every blocked action',
  { timeout: 240000 },
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
        assert.ok(attempt < 150 && server.exitCode === null, 'Agent administration browser server must start');
        await delay(100);
      }
      if (shots) await mkdir(shots, { recursive: true });
      browser = await chromium.launch({ headless: true });
      for (const device of [
        { name: 'desktop', viewport: { width: 1440, height: 1000 }, theme: 'light' },
        { name: 'mobile', viewport: { width: 390, height: 844 }, theme: 'dark' },
      ]) {
        const mobile = device.name === 'mobile';
        const context = await browser.newContext({
          viewport: device.viewport,
          isMobile: mobile,
          hasTouch: mobile,
          reducedMotion: 'reduce',
          colorScheme: device.theme,
        });
        const page = await context.newPage();
        // Bud's labelled launcher sits bottom-right over the section save buttons; move it as a user would by dragging.
        await page.addInitScript(() => localStorage.setItem('tulipfarm:bud-corner', 'bottom-left'));
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(60000);
        const choose = async (target, label, option) => {
          await target.getByLabel(label, { exact: true }).click();
          await page.getByRole('option', { name: option, exact: true }).click();
        };
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        // Chromium logs every non-2xx response; each must be a failure this mock served on purpose.
        const failedLoads = [];
        const servedFailures = [];
        page.on('console', message => {
          if (message.type() !== 'error' || message.text().startsWith('Failed to load table')) return;
          const failedLoad = /^Failed to load resource: the server responded with a status of (\d+)/.exec(
            message.text(),
          );
          if (failedLoad) failedLoads.push(Number(failedLoad[1]));
          else errors.push(message.text());
        });
        const policy = {
          version: 1,
          owningTeamId: engineering,
          grants: [{ teamId: engineering, permissions: ['edit', 'invoke', 'read'] }],
          personGrants: [{ membershipId, permissions: ['manage'] }],
          enrollment: [engineering],
          enabled: false,
          limits,
        };
        const configureWrites = [];
        const policyWrites = [];
        let failPolicy = false;
        const destinationWrites = [];
        const activationWrites = [];
        let failConfigure = false;
        const scheduleWrites = [];
        let scheduleList = [];
        let rejectSchedule = true;
        await page.route('**/v1/**', async route => {
          const request = route.request();
          const fulfill = response => {
            if (response.status >= 400) servedFailures.push(response.status);
            return route.fulfill(response);
          };
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
          else if (path.endsWith(`/agents/${agentId}/policy`) && request.method() === 'PUT') {
            policyWrites.push(request.postDataJSON());
            if (failPolicy) {
              failPolicy = false;
              Object.assign(policy, { version: policy.version + 1, owningTeamId: support });
              return fulfill({ status: 409, json: { error: 'policy-version-conflict' } });
            }
            Object.assign(policy, { ...request.postDataJSON(), version: policy.version + 1 });
            json = { saved: true };
          } else if (path.endsWith(`/agents/${agentId}/policy`)) json = policy;
          else if (path.endsWith(`/agents/${agentId}/enrollment`)) {
            const body = request.postDataJSON();
            configureWrites.push(body);
            if (failConfigure) {
              failConfigure = false;
              return fulfill({ status: 500, json: { error: 'unavailable' } });
            }
            Object.assign(policy, {
              version: body.version + 1,
              enrollment: body.teamIds,
              limits: body.limits,
              enabled: body.enabled,
            });
            json = { saved: true };
          } else if (path.endsWith(`/agents/${agentId}/activations`)) {
            activationWrites.push(request.postDataJSON());
            return fulfill({ status: 500, json: { error: 'unexpected write' } });
          } else if (path.endsWith(`/agents/${agentId}/schedules`) && request.method() === 'PUT') {
            const body = request.postDataJSON();
            if (rejectSchedule) {
              rejectSchedule = false;
              return fulfill({ status: 400, json: { error: 'task-schedule-interval' } });
            }
            scheduleWrites.push(body);
            scheduleList = [
              {
                ...body,
                revision: 'b'.repeat(64),
                nextRunAt: '2026-10-10T09:00:00Z',
                revoked: false,
                enabled: true,
                paused: false,
                pauseReason: null,
                lastRun: { kind: 'task', taskId, status: 'waiting-approval' },
              },
            ];
            json = { saved: true };
          } else if (path.endsWith(`/agents/${agentId}/schedules`)) json = scheduleList;
          else if (path.endsWith(`/agents/${agentId}/chat`)) json = { configured: true };
          else if (path.endsWith('/slack/destinations')) {
            if (request.method() === 'PUT') {
              destinationWrites.push(request.postDataJSON());
              return fulfill({ status: 503, json: { error: 'unavailable' } });
            }
            json = { destinations: [destination] };
          } else if (path.endsWith('/tables'))
            json = { tables: [{ ...resource, appliedAt: null, recordCount: '0' }], nextCursor: null };
          else if (shellRead(request.method(), path, workspace))
            return fulfill(shellRead(request.method(), path, workspace));
          else return fulfill({ status: 404, json: { error: 'unavailable' } });
          await route.fulfill({ json });
        });

        await page.goto(`${origin}/acme/agents/${agentId}`);
        await page.getByRole('heading', { name: 'Customer reviewer', exact: true }).waitFor();
        const openTab = name => page.getByRole('tab', { name, exact: true }).click();
        await page.getByText('Execution off', { exact: true }).waitFor();
        await page
          .getByRole('list', { name: 'Setup steps', exact: true })
          .getByRole('button', { name: 'Go to Enable execution', exact: true })
          .click();
        await eventually(
          () => page.getByRole('tab', { name: 'Execution', exact: true }).getAttribute('aria-selected'),
          'true',
        );
        await eventually(() => isFocused(page.getByRole('checkbox', { name: 'Enable execution', exact: true })), true);
        await openTab('Access');
        const ownership = page.getByRole('region', { name: 'Placement and sharing', exact: true });
        const enrollment = page.getByRole('region', { name: 'Team enrollment', exact: true });
        const execution = page.getByRole('region', { name: 'Execution', exact: true });
        const slack = page.getByRole('region', { name: 'Slack destinations', exact: true });
        const activations = page.getByRole('region', { name: 'Agent activations', exact: true });
        await ownership.waitFor();

        assert.deepEqual(
          await describedTexts(ownership.getByRole('combobox', { name: 'Team placement', exact: true })),
          ['Placement grants no access. Share the agent below to grant access.', 'Optional'],
        );
        assert.equal(await page.getByText(/Unsaved administration changes|Showing saved administration/).count(), 0);
        const sharing = ownership.getByRole('region', { name: 'Definition sharing', exact: true });
        const row = name =>
          sharing
            .locator('div')
            .filter({ has: page.getByText(name, { exact: true }) })
            .filter({ has: page.getByRole('checkbox', { name: 'invoke', exact: true }) })
            .last();
        const engineeringAccess = row('Engineering');
        await engineeringAccess.waitFor();
        assert.deepEqual(
          await Promise.all(
            ['read', 'edit', 'delete', 'invoke'].map(name =>
              engineeringAccess.getByRole('checkbox', { name, exact: true }).getAttribute('aria-checked'),
            ),
          ),
          ['true', 'true', 'false', 'true'],
        );
        const supportAccess = row('Support');
        await supportAccess.getByRole('checkbox', { name: 'edit', exact: true }).click();
        await eventually(
          () => supportAccess.getByRole('checkbox', { name: 'read', exact: true }).getAttribute('aria-checked'),
          'true',
        );
        assert.equal(
          await supportAccess.getByRole('checkbox', { name: 'edit', exact: true }).getAttribute('aria-checked'),
          'true',
        );
        await ownership.getByText('Unsaved changes', { exact: true }).waitFor();
        assert.equal(await enrollment.getByText('Unsaved changes', { exact: true }).count(), 0);

        await openTab('Execution');
        const activate = activations.getByRole('button', { name: 'Activate saved instructions', exact: true });
        await eventually(
          () => describedTexts(activate),
          ['Turn on Enable execution and save execution settings first.'],
        );
        assert.equal(await activate.getAttribute('aria-disabled'), 'true');
        await activate.click({ force: true });
        await delay(100);
        assert.deepEqual(activationWrites, []);
        await activations.getByRole('button', { name: 'Go to Enable execution', exact: true }).click();
        const enableExecution = execution.getByRole('checkbox', { name: 'Enable execution', exact: true });
        await eventually(() => isFocused(enableExecution), true);
        assert.equal(await enableExecution.getAttribute('aria-checked'), 'false');

        const destinationTeam = slack.getByRole('combobox', { name: 'Destination team', exact: true });
        await slack.getByText('Escalations', { exact: true }).waitFor();
        const revokeDestination = slack.getByRole('button', { name: 'Revoke destination', exact: true });
        assert.equal(await revokeDestination.getAttribute('aria-disabled'), 'true');
        assert.deepEqual(await describedTexts(revokeDestination), ['Choose a destination team below first.']);
        assert.equal(
          await slack.getByRole('button', { name: 'Add Escalations to execution limits', exact: true }).isDisabled(),
          false,
        );
        await slack.getByRole('button', { name: 'Choose a team', exact: true }).click();
        await eventually(() => isFocused(destinationTeam), true);
        await page.keyboard.press('Tab');

        await slack.getByRole('button', { name: 'Add Slack destination', exact: true }).click();
        await eventually(() => describedTexts(destinationTeam), ['Choose a team for this channel.']);
        assert.deepEqual(await describedTexts(slack.getByLabel('Destination name', { exact: true })), [
          'Enter a name for this destination.',
        ]);
        assert.deepEqual(await describedTexts(slack.getByLabel('Channel ID', { exact: true })), [
          'Enter a channel ID that starts with C or G.',
        ]);
        assert.equal(await slack.getByRole('alert').textContent(), 'Fix 3 fields to add the destination.');
        await eventually(() => isFocused(destinationTeam), true);
        assert.equal(await slack.getByText('Unsaved changes', { exact: true }).count(), 0);
        await slack.getByLabel('Destination name', { exact: true }).fill('Sales alerts');
        await eventually(() => describedTexts(slack.getByLabel('Destination name', { exact: true })), []);
        await slack.getByText('Unsaved changes', { exact: true }).waitFor();
        assert.deepEqual(destinationWrites, []);

        await choose(execution, 'Add table read limit', 'Customers · Engineering · 55555555');
        const tablePermissions = execution.getByRole('group', { name: 'Permissions for this table', exact: true });
        const readRecords = tablePermissions.getByRole('checkbox', { name: 'Read rows', exact: true });
        assert.equal(await readRecords.getAttribute('aria-checked'), 'true');
        assert.equal(await readRecords.isDisabled(), true);
        await tablePermissions.getByRole('checkbox', { name: 'Update rows', exact: true }).click();
        await execution.getByText('Unsaved changes', { exact: true }).waitFor();

        assert.equal(
          await page
            .locator('[data-slot="page-content"]')
            .locator('..')
            .evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)),
          true,
          'the administration area fits the viewport',
        );
        if (shots) {
          const height = await page
            .getByRole('tabpanel')
            .evaluate(node => Math.ceil(node.getBoundingClientRect().height) + 400);
          await page.setViewportSize({ width: device.viewport.width, height });
          for (const theme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: theme });
            await page.evaluate(() => document.fonts.ready);
            await page.getByRole('tabpanel').screenshot({
              path: `${shots}/administration-${device.viewport.width}-${theme}.png`,
              animations: 'disabled',
            });
          }
          await page.emulateMedia({ colorScheme: device.theme });
          await page.setViewportSize(device.viewport);
        }

        await openTab('Access');
        await enrollment.getByRole('checkbox', { name: 'Support', exact: true }).click();
        await enrollment.getByText('Unsaved changes', { exact: true }).waitFor();
        await openTab('Execution');
        await execution.getByRole('button', { name: 'Save execution settings', exact: true }).click();
        await execution.getByText('Administration saved.', { exact: true }).waitFor();
        assert.equal(await page.getByText('Administration saved.', { exact: true }).count(), 1);
        // Cloud administration.ts:23,33 (3e124b0f #1004) sends task limits (schema default maximumTaskLimits) and the Slack sender.
        assert.deepEqual(configureWrites, [
          {
            version: 1,
            teamIds: [engineering],
            limits: widened,
            taskLimits: maximumTaskLimits,
            enabled: false,
            slackSender: 'user',
          },
        ]);
        assert.equal(
          await execution.getByRole('group', { name: 'Permissions for this table', exact: true }).count(),
          0,
        );
        await openTab('Access');
        await enrollment.getByText('Unsaved changes', { exact: true }).waitFor();
        assert.equal(
          await enrollment.getByRole('checkbox', { name: 'Support', exact: true }).getAttribute('aria-checked'),
          'true',
        );
        assert.equal(await execution.getByText('Unsaved changes', { exact: true }).count(), 0);
        await ownership.getByText('Unsaved changes', { exact: true }).waitFor();

        await ownership.getByRole('button', { name: 'Discard changes', exact: true }).click();
        await eventually(
          () => supportAccess.getByRole('checkbox', { name: 'edit', exact: true }).getAttribute('aria-checked'),
          'false',
        );
        assert.equal(await ownership.getByText('Unsaved changes', { exact: true }).count(), 0);
        assert.equal(await enrollment.getByText('Unsaved changes', { exact: true }).count(), 1);

        failConfigure = true;
        const saveEnrollment = enrollment.getByRole('button', { name: 'Save enrollment', exact: true });
        await saveEnrollment.click();
        const review = page.getByRole('region', { name: 'Review agent administration', exact: true });
        await review.waitFor();
        assert.deepEqual(configureWrites.at(-1), {
          version: 2,
          teamIds: [engineering, support],
          limits: widened,
          taskLimits: maximumTaskLimits,
          enabled: false,
        });
        assert.equal(
          await review
            .getByText(
              'We could not confirm your last change. Your draft is kept; refresh administration, then choose which settings to use.',
              { exact: true },
            )
            .count(),
          1,
        );
        assert.equal(await saveEnrollment.getAttribute('aria-disabled'), 'true');
        assert.deepEqual(await describedTexts(saveEnrollment), ['Check whether the last change went through first.']);
        const keepDraft = review.getByRole('button', { name: 'Keep my draft against this version', exact: true });
        assert.equal(await keepDraft.getAttribute('aria-disabled'), 'true');
        assert.deepEqual(await describedTexts(keepDraft), ['Refresh administration to load the latest settings.']);
        if (shots)
          for (const theme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: theme });
            await page
              .locator('#agent-admin-review')
              .screenshot({ path: `${shots}/review-${device.viewport.width}-${theme}.png`, animations: 'disabled' });
          }
        await page.emulateMedia({ colorScheme: device.theme });
        await review.getByRole('button', { name: 'Refresh administration', exact: true }).click();
        await eventually(() => keepDraft.isDisabled(), false);
        await keepDraft.click();
        await review.waitFor({ state: 'detached' });
        await eventually(() => saveEnrollment.isDisabled(), false);
        await enrollment.getByText('Unsaved changes', { exact: true }).waitFor();
        await saveEnrollment.click();
        await enrollment.getByText('Administration saved.', { exact: true }).waitFor();
        assert.deepEqual(configureWrites.at(-1), {
          version: 2,
          teamIds: [engineering, support],
          limits: widened,
          taskLimits: maximumTaskLimits,
          enabled: false,
        });
        assert.equal(await enrollment.getByText('Unsaved changes', { exact: true }).count(), 0);

        await supportAccess.getByRole('checkbox', { name: 'invoke', exact: true }).click();
        failPolicy = true;
        const saveOwnership = ownership.getByRole('button', { name: 'Save sharing', exact: true });
        await saveOwnership.click();
        await review.waitFor();
        assert.deepEqual(policyWrites, [
          {
            version: 3,
            owningTeamId: engineering,
            grants: [
              { teamId: engineering, permissions: ['edit', 'invoke', 'read'] },
              { teamId: support, permissions: ['invoke', 'read'] },
            ],
            personGrants: [{ membershipId, permissions: ['manage'] }],
          },
        ]);
        await eventually(() => describedTexts(saveOwnership), ['Choose which settings to keep above first.']);
        assert.equal(
          await review
            .getByText(
              'Your last change was not saved. Your draft is kept; refresh administration, then choose which settings to use.',
              { exact: true },
            )
            .count(),
          1,
        );
        await ownership.getByRole('button', { name: 'Go to review', exact: true }).click();
        await eventually(() => isFocused(keepDraft), true);
        await review.getByRole('button', { name: 'Refresh administration', exact: true }).click();
        const useCurrent = review.getByRole('button', { name: 'Use current administration', exact: true });
        await eventually(() => useCurrent.isDisabled(), false);
        assert.equal(
          await review
            .getByText('Newer settings were saved. Your draft is kept; choose which settings to use.', { exact: true })
            .count(),
          1,
        );
        await useCurrent.click();
        await review.waitFor({ state: 'detached' });
        assert.equal(
          await ownership
            .getByRole('combobox', { name: 'Team placement', exact: true })
            .locator('[data-slot="select-value"]')
            .textContent(),
          'Support',
        );
        assert.equal(
          await supportAccess.getByRole('checkbox', { name: 'invoke', exact: true }).getAttribute('aria-checked'),
          'false',
        );
        assert.equal(await ownership.getByText('Unsaved changes', { exact: true }).count(), 0);
        await eventually(() => saveOwnership.isDisabled(), false);

        await openTab('Execution');
        await slack.getByRole('combobox', { name: 'Destination team', exact: true }).click();
        await page.getByRole('option', { name: 'Support', exact: true }).click();
        await slack.getByLabel('Destination name', { exact: true }).fill('Sales alerts');
        await slack.getByLabel('Channel ID', { exact: true }).fill('C0SALES');
        const addDestination = slack.getByRole('button', { name: 'Add Slack destination', exact: true });
        await addDestination.click();
        await slack.getByRole('button', { name: 'Retry same operation', exact: true }).waitFor();
        assert.deepEqual(
          destinationWrites.map(({ id: _id, ...write }) => write),
          [{ channel: 'C0SALES', name: 'Sales alerts', teamId: support, expectedVersion: 0, enabled: true }],
        );
        assert.equal(await addDestination.getAttribute('aria-disabled'), 'true');
        assert.deepEqual(await describedTexts(addDestination), ['Check whether the last change went through first.']);
        await slack.getByRole('button', { name: 'Check status again', exact: true }).click();
        await eventually(() => addDestination.isDisabled(), false);
        assert.equal(await addDestination.getAttribute('aria-describedby'), null);
        assert.equal(destinationWrites.length, 1);

        await openTab('Triggers');
        const schedules = page.getByRole('region', { name: 'Agent schedules', exact: true });
        await schedules.getByRole('heading', { name: 'No schedules yet', exact: true }).waitFor();
        assert.equal(
          await schedules.getByRole('radio', { name: 'Run a saved prompt', exact: true }).getAttribute('aria-checked'),
          'true',
        );
        assert.equal(await schedules.getByRole('group', { name: 'Who can see results', exact: true }).count(), 0);
        await schedules.getByRole('button', { name: 'Create prompt schedule', exact: true }).click();
        assert.equal(await schedules.getByRole('alert').textContent(), 'Fix 3 fields to create the schedule.');
        await eventually(
          () => describedTexts(schedules.getByLabel('Prompt', { exact: true })),
          ['Write the prompt each run starts with.', '0 / 8,000'],
        );
        await schedules.getByLabel('Prompt', { exact: true }).fill('Summarize overdue invoices for the team.');
        await schedules.getByRole('button', { name: 'Calendar schedule', exact: true }).click();
        const timezone = schedules.getByRole('combobox', { name: 'Time zone', exact: true });
        await timezone.click();
        await page.getByRole('option', { name: 'Europe/Paris', exact: true }).click();
        assert.equal((await timezone.innerText()).trim(), 'Europe/Paris');
        await schedules.getByRole('button', { name: 'Repeat interval', exact: true }).click();
        await schedules.getByRole('combobox', { name: 'Instructions to run', exact: true }).click();
        await page.getByRole('option', { name: /77777777$/ }).click();
        await schedules.getByText('Data each run may use: Customers: read rows.', { exact: true }).waitFor();
        await schedules.getByLabel('Interval in minutes', { exact: true }).fill('30');
        await schedules
          .getByRole('checkbox', { name: 'I sponsor this schedule using my current permissions', exact: true })
          .click();
        await schedules.getByRole('button', { name: 'Create prompt schedule', exact: true }).click();
        await eventually(
          () => describedTexts(schedules.getByLabel('Interval in minutes', { exact: true })),
          ['Enter whole minutes from 60 to 10,080.'],
        );
        assert.deepEqual(scheduleWrites, []);
        await schedules.getByLabel('Interval in minutes', { exact: true }).fill('60');
        await schedules.getByRole('button', { name: 'Create prompt schedule', exact: true }).click();
        await schedules
          .getByText(
            'Prompt schedules run at most once an hour. Choose an hourly-or-longer interval or calendar expression. Your input is retained.',
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await schedules.getByLabel('Prompt', { exact: true }).inputValue(),
          'Summarize overdue invoices for the team.',
        );
        await schedules.getByRole('button', { name: 'Create prompt schedule', exact: true }).click();
        await schedules.getByText('Runs prompt: Summarize overdue invoices for the team.', { exact: true }).waitFor();
        assert.deepEqual(
          scheduleWrites.map(({ id: _id, ...write }) => write),
          [
            {
              activationId,
              action: {
                kind: 'task',
                text: 'Summarize overdue invoices for the team.',
                limits: { toolCalls: 100, credits: 100, activeMilliseconds: 300000 },
              },
              trigger: { kind: 'interval', minutes: 60 },
              sponsorMembershipId: membershipId,
              historyAudience: [],
            },
          ],
        );
        await schedules
          .getByText('Limits for each run: 100 tool calls, 100 credits, 300 seconds.', { exact: true })
          .waitFor();
        assert.equal(
          await schedules.getByRole('link', { name: 'Open last task', exact: true }).getAttribute('href'),
          `/acme/agent-tasks/${taskId}`,
        );
        assert.equal(await schedules.getByText('Last task: Needs your review', { exact: false }).count(), 1);
        assert.equal(await schedules.getByLabel('Prompt', { exact: true }).inputValue(), '');
        const sponsorTask = schedules.getByRole('button', { name: 'Sponsor this schedule', exact: true });
        assert.deepEqual(await describedTexts(sponsorTask), ['Check I sponsor this schedule above first.']);
        const interval = schedules.getByRole('form', { name: 'Change interval', exact: true });
        const saveInterval = interval.getByRole('button', { name: 'Save interval', exact: true });
        assert.equal(await interval.getByLabel('New interval in minutes', { exact: true }).inputValue(), '60');
        assert.deepEqual(await describedTexts(saveInterval), ['Check I sponsor this schedule above first.']);
        const consent = schedules.getByRole('checkbox', {
          name: 'I sponsor this schedule using my current permissions',
          exact: true,
        });
        await consent.click();
        await interval.getByLabel('New interval in minutes', { exact: true }).fill('30');
        await saveInterval.click();
        assert.equal(await interval.getByRole('alert').textContent(), 'Fix 1 field to change the interval.');
        await eventually(
          () => describedTexts(interval.getByLabel('New interval in minutes', { exact: true })),
          ['Enter whole minutes from 60 to 10,080.'],
        );
        assert.equal(scheduleWrites.length, 1);
        await interval.getByLabel('New interval in minutes', { exact: true }).fill('120');
        await saveInterval.click();
        await schedules.getByText('Scheduled every 120 minutes', { exact: true }).waitFor();
        assert.deepEqual(scheduleWrites[1], { ...scheduleWrites[0], trigger: { kind: 'interval', minutes: 120 } });
        assert.equal(await interval.getByLabel('New interval in minutes', { exact: true }).inputValue(), '120');
        await consent.click();
        scheduleList = [{ ...scheduleList[0], paused: true, pauseReason: 'sponsor-access-lost' }];
        await page.reload();
        await openTab('Triggers');
        await schedules.getByText('Paused, sponsor required every 120 minutes', { exact: true }).waitFor();
        await schedules
          .getByText('The sponsor no longer has access. Resume as sponsor using your current permissions.', {
            exact: true,
          })
          .waitFor();
        const resume = schedules.getByRole('button', { name: 'Resume as sponsor', exact: true });
        await schedules
          .getByRole('checkbox', { name: 'I sponsor this schedule using my current permissions', exact: true })
          .click();
        await resume.click();
        await schedules.getByText('Scheduled every 120 minutes', { exact: true }).waitFor();
        assert.deepEqual(scheduleWrites[2], scheduleWrites[1]);
        if (shots)
          await schedules.screenshot({
            path: `${shots}/schedules-${device.viewport.width}-${device.theme}.png`,
            animations: 'disabled',
          });
        await schedules.getByRole('radio', { name: 'Inspect a table', exact: true }).click();
        const inspect = schedules.getByRole('button', { name: 'Activate saved revision for inspection', exact: true });
        assert.deepEqual(await describedTexts(inspect), ['Choose a table to inspect first.']);
        await schedules.getByRole('button', { name: 'Choose a table', exact: true }).click();
        await eventually(() => isFocused(schedules.getByLabel('Table to inspect', { exact: true })), true);
        await schedules.getByRole('button', { name: 'Create inspection schedule', exact: true }).click();
        await eventually(
          () => describedTexts(schedules.getByLabel('Table to inspect', { exact: true })),
          ['Choose a table to inspect.'],
        );
        assert.deepEqual(
          await describedTexts(schedules.getByRole('combobox', { name: 'Instructions to run', exact: true })),
          ['Choose the instructions to run.'],
        );
        assert.deepEqual(
          await describedTexts(
            schedules.getByRole('checkbox', {
              name: 'I sponsor this schedule using my current permissions',
              exact: true,
            }),
          ),
          ['Confirm that you sponsor this schedule.'],
        );
        assert.equal(await schedules.getByRole('alert').textContent(), 'Fix 3 fields to create the schedule.');
        await choose(schedules, 'Table to inspect', 'Customers · Engineering · 55555555');
        assert.match(
          await schedules.getByLabel('Table to inspect', { exact: true }).textContent(),
          /Customers · Engineering · 55555555/,
        );
        await eventually(() => inspect.isDisabled(), false);

        assert.deepEqual(errors, []);
        assert.deepEqual(failedLoads.toSorted(), servedFailures.toSorted());
        await context.close();
        console.log(
          `${device.name} passed: per-section saves and unsaved state, read with any permission, blocked reasons with fixes, Slack validation without a request, review recovery after an unconfirmed save and a conflict.`,
        );
      }
    } finally {
      await browser?.close();
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
  },
);

test(
  'sponsor sees skipped task schedule capacity and recovery on desktop and mobile',
  { timeout: 120000 },
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
        assert.ok(attempt < 150 && server.exitCode === null, 'Schedule browser server must start');
        await delay(100);
      }
      browser = await chromium.launch({ headless: true });
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 390, height: 844 },
      ]) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        let lastRun = { kind: 'skipped', reason: 'task-limit' };
        const schedule = {
          id: crypto.randomUUID(),
          activationId,
          sponsorMembershipId: membershipId,
          historyAudience: [],
          action: {
            kind: 'task',
            text: 'Summarize overdue invoices.',
            limits: { toolCalls: 100, credits: 100, activeMilliseconds: 300000 },
          },
          trigger: { kind: 'interval', minutes: 60 },
          revision: 'b'.repeat(64),
          nextRunAt: '2026-10-10T09:00:00Z',
          revoked: false,
          enabled: true,
          paused: false,
          pauseReason: null,
        };
        await page.route('**/v1/**', async route => {
          const path = new URL(route.request().url()).pathname;
          let json;
          if (path === '/v1/auth/get-session')
            json = {
              session: { id: 'session-ada', userId: 'ada' },
              user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
            };
          else if (path === '/v1/workspaces') json = [workspace];
          else if (path === '/v1/workspaces/acme') json = workspace;
          else if (path.endsWith('/governance/me'))
            json = { membershipId, role: 'admin', teams, capabilities: { manageGovernance: true, canLeave: true } };
          else if (path.endsWith('/agents/sharing-candidates')) json = { membershipId, people: [], teams };
          else if (path.endsWith('/agents/authoring-context'))
            json = { currentSoulRevision: 'a'.repeat(40), teams, admin: true };
          else if (path.endsWith(`/agents/${agentId}`)) json = detail;
          else if (path.endsWith(`/agents/${agentId}/policy`))
            json = {
              version: 1,
              owningTeamId: engineering,
              grants: [],
              personGrants: [{ membershipId, permissions: ['manage'] }],
              enrollment: [engineering],
              enabled: true,
              limits,
            };
          else if (path.endsWith(`/agents/${agentId}/schedules`)) json = [{ ...schedule, lastRun }];
          else if (path.endsWith(`/agents/${agentId}/chat`)) json = { configured: true };
          else return route.fulfill({ status: 404, json: { error: 'unavailable' } });
          await route.fulfill({ json });
        });
        const openSchedules = async () => {
          await page.goto(`${origin}/acme/agents/${agentId}`);
          await page.getByRole('tab', { name: 'Triggers', exact: true }).click();
        };
        await openSchedules();
        const schedules = page.getByRole('region', { name: 'Agent schedules', exact: true });
        await schedules
          .getByText(
            'Last scheduled start skipped: You have 1,000 active tasks. Complete active tasks to free capacity. The schedule will try again at the next occurrence.',
            { exact: true },
          )
          .waitFor();
        assert.equal(await schedules.getByRole('link', { name: 'Open last task', exact: true }).count(), 0);
        lastRun = { kind: 'task', taskId, status: 'pending' };
        await openSchedules();
        await schedules.getByText('Last task: Working', { exact: false }).waitFor();
        assert.equal(
          await schedules.getByRole('link', { name: 'Open last task', exact: true }).getAttribute('href'),
          `/acme/agent-tasks/${taskId}`,
        );
        await context.close();
      }
    } finally {
      await browser?.close();
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
    }
  },
);
