import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { parseCalendarRead } from '../../../packages/google-workspace/src/calendar-events.ts';

const port = Number(process.env.CALENDAR_PORT ?? 5398);
const origin = `http://127.0.0.1:${port}`;
const { workspace, session } = createWorkspaceFixture();
const id = '11111111-1111-4111-8111-111111111111';
const now = Date.parse('2026-10-02T10:00:00Z');
const instant = minutes => new Date(now + minutes * 60000).toISOString();
const event = (index, start = index * 60 - 30, end = index * 60 + 30) => ({
  id: `meeting${index}`,
  summary:
    index === 2
      ? 'Customer review with the operations team and our international distribution partners'
      : `Meeting ${index}`,
  start: { dateTime: instant(start) },
  end: { dateTime: instant(end) },
  ...(index === 0
    ? { hangoutLink: 'https://meet.google.com/real-room' }
    : index === 1
      ? { hangoutLink: 'javascript:alert(1)' }
      : {}),
});
const historyEvents = parseCalendarRead(
  { kind: 'calendar.events.list', calendarId: 'primary' },
  {
    items: [
      event(0),
      event(1),
      event(2),
      event(3),
      event(4, 1500, 1560),
      { id: 'holiday', summary: 'All-day planning', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } },
      {
        id: 'overnight',
        summary: 'Overnight review',
        start: { dateTime: '2026-10-03T03:00:00Z' },
        end: { dateTime: '2026-10-03T05:00:00Z' },
      },
      {
        id: 'utc-midnight',
        summary: 'Evening review',
        start: { dateTime: '2026-10-02T23:00:00Z' },
        end: { dateTime: '2026-10-03T01:00:00Z' },
      },
    ],
  },
).events;

test('calendar home and shared chat rows', { timeout: 180000 }, async t => {
  await mkdir(new URL('../../../reports/calendar/', import.meta.url), { recursive: true });
  const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
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
      assert.ok(attempt < 100);
      await delay(100);
    }
    browser = await chromium.launch({ headless: true });
    async function fixture(mobile = false, theme = 'light') {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        isMobile: mobile,
        hasTouch: mobile,
        colorScheme: theme,
        timezoneId: 'America/New_York',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.clock.install({ time: now });
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const state = {
        items: [event(0), event(1), event(2), event(3)],
        connected: true,
        scopes: ['https://www.googleapis.com/auth/calendar'],
        generation: 1,
        failure: false,
        gate: null,
        statusGate: null,
        statusFailure: false,
        readCount: 0,
        requests: [],
        paths: [],
        sends: [],
        accepted: new Map(),
        uncertain: false,
        saved: false,
      };
      await page.route('**/v1/**', async route => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        state.paths.push(path);
        let json;
        if (path === '/v1/auth/get-session') json = session;
        else if (path === '/v1/workspaces') json = [workspace];
        else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
        else if (path.endsWith('/governance/me')) json = membership;
        else if (path.endsWith('/credits')) json = credits;
        else if (path.endsWith('/model-catalog')) json = chatCatalog;
        else if (path.endsWith('/github/accounts')) json = { configured: true, accounts: [] };
        else if (path.endsWith('/google-workspace/availability')) json = { configured: true };
        else if (path.endsWith('/google-workspace')) {
          await state.statusGate?.promise;
          if (state.statusFailure) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
          json = state.connected
            ? {
                status: 'connected',
                integrationId: id,
                accountId: 'account',
                generation: state.generation,
                email: 'ada@example.com',
                scopes: state.scopes,
              }
            : { status: 'disconnected' };
        } else if (path.endsWith('/operations/read')) {
          state.readCount++;
          state.requests.push(request.postDataJSON());
          await state.gate?.promise;
          if (state.failure) return route.fulfill({ status: 409, json: { error: 'provider-unavailable' } });
          const { operation } = request.postDataJSON();
          const items = state.items.filter(
            item =>
              item.start.date ||
              (Date.parse(item.end.dateTime) > Date.parse(operation.timeMin) &&
                Date.parse(item.start.dateTime) < Date.parse(operation.timeMax)),
          );
          json = {
            untrusted: true,
            data: {
              kind: 'calendar#events',
              timeZone: 'America/New_York',
              items: items.slice(0, 3),
              ...(items.length > 3 ? { nextPageToken: 'more' } : {}),
            },
          };
        } else if (/\/messages\/[\w-]+$/.test(path)) {
          const body = request.postDataJSON();
          state.sends.push(body);
          state.accepted.set(body.commandId, { ...body, id: path.split('/').at(-1) });
          if (state.uncertain) {
            state.uncertain = false;
            return route.abort('failed');
          }
          json = { messageId: path.split('/').at(-1), turnId: id, sequence: 1 };
        } else if (path.endsWith('/messages')) {
          const sent = [...state.accepted.values()][0];
          json = {
            messages:
              state.saved || sent
                ? [
                    {
                      id: sent?.id ?? id,
                      author: 'human',
                      sequence: 1,
                      createdAt: instant(0),
                      parts: sent?.parts ?? [{ kind: 'text', text: 'Show next month and more than three events' }],
                      tools: [],
                      turn: { id, status: 'completed', generation: 0 },
                      calendarResults: [
                        {
                          kind: 'events',
                          callId: id,
                          requestedAt: instant(0),
                          events: historyEvents,
                          continuation: 'more-available',
                        },
                      ],
                    },
                  ]
                : [],
            nextBefore: null,
            hasGitHubProposals: false,
          };
        } else if (/\/conversations\/[\w-]+$/.test(path))
          json =
            request.method() === 'PUT'
              ? { id: path.split('/').at(-1) }
              : {
                  id: path.split('/').at(-1),
                  title: 'Calendar chat',
                  titleRevision: 1,
                  archived: false,
                  activityAt: instant(0),
                  createdAt: instant(0),
                };
        else if (path.endsWith('/conversations')) json = { chats: [], nextCursor: null };
        else return route.fulfill({ status: 404, json: { error: 'not-found' } });
        return route.fulfill({ json });
      });
      const refresh = async () => {
        await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 61_000);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      };
      return {
        context,
        page,
        state,
        refresh,
        async close() {
          state.gate?.resolve();
          assert.deepEqual(errors, []);
          await context.close();
        },
      };
    }
    await t.test('zero, one, two, three, four and disconnected', async () => {
      for (const count of [0, 1, 2, 3, 4]) {
        const f = await fixture();
        try {
          f.state.items = Array.from({ length: count }, (_, index) => event(index));
          await f.page.goto(`${origin}/${workspace.slug}`);
          if (count) {
            await f.page.getByRole('list', { name: 'Calendar events' }).waitFor();
            assert.equal(
              await f.page.getByRole('list', { name: 'Calendar events' }).getByRole('listitem').count(),
              Math.min(count, 3),
            );
          } else {
            await f.page.waitForResponse(response => response.url().endsWith('/operations/read'));
            await f.page.getByRole('region', { name: 'Upcoming meetings' }).waitFor({ state: 'hidden' });
          }
          assert.equal(f.state.sends.length, 0);
          if (count)
            assert.deepEqual(f.state.requests[0].expectedIntegration, {
              integrationId: id,
              accountId: 'account',
              generation: 1,
              scopes: ['https://www.googleapis.com/auth/calendar'],
            });
        } finally {
          await f.close();
        }
      }
      const f = await fixture();
      try {
        f.state.connected = false;
        await f.page.goto(`${origin}/${workspace.slug}`);
        await f.page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
        assert.equal(f.state.readCount, 0);
        assert.equal(await f.page.getByRole('region', { name: 'Upcoming meetings' }).count(), 0);
      } finally {
        await f.close();
      }
    });
    await t.test('Google connected without calendar access never reads the calendar', async () => {
      const f = await fixture();
      try {
        f.state.scopes = ['https://www.googleapis.com/auth/drive'];
        const status = f.page.waitForResponse(response =>
          new URL(response.url()).pathname.endsWith('/google-workspace'),
        );
        await f.page.goto(`${origin}/${workspace.slug}`);
        await f.page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
        await status;
        await delay(300);
        await f.page.clock.setSystemTime(now + 120_000);
        await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await f.page.clock.runFor(61_000);
        await delay(300);
        assert.equal(f.state.readCount, 0);
        assert.equal(await f.page.getByRole('region', { name: 'Upcoming meetings' }).count(), 0);
      } finally {
        await f.close();
      }
    });
    await t.test('nothing shows before the calendar is known to be connected', async () => {
      const f = await fixture();
      try {
        f.state.statusGate = Promise.withResolvers();
        const status = f.page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/google-workspace'));
        await f.page.goto(`${origin}/${workspace.slug}`);
        await status;
        await f.page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
        assert.equal(await f.page.getByRole('region', { name: 'Upcoming meetings' }).count(), 0);
        f.state.statusFailure = true;
        const failed = f.page.waitForResponse(response =>
          new URL(response.url()).pathname.endsWith('/google-workspace'),
        );
        f.state.statusGate.resolve();
        assert.equal((await failed).status(), 503);
        await f.page.clock.runFor(1000);
        assert.equal(await f.page.getByRole('region', { name: 'Upcoming meetings' }).count(), 0);
        assert.equal(f.state.readCount, 0);
      } finally {
        f.state.statusGate.resolve();
        await f.close();
      }
    });
    await t.test('window returns refresh access and meetings once per stale interval', async () => {
      const f = await fixture();
      try {
        await f.page.goto(`${origin}/${workspace.slug}`);
        await f.page.getByRole('list', { name: 'Calendar events' }).waitFor();
        await delay(300);
        const returns = async () => {
          const start = f.state.paths.length;
          for (let index = 0; index < 10; index++)
            await f.page.evaluate(() => {
              window.dispatchEvent(new Event('focus'));
              document.dispatchEvent(new Event('visibilitychange'));
            });
          await delay(500);
          const sent = f.state.paths.slice(start);
          const count = suffix => sent.filter(path => path.endsWith(suffix)).length;
          return {
            workspace: count(`/workspaces/${workspace.slug}`),
            membership: count('/governance/me'),
            availability: count('/google-workspace/availability'),
            google: count('/google-workspace'),
            calendar: count('/operations/read'),
          };
        };
        assert.deepEqual(
          await returns(),
          { workspace: 1, membership: 1, availability: 0, google: 0, calendar: 0 },
          'fresh data and a recent access check need no requests',
        );
        await f.page.clock.setSystemTime(now + 120_000);
        assert.deepEqual(
          await returns(),
          { workspace: 1, membership: 1, availability: 1, google: 1, calendar: 1 },
          'a return after the stale interval refreshes each read once',
        );
      } finally {
        await f.close();
      }
    });
    await t.test('loading, failed read, retry, refresh failure, expiry refill and authority loss', async () => {
      const f = await fixture();
      try {
        f.state.gate = Promise.withResolvers();
        f.state.failure = true;
        await f.page.goto(`${origin}/${workspace.slug}`);
        await f.page.getByRole('status', { name: 'Loading upcoming meetings' }).waitFor();
        f.state.gate.resolve();
        await f.page.getByRole('button', { name: 'Retry meetings' }).waitFor();
        // The error panel stays up while the retry reads, so wait for the retried read itself before the provider recovers.
        const retried = f.page.waitForResponse(response => response.url().endsWith('/operations/read'));
        await f.page.getByRole('button', { name: 'Retry meetings' }).click();
        assert.equal((await retried).status(), 409);
        await f.page.getByRole('heading', { name: 'Could not load meetings' }).waitFor();
        f.state.failure = false;
        await f.page.getByRole('button', { name: 'Retry meetings' }).click();
        await f.page.getByText('Happening now', { exact: true }).waitFor();
        f.state.failure = true;
        await f.refresh();
        await f.page.getByText('Could not refresh meetings.', { exact: true }).waitFor();
        assert.equal(await f.page.getByRole('list', { name: 'Calendar events' }).getByRole('listitem').count(), 3);
        f.state.failure = false;
        await f.page.getByRole('button', { name: 'Retry meetings' }).click();
        await f.page.getByText('Could not refresh meetings.', { exact: true }).waitFor({ state: 'hidden' });
        await f.page.clock.fastForward(31 * 60000);
        await f.page.getByText('Meeting 3', { exact: true }).waitFor();
        assert.equal(await f.page.getByText('Meeting 0', { exact: true }).count(), 0);
        f.state.connected = false;
        await f.refresh();
        await f.page.getByRole('region', { name: 'Upcoming meetings' }).waitFor({ state: 'hidden' });
      } finally {
        await f.close();
      }
    });
    await t.test('window boundaries and visibility refresh do not retain a replaced account', async () => {
      const f = await fixture();
      try {
        await f.page.clock.setFixedTime(now);
        f.state.items = [event(8, -60, 0), event(0), event(9, 720, 780)];
        await f.page.goto(`${origin}/${workspace.slug}`);
        await f.page.getByText('Meeting 0', { exact: true }).waitFor();
        assert.equal(await f.page.getByRole('list', { name: 'Calendar events' }).getByRole('listitem').count(), 1);
        const bounds = f.state.requests[0].operation;
        assert.equal(Date.parse(bounds.timeMax) - Date.parse(bounds.timeMin), 12 * 60 * 60 * 1000);
        f.state.generation = 2;
        f.state.items = [event(5, 10, 70)];
        await f.page.clock.setFixedTime(now + 61_000);
        await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await f.page.getByText('Meeting 5', { exact: true }).waitFor();
        assert.equal(await f.page.getByText('Meeting 0', { exact: true }).count(), 0);
        assert.equal(f.state.requests.at(-1).expectedIntegration.generation, 2);
      } finally {
        await f.close();
      }
    });
    await t.test(
      'Show all sends once, preserves unrelated input and recovers uncertain send with exact IDs',
      async () => {
        const f = await fixture();
        try {
          await f.page.goto(`${origin}/${workspace.slug}`);
          const show = f.page.getByRole('button', { name: 'Show all', exact: true });
          await show.waitFor();
          const input = f.page.getByRole('textbox', { name: 'Message', exact: true });
          await input.fill('Unrelated draft');
          assert.equal(await show.isDisabled(), true);
          assert.equal(await input.textContent(), 'Unrelated draft');
          await input.fill('');
          f.state.uncertain = true;
          await show.evaluate(button => {
            button.click();
            button.click();
          });
          await f.page.getByRole('button', { name: 'Retry same operation' }).waitFor();
          assert.equal(f.state.sends.length, 1);
          await f.page.getByRole('button', { name: 'Retry same operation' }).click();
          await f.page.waitForURL(/\/chat\/[\w-]+$/);
          assert.equal(f.state.sends.length, 2);
          assert.deepEqual(f.state.sends[0], f.state.sends[1]);
          assert.equal(f.state.accepted.size, 1);
          assert.match(f.state.sends[0].parts[0].text, /next 12 hours/);
          assert.equal(f.state.sends[0].timeZone, 'America/New_York');
          // Saved results render as a chat card that opens Canvas on request (cloud 51d9a255 #1053, features/chat/calendar-canvas.tsx:48).
          await f.page.getByRole('button', { name: 'Open calendar', exact: true }).click();
          await f.page.getByRole('region', { name: 'Canvas', exact: true }).waitFor();
          assert.equal(
            await f.page.getByRole('region', { name: 'Canvas', exact: true }).getByRole('listitem').count(),
            8,
          );
          await f.page.getByText('More events are available. Ask in chat for the next page.').waitFor();
          await f.page.reload();
          await f.page.getByRole('button', { name: 'Open calendar', exact: true }).click();
          await f.page.getByText('All-day planning', { exact: true }).waitFor();
          assert.equal(f.state.accepted.size, 1);
        } finally {
          await f.close();
        }
      },
    );
    for (const mobile of [false, true])
      for (const theme of ['light', 'dark'])
        await t.test(`${mobile ? 'mobile' : 'desktop'} ${theme} layout and safe links`, async () => {
          const f = await fixture(mobile, theme);
          try {
            await f.page.goto(`${origin}/${workspace.slug}`);
            await f.page.getByRole('list', { name: 'Calendar events' }).waitFor();
            const join = f.page.getByRole('link', { name: 'Join Meeting 0' });
            assert.equal(await join.getAttribute('href'), 'https://meet.google.com/real-room');
            assert.equal(await join.getAttribute('rel'), 'noopener noreferrer');
            assert.equal(await f.page.getByRole('link', { name: 'Join Meeting 1' }).count(), 0);
            await join.focus();
            assert.equal(await join.evaluate(element => element === document.activeElement), true);
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await f.page.screenshot({
              path: new URL(
                `../../../reports/calendar/home-${mobile ? 'mobile' : 'desktop'}-${theme}.png`,
                import.meta.url,
              ).pathname,
              fullPage: true,
            });
            if (mobile) {
              await f.page
                .getByText('Customer review with the operations team and our international distribution partners', {
                  exact: true,
                })
                .scrollIntoViewIfNeeded();
              await f.page.screenshot({
                path: new URL(`../../../reports/calendar/home-mobile-${theme}-meetings.png`, import.meta.url).pathname,
                fullPage: true,
              });
            }
            f.state.saved = true;
            await f.page.goto(`${origin}/${workspace.slug}/chat/${id}`);
            await f.page.getByRole('button', { name: 'Open calendar', exact: true }).click();
            await f.page.getByText('All-day planning', { exact: true }).waitFor();
            assert.equal(
              await f.page.getByRole('region', { name: 'Canvas', exact: true }).getByRole('listitem').count(),
              8,
            );
            assert.equal(
              await f.page
                .getByRole('list', { name: 'Calendar events' })
                .getByRole('listitem')
                .filter({ hasText: 'Overnight review' })
                .locator('p')
                .nth(1)
                .textContent(),
              'Oct 2, 2026 · 11:00 PM – Oct 3, 2026 · 1:00 AM · America/New_York',
            );
            assert.equal(
              await f.page
                .getByRole('list', { name: 'Calendar events' })
                .getByRole('listitem')
                .filter({ hasText: 'Evening review' })
                .locator('p')
                .nth(1)
                .textContent(),
              'Oct 2, 2026 · 7:00 PM – 9:00 PM · America/New_York',
            );
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await f.page.screenshot({
              path: new URL(
                `../../../reports/calendar/chat-${mobile ? 'mobile' : 'desktop'}-${theme}.png`,
                import.meta.url,
              ).pathname,
              fullPage: true,
            });
          } finally {
            await f.close();
          }
        });
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
  }
});
