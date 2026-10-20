import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { get } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { createWorkspaceFixture } from './workspace.fixture.mjs';

const port = Number(process.env.CHAT_GOOGLE_PROPOSAL_PORT ?? 5398);
const origin = `http://127.0.0.1:${port}`;
const id = '11111111-1111-4111-8111-111111111111';
const toolId = '22222222-2222-4222-8222-222222222222';
const proposalId = '33333333-3333-4333-8333-333333333333';
const { workspace, session } = createWorkspaceFixture({ slug: 'proposal-qa', name: 'Proposal QA' });
const chat = {
  id,
  title: 'Calendar event',
  titleRevision: 1,
  archived: false,
  activityAt: workspace.createdAt,
  createdAt: workspace.createdAt,
};
const operation = {
  kind: 'calendar.events.create',
  calendarId: 'primary',
  event: {
    summary: 'Launch planning',
    start: { dateTime: '2026-10-12T10:00:00+05:30', timeZone: 'Asia/Kolkata' },
    end: { dateTime: '2026-10-12T17:00:00+05:30', timeZone: 'Asia/Kolkata' },
    attendees: [{ email: 'maya@example.test', displayName: 'Maya' }],
    conferenceData: { createRequest: { requestId: toolId, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
  },
  sendUpdates: 'all',
};
const cdpPort = process.env.GOOGLE_PROPOSAL_CDP_PORT;
let agentConnected = false;
async function screenshot(page, name) {
  if (!process.env.GOOGLE_PROPOSAL_SCREENSHOTS) return;
  await mkdir(process.env.GOOGLE_PROPOSAL_SCREENSHOTS, { recursive: true });
  const path = `${process.env.GOOGLE_PROPOSAL_SCREENSHOTS}/${name}.png`;
  if (cdpPort) {
    agentConnected = true;
    execFileSync('agent-browser', ['--session', 'calendar-canvas', '--cdp', cdpPort, 'screenshot', path], {
      stdio: 'inherit',
    });
  } else await page.screenshot({ path, fullPage: true });
}
function serverReady() {
  return new Promise(resolve => {
    const request = get(origin, { agent: false }, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const upload = {
  kind: 'drive.files.upload',
  mimeType: docx,
  contentBase64: Buffer.from('PK document bytes').toString('base64'),
  file: { name: 'Onboarding guide', mimeType: 'application/vnd.google-apps.document' },
};

async function withChat(operation, prompt, check, options = {}) {
  const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    env: process.env,
  });
  let browser;
  try {
    for (let attempt = 0; ; attempt++) {
      if (await serverReady()) break;
      assert.ok(attempt < 100, 'Vite starts');
      await delay(100);
    }
    browser = await chromium.launch({
      headless: process.env.CHAT_BROWSER_HEADED !== '1',
      ...(cdpPort ? { args: [`--remote-debugging-port=${cdpPort}`] } : {}),
    });
    const context = await browser.newContext({
      viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
      colorScheme: options.theme ?? 'light',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const proposal = {
      id: proposalId,
      operation,
      digest: 'f'.repeat(64),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      integration: { integrationId: id, accountId: 'google-account', generation: 1, scopes: [], requiredScopes: [] },
      decision: null,
      receipt: null,
    };
    const writes = [];
    const state = { readFails: false, pending: false, proposalFails: false, reads: 0 };
    const currentEvent = () => ({
      ...operation.event,
      id: 'created-event',
      summary: operation.event?.summary ?? 'Launch planning',
      start: operation.event?.start ?? { date: '2026-10-12' },
      end: operation.event?.end ?? { date: '2026-10-13' },
      ...(state.pending
        ? { conferenceData: { createRequest: { status: { statusCode: 'pending' } } } }
        : { hangoutLink: 'https://meet.google.com/abc-defg-hij' }),
    });
    await context.route('**/v1/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/v1/user/visit') return route.fulfill({ json: { firstSession: false } });
      if (path === '/v1/feature-flags')
        return route.fulfill({ json: options.disabled ? { 'google-calendar-canvas': false } : {} });
      if (path.endsWith('/last-used')) return route.fulfill({ json: {} });
      if (!['GET', 'OPTIONS'].includes(request.method()) && !path.endsWith('/operations/read'))
        writes.push({ path, body: request.postDataJSON() });
      let json;
      if (path === '/v1/auth/get-session') json = session;
      else if (path === '/v1/workspaces') json = [workspace];
      else if (path === `/v1/workspaces/${workspace.slug}`) json = workspace;
      else if (path.endsWith('/governance/me'))
        json = {
          membershipId: id,
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        };
      else if (path.endsWith('/model-catalog')) json = chatCatalog;
      else if (path.endsWith('/google-workspace/availability')) json = { configured: true };
      else if (path.endsWith('/google-workspace'))
        json = {
          status: 'connected',
          integrationId: id,
          generation: 1,
          accountId: 'google-account',
          email: 'ada@example.test',
          scopes: [],
        };
      else if (path.endsWith('/operations/proposals')) json = { proposals: [], nextCursor: null };
      else if (path.endsWith(`/operations/proposals/${proposalId}/decision`)) {
        proposal.decision = request.postDataJSON().decision;
        json = proposal;
      } else if (path.endsWith(`/operations/proposals/${proposalId}/execute`)) {
        proposal.receipt = {
          status: options.outcome ?? 'succeeded',
          result:
            options.outcome && options.outcome !== 'succeeded'
              ? null
              : { untrusted: true, data: operation.kind === 'calendar.events.delete' ? {} : currentEvent() },
          error:
            options.outcome === 'outcome-unknown'
              ? 'provider-outcome-unknown'
              : options.outcome === 'failed'
                ? 'provider-request-failed'
                : null,
        };
        json = proposal.receipt;
      } else if (path.endsWith(`/operations/proposals/${proposalId}`)) {
        if (state.proposalFails) return route.fulfill({ status: 503, json: { error: 'operation-unavailable' } });
        json = proposal;
      } else if (path.endsWith('/operations/read')) {
        state.reads++;
        if (state.readFails) return route.fulfill({ status: 409, json: { error: 'provider-unavailable' } });
        json = { untrusted: true, data: currentEvent() };
      } else if (path.endsWith('/messages'))
        json = {
          messages: [
            {
              id,
              sequence: 1,
              author: 'human',
              createdAt: workspace.createdAt,
              parts: [{ kind: 'text', text: prompt }],
              turn: { id, status: 'completed', generation: 0 },
              tools: options.calendarResults
                ? []
                : [{ id: toolId, tool: 'google.propose', status: 'completed', googleProposalId: proposalId }],
              calendarResults: options.calendarResults ?? [],
            },
            {
              id: toolId,
              sequence: 2,
              author: 'assistant',
              createdAt: workspace.createdAt,
              parts: [{ kind: 'text', text: 'The calendar event is prepared for review.' }],
              turn: null,
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
    try {
      await page.goto(`${origin}/${workspace.slug}/chat/${id}`);
      await check(page, writes, state, proposal);
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error('Review failure:', errors, await page.locator('body').innerText());
      await page.screenshot({ path: '/tmp/chat-google-review-failure.png' });
      throw error;
    } finally {
      await context.close();
    }
  } finally {
    try {
      if (agentConnected) {
        agentConnected = false;
        execFileSync('agent-browser', ['--session', 'calendar-canvas', 'close'], { stdio: 'inherit' });
      }
    } finally {
      await browser?.close();
      if (server.exitCode === null) {
        const exited = once(server, 'exit');
        server.kill();
        await exited;
      }
    }
  }
}

async function openCalendarAction(page) {
  await page.getByRole('button', { name: 'Open calendar action', exact: true }).click();
}

test(
  'a calendar action opens the canvas, formats the review and creates a real Meet link after approval',
  { timeout: 120000 },
  async () => {
    await withChat(
      operation,
      'Create Launch planning with Maya and a Google Meet link',
      async (page, writes, state) => {
        await openCalendarAction(page);
        const card = page.getByRole('region', { name: 'Exact Google action review', exact: true });
        await card.getByText('Launch planning', { exact: true }).first().waitFor();
        assert.match(await card.innerText(), /Asia\/Kolkata/);
        assert.match(await card.innerText(), /maya@example.test/);
        assert.doesNotMatch(await card.innerText(), /2026-10-12T10:00/);
        assert.equal(await page.getByRole('region', { name: 'Canvas', exact: true }).count(), 1);
        await screenshot(page, 'calendar-create');
        assert.notEqual(
          await page.evaluate(() => document.activeElement?.textContent),
          'Exact action review',
          'the card does not steal focus from the chat',
        );
        const approve = card.getByRole('button', { name: 'Approve exact Google action', exact: true });
        assert.equal(await approve.isDisabled(), true, 'approval needs explicit confirmation');
        await card.getByText('I authorize this exact change').click();
        await approve.click();
        await card.getByText('Exact action approved. You can now execute it once.', { exact: true }).waitFor();
        state.pending = true;
        await card.getByRole('button', { name: 'Execute approved Google action', exact: true }).evaluate(button => {
          button.click();
          button.click();
        });
        await card.getByText('Google confirmed this action succeeded.', { exact: true }).waitFor();
        assert.deepEqual(
          writes.map(write => write.path.split('/').at(-1)),
          ['decision', 'execute'],
        );
        assert.deepEqual(writes[0].body, { digest: 'f'.repeat(64), decision: 'approve' });
        await card.getByText('Google Meet is still being created. Read the event again to check.').waitFor();
        assert.equal(await card.getByRole('link', { name: 'Join Launch planning' }).count(), 0);
        state.pending = false;
        state.readFails = true;
        await card.getByRole('button', { name: 'Check event and Meet link', exact: true }).click();
        await card.getByRole('region', { name: 'Current calendar event' }).getByRole('alert').waitFor();
        state.readFails = false;
        await card.getByRole('button', { name: 'Check event and Meet link', exact: true }).click();
        assert.equal(
          await card.getByRole('link', { name: 'Join Launch planning' }).getAttribute('href'),
          'https://meet.google.com/abc-defg-hij',
        );
        assert.equal(writes.length, 2, 'refreshing a Meet link never repeats a write');
        await screenshot(page, 'calendar-created-meet');
      },
    );
  },
);

for (const kind of ['calendar.events.update', 'calendar.events.delete'])
  test(`${kind} uses a canvas card on mobile with a read-only target and rejection`, { timeout: 120000 }, async () => {
    const action = kind.endsWith('delete')
      ? { kind, calendarId: 'primary', eventId: 'created-event', sendUpdates: 'all' }
      : { ...operation, kind, eventId: 'created-event' };
    await withChat(
      action,
      'Change the calendar event',
      async (page, writes) => {
        await openCalendarAction(page);
        const card = page.getByRole('region', { name: 'Exact Google action review', exact: true });
        await card
          .getByRole('region', { name: 'Current calendar event' })
          .getByText('Launch planning', { exact: true })
          .waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await screenshot(page, kind.endsWith('delete') ? 'calendar-delete-mobile-dark' : 'calendar-update-mobile');
        await card.getByRole('button', { name: 'Reject Google action', exact: true }).click();
        await card.getByText('Rejected. This action cannot run.', { exact: true }).waitFor();
        assert.deepEqual(
          writes.map(write => write.path.split('/').at(-1)),
          ['decision'],
        );
        assert.equal(writes[0].body.decision, 'reject');
        await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
        await openCalendarAction(page);
        await card.getByText('Rejected. This action cannot run.', { exact: true }).waitFor();
      },
      { mobile: true, theme: kind.endsWith('delete') ? 'dark' : 'light' },
    );
  });

for (const outcome of ['succeeded', 'failed', 'outcome-unknown'])
  test(`delete outcome ${outcome} is shown without a replay action`, { timeout: 120000 }, async () => {
    await withChat(
      { kind: 'calendar.events.delete', calendarId: 'primary', eventId: 'created-event' },
      'Delete the event',
      async (page, writes) => {
        await openCalendarAction(page);
        const card = page.getByRole('region', { name: 'Exact Google action review', exact: true });
        await card.getByText('I authorize this exact change').click();
        await card.getByRole('button', { name: 'Approve exact Google action', exact: true }).click();
        await card.getByRole('button', { name: 'Execute approved Google action', exact: true }).click();
        await card
          .getByText({ succeeded: 'Completed', failed: 'Failed', 'outcome-unknown': 'Outcome unknown' }[outcome], {
            exact: true,
          })
          .waitFor();
        if (outcome === 'succeeded')
          await card.getByText('Google confirmed the event was deleted.', { exact: true }).waitFor();
        else
          await card
            .getByRole('alert')
            .filter({ hasText: outcome === 'failed' ? 'Google rejected' : 'outcome is unknown' })
            .waitFor();
        assert.equal(
          await card.getByRole('button', { name: 'Execute approved Google action', exact: true }).count(),
          0,
        );
        await card.getByRole('button', { name: 'Check Google action status', exact: true }).click();
        assert.equal(writes.length, 2);
      },
      { outcome },
    );
  });

for (const unavailable of [false, true])
  test(
    `calendar ${unavailable ? 'unavailable' : 'empty'} read stays separate from write status`,
    { timeout: 120000 },
    async () => {
      const result = unavailable
        ? { kind: 'unavailable', callId: toolId }
        : { kind: 'events', callId: toolId, requestedAt: '2026-10-01T10:00:00Z', events: [], continuation: 'complete' };
      await withChat(
        operation,
        'Read my calendar',
        async page => {
          await page.getByRole('button', { name: 'Open calendar', exact: true }).click();
          const canvas = page.getByRole('region', { name: 'Canvas', exact: true });
          await canvas
            .getByRole('heading', {
              name: unavailable ? 'Calendar result unavailable' : 'No events in this read',
              exact: true,
            })
            .waitFor();
          assert.equal(
            await canvas.getByRole('button', { name: 'Approve exact Google action', exact: true }).count(),
            0,
          );
        },
        { calendarResults: [result] },
      );
    },
  );

test(
  'flag-off retains inline review and prevents Meet approval without blocking rejection',
  { timeout: 120000 },
  async () => {
    await withChat(
      operation,
      'Create an event with Meet',
      async (page, writes) => {
        const card = page.getByRole('region', { name: 'Exact Google action review', exact: true });
        await card
          .getByText(
            'This calendar feature is not enabled for this workspace. You can review its saved status, but cannot approve or execute it here.',
          )
          .waitFor();
        assert.equal(await page.getByRole('button', { name: 'Open calendar action', exact: true }).count(), 0);
        assert.equal(
          await card.getByRole('button', { name: 'Approve exact Google action', exact: true }).isDisabled(),
          true,
        );
        await card.getByRole('button', { name: 'Reject Google action', exact: true }).click();
        await card.getByText('Rejected. This action cannot run.', { exact: true }).waitFor();
        assert.deepEqual(
          writes.map(write => write.path.split('/').at(-1)),
          ['decision'],
        );
      },
      { disabled: true },
    );
  },
);

test(
  'a document upload review shows the file size and downloads the exact file instead of base64',
  { timeout: 120000 },
  async () => {
    await withChat(upload, 'make an onboarding guide in Google Docs', async page => {
      await page.getByRole('button', { name: 'Review in Canvas', exact: true }).click();
      const card = page.getByRole('region', { name: 'Exact Google action review', exact: true });
      await card.getByText('Onboarding guide').first().waitFor();
      assert.equal(await card.getByText(upload.contentBase64).count(), 0, 'raw base64 is never shown');
      await card.getByText(/1 KB/).first().waitFor();
      assert.doesNotMatch(await card.innerText(), /application\/|Mime Type/);
      if (process.env.GOOGLE_PROPOSAL_SCREENSHOTS)
        await card.screenshot({ path: `${process.env.GOOGLE_PROPOSAL_SCREENSHOTS}/document-upload-review.png` });
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        card.getByRole('link', { name: 'Download exact file', exact: true }).click(),
      ]);
      assert.equal(download.suggestedFilename(), 'Onboarding guide.docx');
      assert.equal((await readFile(await download.path())).toString(), 'PK document bytes');
    });
  },
);
