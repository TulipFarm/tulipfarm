import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

const port = Number(process.env.PERSONAL_CALENDAR_PORT ?? 5417),
  origin = `http://127.0.0.1:${port}`;
const shots = process.env.PERSONAL_CALENDAR_SCREENSHOTS,
  cdp = process.env.PERSONAL_CALENDAR_CDP_PORT;
const { workspace, session } = createWorkspaceFixture({ slug: 'calendar-qa', name: 'Acme Studio' });
const id = '33333333-3333-4333-8333-333333333333',
  otherId = '44444444-4444-4444-8444-444444444444';
const scope = 'https://www.googleapis.com/auth/calendar';
const scopes = ['openid', 'https://www.googleapis.com/auth/userinfo.email', scope];
const integration = { integrationId: id, accountId: 'account', generation: 1, scopes, requiredScopes: [scope] };
const event = (id, title, start, end, extra = {}) => ({
  id,
  summary: title,
  start: { dateTime: `2030-01-07T${start}:00Z` },
  end: { dateTime: `2030-01-07T${end}:00Z` },
  ...extra,
});
const taskTitle = 'Review the launch brief';
const task = {
  id: otherId,
  status: 'waiting-approval',
  generation: 0,
  agentId: id,
  activationId: id,
  definitionRevision: 'a'.repeat(64),
  parentTaskId: null,
  delegationDepth: 0,
  skills: [],
  scope: [],
  limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
  flowId: otherId,
  activeMilliseconds: '12000',
  toolCalls: 3,
  createdAt: '2030-01-07T08:00:00Z',
  cost: { chargedCreditUnits: '4', heldCreditUnits: '0' },
  activity: [],
};

test(
  'personal calendar navigation, complete availability, safe creation and responsive layouts',
  { timeout: 180000 },
  async () => {
    const server = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      { cwd: new URL('..', import.meta.url), stdio: 'ignore' },
    );
    let browser;
    const errors = [],
      proposals = [],
      follows = [],
      reads = [];
    try {
      for (let attempt = 0; ; attempt++) {
        if (
          await fetch(origin).then(
            result => result.ok,
            () => false,
          )
        )
          break;
        assert.ok(attempt < 100 && server.exitCode === null);
        await delay(100);
      }
      if (shots) await mkdir(shots, { recursive: true });
      browser = await chromium.launch({ headless: true, args: cdp ? [`--remote-debugging-port=${cdp}`] : [] });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        timezoneId: 'UTC',
        reducedMotion: 'reduce',
      });
      await context.addCookies([{ name: 'sidebar_state', value: 'true', url: origin }]);
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      page.on('pageerror', error => errors.push(String(error)));
      await page.addInitScript(now => {
        const NativeDate = Date,
          offset = now - NativeDate.now();
        // Preserve new.target so TZDate retains its time-zone methods.
        globalThis.Date = new Proxy(NativeDate, {
          apply: target => new target(target.now() + offset).toString(),
          construct: (target, args, newTarget) =>
            Reflect.construct(target, args.length ? args : [target.now() + offset], newTarget),
          get: (target, property, receiver) =>
            property === 'now' ? () => target.now() + offset : Reflect.get(target, property, receiver),
        });
      }, Date.parse('2030-01-07T08:00:00Z'));
      let connected = true,
        failEvents = false,
        failTasks = false,
        moreTasks = false,
        hideTasks = false,
        hideActions = false,
        follow = false,
        proposal = null,
        failProposal = true;
      const capture = async name => {
        if (!shots) return;
        if (cdp)
          execFileSync(
            'agent-browser',
            ['--session', 'tulipfarm-calendar', '--cdp', cdp, 'screenshot', `${shots}/${name}.png`],
            { stdio: 'pipe', timeout: 15000 },
          );
        else await page.screenshot({ path: `${shots}/${name}.png` });
      };
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        let json;
        if (path === '/v1/auth/get-session') json = session;
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path.endsWith('/governance/me')) json = membership;
        else if (path.endsWith('/credits')) json = credits;
        else if (path.endsWith('/google-workspace/availability')) json = { configured: true };
        else if (path.endsWith('/google-workspace'))
          json = connected
            ? {
                status: 'connected',
                integrationId: id,
                accountId: 'account',
                generation: 1,
                email: 'ada@example.test',
                scopes,
              }
            : { status: 'disconnected' };
        else if (path.endsWith('/operations/read')) {
          const body = request.postDataJSON(),
            operation = body.operation;
          reads.push(body);
          if (operation.kind === 'calendar.calendars.list')
            json = {
              untrusted: true,
              data: {
                items: [
                  { id: 'work', summary: 'Work calendar', timeZone: 'UTC', accessRole: 'owner', primary: true },
                  { id: 'personal', summary: 'Personal calendar', timeZone: 'UTC', accessRole: 'owner' },
                ],
              },
            };
          else {
            if (failEvents) return route.fulfill({ status: 503, json: { error: 'provider-unavailable' } });
            json = {
              untrusted: true,
              data: {
                timeZone: 'UTC',
                items:
                  operation.calendarId === 'personal'
                    ? [event('hidden', 'Dentist', '10:00', '11:00')]
                    : operation.pageToken
                      ? [event('design', 'Design review', '13:00', '14:00')]
                      : [
                          event('planning', 'Weekly planning', '09:00', '10:00'),
                          event('overlap', 'Roadmap planning', '09:30', '10:30'),
                          event('short', 'Product check-in', '11:30', '12:00'),
                          event('focus', 'Launch notes', '14:00', '15:30', { eventType: 'focusTime' }),
                          event('free', 'Optional office hours', '11:00', '12:00', { transparency: 'transparent' }),
                        ],
                ...(operation.calendarId === 'work' && !operation.pageToken ? { nextPageToken: 'page-two' } : {}),
              },
            };
          }
        } else if (path.endsWith('/workflows/calendar'))
          json = {
            workflows: [
              {
                id,
                name: 'Weekly revenue report',
                personal: true,
                following: false,
                enabled: true,
                occurrences: [{ at: '2030-01-07T08:30:00Z', status: 'Scheduled' }],
                more: false,
              },
              {
                id: otherId,
                name: 'Team digest',
                personal: false,
                following: follow,
                enabled: true,
                occurrences: follow ? [{ at: '2030-01-07T12:00:00Z', status: 'Scheduled' }] : [],
                more: false,
              },
            ],
            actions: hideActions
              ? []
              : [{ workflowId: id, runId: id, stepId: 'review', title: 'Approve the weekly report' }],
            more: false,
          };
        else if (path.endsWith('/calendar-follow')) {
          follows.push(request.postDataJSON());
          follow = request.postDataJSON().following;
          json = { following: follow };
        } else if (path.endsWith('/agents/calendar'))
          json = {
            schedules: [{ id, agentId: otherId, name: 'Morning brief', times: ['2030-01-07T08:00:00Z'], more: false }],
            more: false,
          };
        else if (path.endsWith('/agent-tasks')) {
          if (failTasks) return route.fulfill({ status: 503, json: { error: 'tasks-unavailable' } });
          json = { tasks: hideTasks ? [] : [task], nextCursor: moreTasks ? 'next-page' : null };
        } else if (path.endsWith(`/agent-tasks/${otherId}/history`))
          json = {
            messages: [
              { sequence: 0, generation: 0, role: 'owner', text: taskTitle, sources: [], createdAt: task.createdAt },
            ],
            nextCursor: null,
          };
        else if (path.endsWith('/operations/proposals') && request.method() === 'POST') {
          proposals.push(request.postDataJSON());
          proposal ??= {
            id,
            operation: request.postDataJSON().operation,
            digest: 'a'.repeat(64),
            expiresAt: '2031-01-01T00:00:00Z',
            integration,
            decision: null,
            receipt: null,
          };
          if (failProposal) {
            failProposal = false;
            return route.abort('failed');
          }
          json = proposal;
        } else if (path.endsWith(`/proposals/${id}/decision`)) {
          proposal.decision = request.postDataJSON().decision;
          json = proposal;
        } else if (path.endsWith(`/proposals/${id}/execute`)) {
          proposal.receipt = { status: 'succeeded', result: { untrusted: true, data: { id: 'created' } }, error: null };
          json = proposal.receipt;
        } else if (path.endsWith(`/proposals/${id}`)) json = proposal;
        else return route.fulfill({ status: 404, json: { error: 'not-found' } });
        return route.fulfill({ json });
      });
      const choose = async (label, option) => {
        await page.getByRole('combobox', { name: label, exact: true }).click();
        await page.getByRole('option', { name: option, exact: true }).click();
      };
      const close = () => page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      const button = title => page.getByRole('button', { name: new RegExp(`^${title},`) });
      await page.goto(`${origin}/${workspace.slug}/calendar?date=2030-01-07&zone=UTC`);
      await button('Design review').waitFor();
      await button('Morning brief').waitFor();
      assert.ok(reads.some(read => read.operation.pageToken === 'page-two'));
      assert.ok(reads.every(read => read.expectedIntegration?.accountId === 'account'));
      const calendarFilters = page.getByRole('dialog', { name: 'Calendar filters', exact: true });
      const openFilters = async () => {
        await page.getByRole('button', { name: 'Calendar filters', exact: true }).click();
        await calendarFilters.waitFor();
      };
      assert.equal(
        await page.getByRole('complementary', { name: 'Calendar filters', exact: true }).count(),
        0,
        'filters do not take permanent space from the week',
      );
      assert.equal(
        await page.locator('[aria-label="Workspace header"] [aria-label="Bud assistant"]').count(),
        1,
        'Bud stays in the header, outside calendar cells',
      );
      await openFilters();
      const sourceDisclosure = calendarFilters.getByRole('button', { name: 'Google calendars', exact: true });
      const zoneDisclosure = calendarFilters.getByRole('button', { name: 'Time zones', exact: true });
      assert.equal(
        await calendarFilters.locator('[data-slot="calendar"]').count(),
        0,
        'the filter sidebar has no mini month calendar',
      );
      assert.equal(
        await calendarFilters.getByRole('checkbox', { name: 'Show sample calendar', exact: true }).count(),
        0,
        'calendar uses real sources in development and production',
      );
      assert.equal(
        await calendarFilters.getByRole('region', { name: 'Event types', exact: true }).getByRole('checkbox').count(),
        4,
        'event types stay directly available',
      );
      assert.equal(
        await sourceDisclosure.getAttribute('aria-expanded'),
        'false',
        'connected calendars start collapsed',
      );
      assert.equal(await zoneDisclosure.getAttribute('aria-expanded'), 'false', 'time zones start collapsed');
      assert.equal(
        await calendarFilters.getByRole('checkbox', { name: 'Work calendar', exact: true }).isVisible(),
        false,
      );
      assert.equal(
        await calendarFilters.getByRole('combobox', { name: 'Calendar time zone', exact: true }).isVisible(),
        false,
      );
      await close();
      await capture('week-desktop');
      const sidebar = page.getByRole('complementary', { name: 'Workspace sidebar', exact: true });
      assert.ok((await sidebar.boundingBox()).width < 80, 'calendar starts with compact navigation');
      await page.locator('[data-slot="sidebar-trigger"]').click();
      await page.waitForFunction(
        () => document.querySelector('aside[aria-label="Workspace sidebar"]')?.getBoundingClientRect().width > 200,
      );
      await page.locator('[data-slot="sidebar-trigger"]').click();
      await page.waitForFunction(
        () => document.querySelector('aside[aria-label="Workspace sidebar"]')?.getBoundingClientRect().width < 80,
      );
      assert.equal(
        (await context.cookies()).find(cookie => cookie.name === 'sidebar_state').value,
        'true',
        'calendar compact mode does not overwrite the shared preference',
      );
      await page.locator(`a[href="/${workspace.slug}/integrations"]`).first().click();
      await page.waitForFunction(
        () => document.querySelector('aside[aria-label="Workspace sidebar"]')?.getBoundingClientRect().width > 200,
      );
      await page.getByRole('link', { name: 'Calendar', exact: true }).click();
      await button('Design review').waitFor();
      assert.ok((await sidebar.boundingBox()).width < 80, 'calendar keeps its own compact state');
      await page.getByRole('button', { name: 'Choose date', exact: true }).click();
      await page.getByRole('dialog', { name: 'Choose a calendar date', exact: true }).waitFor();
      await page.locator('button[data-day="1/9/2030"]').click();
      await page.waitForURL('**date=2030-01-09**');
      await page.getByRole('button', { name: 'Today', exact: true }).click();
      await page.waitForURL('**date=2030-01-07**');
      await page.getByRole('button', { name: 'Choose date', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: 'Choose a calendar date', exact: true }).waitFor({ state: 'hidden' });
      const pending = page.getByRole('button', { name: 'Pending work', exact: true });
      const dropdown = page.locator('[data-slot="popover-content"][aria-label="Pending work"]');
      assert.equal(
        await page.getByRole('region', { name: 'Pending work tray', exact: true }).count(),
        0,
        'the bottom tray is removed',
      );
      assert.equal(await pending.getAttribute('aria-expanded'), 'false', 'pending work is closed by default');
      const gridBeforeDropdown = await page.locator('.calendar-time-scroll').boundingBox();
      await pending.focus();
      await page.keyboard.press('Enter');
      await dropdown.waitFor();
      assert.equal(await dropdown.getAttribute('role'), 'dialog');
      assert.deepEqual(
        await page.locator('.calendar-time-scroll').boundingBox(),
        gridBeforeDropdown,
        'opening pending work does not resize the calendar',
      );
      const approvalCard = dropdown.getByRole('article', { name: 'Approve the weekly report', exact: true });
      assert.equal(
        await approvalCard.locator('[data-slot="card"]').count(),
        1,
        'pending items have shared card boundaries',
      );
      assert.equal(
        await approvalCard.locator('[data-slot="card-footer"]').count(),
        1,
        'status and actions are grouped separately from the title',
      );
      assert.ok((await approvalCard.boundingBox()).width <= 488, 'pending cards stay within the one-column popup');
      assert.ok(
        await approvalCard.getByRole('link', { name: 'Review Approve the weekly report', exact: true }).isVisible(),
      );
      assert.match(
        await approvalCard
          .getByRole('link', { name: 'Review Approve the weekly report', exact: true })
          .getAttribute('href'),
        /view=runs/,
      );
      await page.keyboard.press('m');
      assert.equal(
        await page.getByRole('combobox', { name: 'Calendar view', exact: true }).innerText(),
        'Week',
        'calendar shortcuts stay inactive inside pending work',
      );
      await capture('pending-work-desktop');
      await page.keyboard.press('Escape');
      await dropdown.waitFor({ state: 'hidden' });
      assert.equal(await pending.getAttribute('aria-expanded'), 'false');
      assert.equal(
        await pending.evaluate(element => element === document.activeElement),
        true,
        'Escape returns focus to the trigger',
      );
      await pending.click();
      await page.getByRole('heading', { name: 'Calendar', exact: true }).click();
      await dropdown.waitFor({ state: 'hidden' });
      await pending.click();
      await page.getByRole('button', { name: 'View all pending work', exact: true }).click();
      await dropdown.waitFor({ state: 'hidden' });
      await page.getByRole('heading', { name: 'Pending work', exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 1, 'View all opens only the sheet');
      await page.getByRole('link', { name: 'Approve the weekly report', exact: true }).waitFor();
      await close();
      const indiaZone = await page.evaluate(() =>
        Intl.supportedValuesOf('timeZone').find(zone => zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta'),
      );
      assert.ok(indiaZone, 'browser exposes an India time zone');
      await openFilters();
      await zoneDisclosure.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('combobox', { name: 'Calendar time zone', exact: true }).waitFor();
      await sourceDisclosure.focus();
      await page.keyboard.press('Space');
      await page.getByRole('checkbox', { name: 'Work calendar', exact: true }).waitFor();
      assert.equal(
        await zoneDisclosure.getAttribute('aria-expanded'),
        'true',
        'disclosures open independently with the keyboard',
      );
      assert.equal(
        await page.getByRole('combobox', { name: 'Second time zone', exact: true }).innerText(),
        'Off',
        'comparison starts off',
      );
      await choose('Second time zone', 'UTC');
      await choose('Calendar time zone', indiaZone);
      await page.waitForFunction(
        zone => document.querySelector('.calendar-axis-title')?.textContent === `${zone.split('/').at(-1)}UTC`,
        indiaZone,
      );
      const labels = await page
        .locator('.calendar-hours > div')
        .nth(9)
        .locator('span')
        .evaluateAll(spans => spans.map(span => ({ text: span.textContent, top: span.getBoundingClientRect().top })));
      assert.deepEqual(
        labels.map(label => label.text),
        ['9 AM', '3:30 AM'],
      );
      assert.equal(labels[0].top, labels[1].top, 'both clocks align with the same hour line');
      await choose('Calendar time zone', 'UTC');
      await page.waitForFunction(() => document.querySelector('.calendar-axis-title')?.children.length === 1);
      await choose('Second time zone', 'Off');
      await zoneDisclosure.click();
      await page.getByRole('combobox', { name: 'Calendar time zone', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(
        await page.locator('.calendar-axis-title').innerText(),
        'UTC',
        'collapsing controls keeps the selected zone',
      );
      await close();
      await button('Weekly planning').waitFor();
      const colors = await page.evaluate(() =>
        ['meeting', 'task', 'agent', 'workflow'].map(
          kind => getComputedStyle(document.querySelector(`.calendar-entry[data-kind="${kind}"]`)).color,
        ),
      );
      assert.equal(new Set(colors).size, 4, 'colors identify event types only');
      assert.equal(
        await page.locator('.calendar-source-mark').count(),
        0,
        'provider colors cannot conflict with event types',
      );
      assert.equal(
        await page.locator('.calendar-event-position [data-time-kind="point"]').count(),
        0,
        'runs never occupy duration slots',
      );
      assert.ok(await page.getByRole('region', { name: 'Scheduled runs, do not block time', exact: true }).isVisible());
      assert.equal(await button('Morning brief').locator('.calendar-run-time').innerText(), '8a');
      await page.getByRole('button', { name: 'Go to now', exact: true }).click();
      await page.waitForFunction(() => {
        const now = document.querySelector('.calendar-now')?.getBoundingClientRect(),
          grid = document.querySelector('.calendar-time-scroll')?.getBoundingClientRect();
        return now && grid && now.y > grid.y && now.y < grid.bottom;
      });
      const nowLine = await page.locator('.calendar-now').boundingBox(),
        timeGrid = await page.locator('.calendar-time-scroll').boundingBox();
      assert.ok(
        nowLine.y > timeGrid.y && nowLine.y < timeGrid.y + timeGrid.height,
        'Go to now reveals the current hour',
      );
      await page.getByRole('button', { name: 'Next in view: Weekly revenue report', exact: true }).click();
      await page.getByRole('heading', { name: 'Weekly revenue report', exact: true }).waitFor();
      await close();
      const narrow = button('Weekly planning');
      assert.equal(await narrow.locator('.calendar-entry-start').isVisible(), true);
      assert.equal(await narrow.locator('.calendar-entry-range').isVisible(), false);
      assert.equal(
        await narrow.locator('.calendar-entry-title').evaluate(element => element.scrollWidth <= element.clientWidth),
        true,
        'overlap summaries retain readable titles instead of narrow half-cards',
      );
      await page.getByRole('button', { name: 'View all 3 events on 2030-01-07', exact: true }).click();
      const overlaps = page.getByRole('dialog', { name: 'Events at this time', exact: true });
      assert.equal(
        await overlaps.locator('.calendar-entry').count(),
        3,
        'every grouped event has full details in the overlap list',
      );
      await capture('overlap-details');
      await overlaps.getByRole('button', { name: /^Roadmap planning,/ }).click();
      await page.getByRole('heading', { name: 'Roadmap planning', exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 1, 'event details replace the overlap popover');
      await close();
      await narrow.click();
      await page.getByRole('heading', { name: 'Weekly planning', exact: true }).waitFor();
      assert.match(await page.getByRole('dialog').innerText(), /9:00 AM – 10:00 AM/);
      await close();
      const short = button('Product check-in');
      assert.equal(await short.locator('.calendar-entry-start').innerText(), '11:30a');
      assert.equal(
        await short.locator('.calendar-entry-title').evaluate(element => element.scrollWidth <= element.clientWidth),
        true,
        'short overlap titles fit without clipping',
      );
      const shortTime = await short.locator('.calendar-entry-time').boundingBox(),
        shortBox = await short.boundingBox();
      assert.ok(
        shortTime.y + shortTime.height <= shortBox.y + shortBox.height,
        'short event start time is not clipped',
      );
      await openFilters();
      await page.getByRole('checkbox', { name: 'Meetings', exact: true }).click();
      await close();
      assert.equal(await button('Weekly planning').count(), 0);
      assert.equal(await button('Morning brief').count(), 1);
      await openFilters();
      for (const checkbox of await calendarFilters
        .getByRole('region', { name: 'Event types', exact: true })
        .getByRole('checkbox')
        .all())
        if (await checkbox.isChecked()) await checkbox.click();
      await close();
      await page.getByText('No events match these filters.', { exact: true }).waitFor();
      await capture('empty-filtered');
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await button('Weekly planning').waitFor();
      await openFilters();
      await sourceDisclosure.click();
      await page.getByRole('checkbox', { name: 'Personal calendar', exact: true }).click();
      await sourceDisclosure.click();
      await page.getByRole('checkbox', { name: 'Personal calendar', exact: true }).waitFor({ state: 'hidden' });
      await sourceDisclosure.click();
      assert.equal(
        await page.getByRole('checkbox', { name: 'Personal calendar', exact: true }).isChecked(),
        false,
        'reopening sources preserves hidden calendars',
      );
      await sourceDisclosure.click();
      assert.equal(await calendarFilters.locator('#calendar-source-summary').innerText(), '1 of 2 shown');
      await close();
      assert.match(
        await page.getByRole('button', { name: 'Calendar filters', exact: true }).innerText(),
        /1/,
        'the toolbar indicates hidden sources',
      );
      await page.getByRole('button', { name: 'Find time', exact: true }).click();
      await page.getByText('Free when last loaded.', { exact: false }).waitFor();
      assert.equal(
        await page.getByRole('dialog').getByRole('button', { name: '10:00 AM', exact: true }).count(),
        0,
        'hidden calendars still block time',
      );
      await page.getByRole('dialog').getByRole('button', { name: '11:00 AM', exact: true }).click();
      await page.getByLabel('Event name', { exact: true }).fill('Work on the launch');
      await close();
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      assert.equal(
        await page.getByLabel('Event name', { exact: true }).inputValue(),
        'Work on the launch',
        'closing preserves draft',
      );
      await page.getByRole('button', { name: 'Review event', exact: true }).click();
      await page.getByRole('button', { name: 'Retry event review', exact: true }).click();
      await page.getByRole('checkbox', { name: 'I authorize this exact change', exact: true }).waitFor();
      assert.equal(proposals.length, 2);
      assert.deepEqual(proposals[0], proposals[1]);
      assert.equal(proposals[0].operation.event.start.dateTime, '2030-01-07T11:00:00.000+00:00');
      assert.equal(proposals[0].operation.event.end.dateTime, '2030-01-07T11:30:00.000+00:00');
      await capture('create-review');
      await page.getByRole('checkbox', { name: 'I authorize this exact change', exact: true }).click();
      await page.getByRole('button', { name: 'Approve exact Google action', exact: true }).click();
      await page.getByRole('button', { name: 'Execute approved Google action', exact: true }).click();
      await page.getByRole('button', { name: 'Create another event', exact: true }).waitFor();
      await close();
      await openFilters();
      await page.getByRole('button', { name: 'Choose workflow follows', exact: true }).click();
      await page.getByRole('checkbox', { name: 'Team digest', exact: true }).click();
      await close();
      await page.getByRole('button', { name: 'View all 3 runs on 2030-01-07', exact: true }).click();
      await page.getByRole('region', { name: 'Agenda', exact: true }).waitFor();
      await button('Team digest').waitFor();
      assert.deepEqual(follows, [{ following: true }]);
      await choose('Calendar view', 'Month');
      await page.getByRole('region', { name: 'Month calendar' }).waitFor();
      await page.getByRole('button', { name: 'View all 3 runs on 2030-01-07', exact: true }).waitFor();
      await capture('month-desktop');
      await page.keyboard.press('a');
      await page.getByRole('region', { name: 'Agenda', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Calendar commands', exact: true }).focus();
      await page.keyboard.press('/');
      await page.getByRole('combobox', { name: 'Calendar commands', exact: true }).fill('Morning brief');
      await page.getByRole('option', { name: /Morning brief/ }).click();
      await page.getByRole('heading', { name: 'Morning brief', exact: true }).waitFor();
      await close();
      await choose('Calendar view', 'Day');
      const touch = await context.newCDPSession(page);
      await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
      for (const width of [320, 375, 414, 768]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: width === 375 ? 'dark' : 'light' });
        await delay(100);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `no page overflow at ${width}`,
        );
        const pageTitle = page.getByRole('heading', { name: 'Calendar', exact: true });
        assert.equal(
          await pageTitle.evaluate(element => element.scrollWidth <= element.clientWidth),
          true,
          `the page title stays readable at ${width}`,
        );
        assert.ok(await pending.isVisible(), `pending work stays visible at ${width}`);
        const pendingBox = await pending.boundingBox();
        assert.ok(pendingBox.x + pendingBox.width <= width, `pending work fits at ${width}`);
        const today = await page.getByRole('button', { name: 'Today', exact: true }).boundingBox();
        assert.ok(
          pendingBox.x + pendingBox.width <= today.x && Math.abs(pendingBox.y - today.y) < 1,
          `pending work sits directly left of Today at ${width}`,
        );
        for (const name of [
          'Previous range',
          'Next range',
          'Today',
          'Pending work',
          'Calendar filters',
          'More calendar actions',
          'Create',
          'Open Bud',
        ]) {
          const box = await page.getByRole('button', { name, exact: true }).boundingBox();
          assert.ok(box.width >= 44 && box.height >= 44, `${name} has a 44px touch target at ${width}`);
        }
        await pending.click();
        await dropdown.waitFor();
        const dropdownBox = await dropdown.boundingBox();
        assert.ok(
          dropdownBox.x >= 0 &&
            dropdownBox.x + dropdownBox.width <= width &&
            dropdownBox.y >= 0 &&
            dropdownBox.y + dropdownBox.height <= 900,
          `the dropdown stays inside the viewport at ${width}`,
        );
        const pendingCard = await approvalCard.boundingBox();
        assert.ok(
          pendingCard.x >= 0 && pendingCard.x + pendingCard.width <= width,
          `a complete pending card fits at ${width}`,
        );
        const heading = await page.getByRole('heading', { name: 'January 2030', exact: true }).boundingBox();
        assert.ok(
          heading.y + heading.height <= today.y || heading.x + heading.width <= today.x,
          `title does not overlap controls at ${width}`,
        );
        if (width === 375) await capture('pending-work-mobile-dark');
        await page.keyboard.press('Escape');
        await dropdown.waitFor({ state: 'hidden' });
        if (width === 375) await capture('day-mobile-dark');
        await page.getByRole('button', { name: 'Calendar filters', exact: true }).click();
        const mobileFilters = page.getByRole('dialog');
        assert.equal(
          await mobileFilters.locator('[data-slot="calendar"]').count(),
          0,
          `no mini calendar in the mobile filter sheet at ${width}`,
        );
        const mobileZones = mobileFilters.getByRole('button', { name: 'Time zones', exact: true });
        const mobileSources = mobileFilters.getByRole('button', { name: 'Google calendars', exact: true });
        assert.equal(await mobileZones.getAttribute('aria-expanded'), 'false');
        assert.equal(await mobileSources.getAttribute('aria-expanded'), 'false');
        if (width === 375) await capture('filters-mobile-collapsed');
        await mobileZones.click();
        await mobileFilters.getByRole('combobox', { name: 'Calendar time zone', exact: true }).waitFor();
        await mobileSources.click();
        assert.equal(
          await mobileFilters.getByRole('checkbox', { name: 'Personal calendar', exact: true }).isChecked(),
          false,
          'source choices survive the switch to mobile',
        );
        assert.equal(
          await mobileFilters.getByRole('combobox', { name: 'Calendar time zone', exact: true }).innerText(),
          'UTC',
        );
        await close();
        await choose('Calendar view', 'Week');
        const weekPicker = page.getByRole('navigation', { name: 'Days in this week', exact: true });
        await weekPicker.waitFor();
        assert.equal(await weekPicker.getByRole('button').count(), 7);
        assert.equal(
          await page.locator('.calendar-time-scroll').evaluate(element => element.scrollWidth <= element.clientWidth),
          true,
          `all seven dates fit without horizontal scrolling at ${width}`,
        );
        await weekPicker.getByRole('button', { name: 'Open Tuesday, January 8, 2030', exact: true }).click();
        assert.equal(await page.getByRole('combobox', { name: 'Calendar view', exact: true }).innerText(), 'Week');
        await page.getByRole('button', { name: 'Create event 2030-01-08 09:00', exact: true }).waitFor();
        await choose('Calendar view', 'Month');
        await page.getByRole('button', { name: /^Show 2030-01-07,/ }).click();
        const selectedDay = page.getByRole('region', { name: 'Selected day', exact: true });
        await selectedDay.getByRole('heading', { name: 'Monday, Jan 7', exact: true }).waitFor();
        await selectedDay.getByRole('button', { name: /^Morning brief,/ }).waitFor();
        await selectedDay.getByRole('button', { name: 'Open day', exact: true }).click();
        await page.getByRole('button', { name: 'More calendar actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Search calendar', exact: true }).click();
        await page.getByRole('combobox', { name: 'Calendar commands', exact: true }).waitFor();
        await page.keyboard.press('Escape');
      }
      await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await touch.detach();
      await page.setViewportSize({ width: 1440, height: 1000 });
      failTasks = true;
      hideActions = true;
      hideTasks = true;
      await page.getByRole('button', { name: 'Refresh calendar', exact: true }).click();
      await pending.click();
      await dropdown.getByText('tasks could not refresh.', { exact: true }).waitFor();
      assert.equal(
        await dropdown.getByText('You’re all caught up.', { exact: true }).count(),
        0,
        'failed pending reads cannot claim all work is done',
      );
      failTasks = false;
      moreTasks = true;
      await dropdown.getByRole('button', { name: 'Retry tasks', exact: true }).click();
      await dropdown.getByText('No items on this page. Other work may be available.', { exact: true }).waitFor();
      assert.equal(
        await dropdown.getByText('You’re all caught up.', { exact: true }).count(),
        0,
        'a partial page is not an empty work list',
      );
      moreTasks = false;
      await page.getByRole('button', { name: 'Refresh calendar', exact: true }).click();
      await pending.click();
      await dropdown.getByText('You’re all caught up.', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await dropdown.waitFor({ state: 'hidden' });
      failEvents = true;
      await page.getByRole('button', { name: 'Refresh calendar', exact: true }).click();
      await page.getByText(/Work calendar: The response could not be confirmed/).waitFor();
      await capture('source-error');
      await page.getByRole('button', { name: 'Find time', exact: true }).click();
      await page.getByText(/Availability is not confirmed/).waitFor();
      await close();
      failEvents = false;
      await page.getByRole('button', { name: 'Refresh calendar', exact: true }).click();
      await button('Weekly planning').waitFor();
      hideTasks = false;
      await page.reload();
      await page.locator('.calendar-entry[aria-label^="Weekly planning,"]').first().waitFor({ state: 'attached' });
      await page.locator('.calendar-time-scroll').evaluate(element => {
        element.scrollTop = 1000;
      });
      await page.getByRole('button', { name: 'Go to now', exact: true }).click();
      await page.waitForFunction(async () => {
        for (let frame = 0; frame < 3; frame++) {
          await new Promise(requestAnimationFrame);
          const now = document.querySelector('.calendar-now')?.getBoundingClientRect(),
            grid = document.querySelector('.calendar-time-scroll')?.getBoundingClientRect();
          const header = document.querySelector('.calendar-time-top')?.getBoundingClientRect();
          if (!now || !grid || !header || now.y <= header.bottom || now.y >= grid.bottom) return false;
        }
        return true;
      });
      await pending.click();
      const taskCard = dropdown.getByRole('article', { name: taskTitle, exact: true });
      await taskCard.waitFor();
      assert.match(
        await taskCard.getByRole('link', { name: taskTitle, exact: true }).getAttribute('href'),
        new RegExp(`/agent-tasks/${otherId}$`),
      );
      await taskCard.getByRole('button', { name: 'Reserve time', exact: true }).click();
      await dropdown.waitFor({ state: 'hidden' });
      await page.getByRole('heading', { name: 'Create event', exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 1, 'Reserve time replaces the popup with creation');
      assert.equal(await page.getByLabel('Event name', { exact: true }).inputValue(), taskTitle);
      assert.equal(
        await page
          .getByLabel('Event name', { exact: true })
          .evaluate(element => element.closest('[role="dialog"]').contains(document.activeElement)),
        true,
        'focus moves into creation',
      );
      await close();
      connected = false;
      await page.getByRole('button', { name: 'Refresh calendar', exact: true }).click();
      await page.getByText(/Connect Google Calendar to add meetings/).waitFor();
      assert.equal(await button('Weekly planning').count(), 0);
      assert.equal(await button('Morning brief').count(), 1);
      assert.deepEqual(errors, []);
      await context.close();
    } catch (error) {
      const page = browser?.contexts()[0]?.pages()[0];
      if (page) {
        console.error({ url: page.url(), body: await page.locator('body').innerText(), errors, reads });
        if (shots) await page.screenshot({ path: `${shots}/failure.png` });
      }
      throw error;
    } finally {
      await browser?.close();
      if (server.exitCode === null) {
        const stopped = once(server, 'exit');
        server.kill('SIGTERM');
        await stopped;
      }
    }
  },
);
