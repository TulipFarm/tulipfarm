import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

test('integration status recovery and Google review lifecycle', { timeout: 300_000 }, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    envDir: false,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const origin = server.resolvedUrls.local[0].replace(/\/$/, '');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(60000);
  const shots = fileURLToPath(new URL('../../../reports/integrations-refresh/', import.meta.url));
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const proposalId = '22222222-2222-4222-8222-222222222222';
  const integrationId = '33333333-3333-4333-8333-333333333333';
  const workspace = {
    id: workspaceId,
    name: 'QA',
    slug: 'qa-integrations',
    createdAt: '2026-10-02T00:00:00.000Z',
    status: 'ready',
    soulCommit: 'a'.repeat(40),
  };
  const proposal = {
    id: proposalId,
    operation: { kind: 'docs.documents.create', title: 'Exact local fixture' },
    digest: 'a'.repeat(64),
    expiresAt: '2099-10-02T00:00:00.000Z',
    integration: { integrationId, accountId: 'fixture-google', generation: 1, scopes: [], requiredScopes: [] },
    decision: null,
    receipt: null,
  };
  const auth = name => `https://www.googleapis.com/auth/${name}`;
  const allScopes = [
    'openid',
    ...[
      'userinfo.email',
      'gmail.modify',
      'gmail.send',
      'calendar',
      'drive',
      'spreadsheets',
      'documents',
      'presentations',
    ].map(auth),
  ];
  const faults = {
    scopes: allScopes,
    github: 503,
    google: 200,
    shell: 200,
    list: 200,
    session: 200,
    delay: 0,
    shellDelay: 0,
    empty: false,
  };
  let identity = {
    session: { id: 'qa-session', userId: 'qa-user' },
    user: { id: 'qa-user', name: 'QA', email: 'qa@example.test' },
  };
  const writes = [],
    errors = [],
    external = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/v1/')) {
      if (url.origin === origin) return route.continue();
      external.push(url.origin);
      return route.abort();
    }
    let status = 200;
    let json;
    const path = url.pathname;
    // #352 records each signed-in visit; it is not a Google write.
    if (path === '/v1/user/visit')
      return route.fulfill({
        status: 200,
        json: { firstSession: false },
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
      });
    // The shell marks the workspace last used since cloud a5272032 (#972), workspace.tsx:358; it is not a Google write either.
    if (request.method() === 'PUT' && path.endsWith('/last-used'))
      return route.fulfill({
        status: 204,
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
      });
    if (request.method() !== 'GET') {
      writes.push({ path, method: request.method(), body: request.postDataJSON() });
      assert.equal(path, `/v1/workspaces/${workspaceId}/google-workspace/operations/proposals/${proposalId}/decision`);
      proposal.decision = 'approve';
      json = proposal;
    } else if (path.endsWith('/auth/get-session')) {
      status = faults.session;
      json = identity;
    } else if (path === '/v1/workspaces') {
      status = faults.list;
      json = [403, 404].includes(faults.shell) ? [] : [workspace];
    } else if (path === '/v1/workspaces/qa-integrations') {
      await delay(faults.shellDelay);
      status = faults.shell;
      json = workspace;
    } else if (path.endsWith('/governance/me'))
      json = {
        membershipId: '44444444-4444-4444-8444-444444444444',
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith('/google-workspace/availability')) json = { configured: true };
    else if (path.endsWith('/google-workspace')) {
      status = faults.google;
      json =
        status === 200
          ? {
              status: 'connected',
              integrationId,
              generation: 1,
              accountId: 'fixture-google',
              email: 'qa@example.test',
              scopes: faults.scopes,
            }
          : { error: 'integrations-unavailable' };
    } else if (path.endsWith('/operations/proposals'))
      json = {
        proposals: faults.empty
          ? []
          : [
              {
                id: proposalId,
                operationKind: proposal.operation.kind,
                createdAt: '2026-10-02T00:00:00.000Z',
                expiresAt: proposal.expiresAt,
                decision: proposal.decision,
                receiptStatus: null,
              },
            ],
        nextCursor: null,
      };
    else if (path.endsWith(`/operations/proposals/${proposalId}`)) json = proposal;
    else if (path.endsWith('/heartbeat'))
      json = {
        revision: 0,
        integrationId,
        accountId: 'fixture-google',
        generation: 1,
        state: 'disabled',
        gapNotice: null,
        lastError: null,
      };
    else if (path.endsWith('/heartbeat/results')) json = { results: [], nextCursor: null };
    else if (path.endsWith('/github/accounts')) {
      await delay(faults.delay);
      status = faults.github;
      json = status === 200 ? { configured: true, accounts: [] } : { error: 'account-unavailable' };
    } else if (path.endsWith('/integrations')) json = { integrations: [] };
    else if (path.endsWith('/atlassian/accounts')) json = { accounts: [], providers: [] };
    else if (path.endsWith('/slack/status'))
      json = { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] };
    else {
      status = 404;
      json = { error: 'not-found' };
    }
    await route.fulfill({
      status,
      json,
      headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
    });
  });
  const review = page.getByRole('region', { name: 'Exact Google action review', exact: true });
  // Cloud google/proposals.tsx:150 (51d9a255 #1053) renamed the consent to point at Details.
  const checkbox = review.getByRole('checkbox', {
    name: 'I reviewed Details and authorize this exact change',
    exact: true,
  });
  const approve = review.getByRole('button', { name: 'Approve exact Google action', exact: true });
  const statusErrors = page.locator('main [role=alert]');
  async function account(target = page) {
    const toggle = target.getByRole('dialog').getByRole('button', { name: 'Your account', exact: true });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  async function focusRefresh() {
    const reads = [];
    const observe = request => {
      if (
        /\/v1\/(?:google-workspace\/|workspaces\/[^/]+\/(?:github|google-workspace|atlassian|slack|integrations))/.test(
          new URL(request.url()).pathname,
        )
      )
        reads.push(request.url());
    };
    page.on('request', observe);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await delay(500);
    page.off('request', observe);
    assert.deepEqual(reads, [], 'focus performs no provider reads');
  }
  async function refreshProviders() {
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Check app status again', exact: true })
      .evaluate(button => button.click());
    await delay(4000);
  }
  async function checkReview() {
    assert.equal(await review.isVisible(), true);
    assert.equal(await checkbox.isChecked(), true);
    assert.equal(await approve.isEnabled(), true);
    assert.equal(
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Your account', exact: true })
        .getAttribute('aria-expanded'),
      'true',
    );
    assert.deepEqual(JSON.parse(await review.getByLabel('Complete Google action payload').innerText()), {
      kind: 'docs.documents.create',
      title: 'Exact local fixture',
    });
  }
  try {
    await mkdir(shots, { recursive: true });
    await t.test('named failure, slow repeated retry, recovery, and connected Google tiles', async () => {
      faults.delay = 500;
      await page.goto(`${origin}/qa-integrations/integrations`);
      const gitHubRow = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name: 'GitHub', exact: true }) });
      await gitHubRow.getByText('Checking', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Check app status again', exact: true }).waitFor();
      assert.match(await statusErrors.innerText(), /Could not check GitHub/);
      for (const app of ['Gmail', 'Google Calendar', 'Google Drive', 'Google Sheets', 'Google Docs', 'Google Slides']) {
        assert.equal(
          await page
            .getByRole('listitem')
            .filter({ has: page.getByRole('button', { name: app, exact: true }) })
            .getByText('Connected', { exact: true })
            .count(),
          1,
        );
      }
      await page.getByRole('button', { name: 'Check app status again', exact: true }).click();
      await delay(5000);
      await page.getByRole('button', { name: 'Check app status again', exact: true }).waitFor();
      await page.screenshot({ path: `${shots}status-error-desktop.png`, fullPage: true });
      faults.github = 200;
      await page.getByRole('button', { name: 'Check app status again', exact: true }).click();
      await statusErrors.waitFor({ state: 'detached' });
      faults.delay = 0;
    });
    await t.test('a partial Google grant marks missing apps and keeps granted ones connected', async () => {
      faults.scopes = ['openid', auth('userinfo.email'), auth('calendar')];
      await page.goto(`${origin}/qa-integrations/integrations`);
      const row = app =>
        page.getByRole('listitem').filter({ has: page.getByRole('button', { name: app, exact: true }) });
      await row('Google Calendar').getByText('Connected', { exact: true }).waitFor();
      await row('Gmail').getByText('Not granted', { exact: true }).waitFor();
      await row('Gmail').getByRole('button', { name: 'Grant access Gmail', exact: true }).waitFor();
      await row('Gmail').getByRole('button', { name: 'Gmail', exact: true }).click();
      const sheet = page.getByRole('dialog');
      await sheet.getByRole('button', { name: 'Grant access Gmail', exact: true }).waitFor();
      await sheet
        .getByRole('listitem')
        .filter({ hasText: 'Send email' })
        .getByText('Not granted', { exact: true })
        .waitFor();
      assert.equal(await sheet.getByText('Change calendar events').count(), 0);
      await page.screenshot({ path: `${shots}partial-grant-desktop.png` });
      await page.keyboard.press('Escape');
      faults.scopes = allScopes;
    });

    await t.test('a Sheets grant without Drive names the Drive access spreadsheet changes need', async () => {
      faults.scopes = ['openid', auth('userinfo.email'), auth('spreadsheets')];
      await page.goto(`${origin}/qa-integrations/integrations`);
      const row = app =>
        page.getByRole('listitem').filter({ has: page.getByRole('button', { name: app, exact: true }) });
      await row('Google Sheets').getByText('Connected', { exact: true }).waitFor();
      await row('Google Sheets').getByRole('button', { name: 'Google Sheets', exact: true }).click();
      const sheet = page.getByRole('dialog');
      await sheet
        .getByRole('listitem')
        .filter({ hasText: 'Change spreadsheets' })
        .getByText('Needs Google Drive', { exact: true })
        .waitFor();
      assert.equal(
        await sheet
          .getByRole('listitem')
          .filter({ hasText: 'Read spreadsheets' })
          .getByText(/Needs|Not granted/)
          .count(),
        0,
      );
      await sheet.getByText(/Changing spreadsheets also needs Google Drive access/).waitFor();
      await sheet.getByRole('button', { name: 'Grant Google Drive access', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      faults.scopes = allScopes;
    });

    await t.test('an unscoped selector hits another checkbox, named script and pointer and keyboard work', async () => {
      await page.getByRole('button', { name: 'Google Calendar', exact: true }).click();
      await account(page);
      await page.getByRole('dialog').getByRole('checkbox', { name: 'Enable Gmail heartbeat', exact: true }).waitFor();
      await page
        .getByRole('region', { name: 'Action: Create document', exact: true })
        .getByRole('button', { name: 'View action', exact: true })
        .click();
      await checkbox.waitFor();
      const first = page.locator('[role=dialog] [role=checkbox]').first();
      assert.equal(
        await first.evaluate((element, target) => element === target, await checkbox.elementHandle()),
        false,
      );
      await first.evaluate(element => element.click());
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(await approve.isDisabled(), true);
      await checkbox.evaluate(element => element.click());
      assert.equal(await checkbox.isChecked(), true);
      assert.equal(await approve.isEnabled(), true);
      await checkbox.uncheck();
      assert.equal(await approve.isDisabled(), true);
      await checkbox.focus();
      await page.keyboard.press('Space');
      assert.equal(await approve.isEnabled(), true);
      await checkbox.uncheck();
      await checkbox.check();
      assert.equal(await approve.isEnabled(), true);
      // The compact review names its payload disclosure Details since cloud 51d9a255 (#1053), src/features/google/proposals.tsx.
      await review.getByRole('button', { name: 'Details', exact: true }).click();
      await checkReview();
      assert.deepEqual(writes, []);
    });
    await t.test(
      'review survives focus failure, recovery, workspace refresh, tab return, and session timer',
      async () => {
        faults.github = 503;
        await focusRefresh();
        await checkReview();
        assert.equal(await statusErrors.count(), 0);
        faults.github = 200;
        await focusRefresh();
        await checkReview();
        await statusErrors.waitFor({ state: 'detached' });
        faults.shellDelay = 1500;
        await page.evaluate(() => window.dispatchEvent(new Event('tulipfarm:workspace-access-changed')));
        await delay(2500);
        await checkReview();
        const other = await context.newPage();
        await other.bringToFront();
        await delay(1000);
        await page.bringToFront();
        await delay(2500);
        await checkReview();
        await other.close();
        await page.clock.install();
        await page.clock.fastForward(61_000);
        await delay(2500);
        await checkReview();
        await page.clock.resume();
        faults.shellDelay = 0;
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
        await checkbox.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${shots}review-mobile-dark.png`, fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      },
    );
    await t.test('workspace 503 retains the mounted review, blocks approval, and recovers in place', async () => {
      faults.shell = 503;
      await Promise.all([
        page.waitForResponse(
          response => response.url().endsWith('/workspaces/qa-integrations') && response.status() === 503,
        ),
        page.evaluate(() => window.dispatchEvent(new Event('tulipfarm:workspace-access-changed'))),
      ]);
      await delay(300);
      assert.equal(await review.isVisible(), true, 'Workspace 503 must not unmount the exact action review');
      assert.equal(await checkbox.isChecked(), true);
      assert.equal(await approve.isDisabled(), true);
      assert.equal(await review.getByRole('button', { name: 'Reject Google action', exact: true }).isDisabled(), true);
      await approve.evaluate(element => element.click());
      assert.deepEqual(writes, []);
      await page
        .getByRole('dialog')
        .getByText(/Could not refresh workspace access/)
        .waitFor();
      await page.screenshot({ path: `${shots}workspace-stale-mobile-dark.png`, fullPage: true });
      const retry = page.getByRole('dialog').getByRole('button', { name: 'Check workspace access again', exact: true });
      faults.shellDelay = 500;
      await retry.click();
      const checking = page
        .getByRole('dialog')
        .getByRole('button', { name: 'Checking workspace access…', exact: true });
      assert.equal(await checking.isDisabled(), true);
      assert.equal(await checking.getAttribute('aria-busy'), 'true');
      await retry.waitFor();
      assert.equal(await checkbox.isChecked(), true);
      faults.shell = 200;
      await retry.click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          button => button.textContent === 'Approve exact Google action' && !button.matches(':disabled'),
        ),
      );
      await checkReview();
      faults.shellDelay = 0;
      assert.deepEqual(writes, []);
    });
    await t.test('catalog denial conceals private review and recovery requires new authorization', async () => {
      faults.shell = 200;
      await page.goto(`${origin}/qa-integrations/integrations#google-calendar`);
      await account(page);
      for (const denied of [403, 404]) {
        await page
          .getByRole('region', { name: 'Action: Create document', exact: true })
          .getByRole('button', { name: 'View action', exact: true })
          .click();
        await checkbox.check();
        faults.google = denied;
        await account(page);
        await page.getByRole('button', { name: 'Check Google status', exact: true }).click();
        await delay(300);
        assert.equal(
          await page.getByLabel('Complete Google action payload').count(),
          0,
          `Catalog ${denied} must conceal the private payload`,
        );
        faults.google = 200;
        await refreshProviders();
        await account(page);
        await page
          .getByRole('region', { name: 'Action: Create document', exact: true })
          .getByRole('button', { name: 'View action', exact: true })
          .click();
        assert.equal(await checkbox.isChecked(), false);
      }
      await page
        .getByRole('region', { name: 'Action: Create document', exact: true })
        .getByRole('button', { name: 'View action', exact: true })
        .click();
      await checkbox.check();
    });
    await t.test('Google refresh retains review on transient failure but conceals it on access loss', async () => {
      await account(page);
      faults.google = 503;
      await page.getByRole('button', { name: 'Check Google status', exact: true }).click();
      await page.getByText(/Last loaded information remains visible/).waitFor();
      await account(page);
      assert.equal(await review.isVisible(), true);
      assert.equal(await checkbox.isChecked(), true);
      assert.equal(await approve.isDisabled(), true);
      faults.google = 200;
      await refreshProviders();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          button => button.textContent === 'Approve exact Google action' && !button.matches(':disabled'),
        ),
      );
      await checkReview();
      faults.google = 403;
      await account(page);
      await page.getByRole('button', { name: 'Check Google status', exact: true }).click();
      await page.getByLabel('Complete Google action payload').waitFor({ state: 'detached' });
      assert.equal(await page.getByLabel('Complete Google action payload').count(), 0);
      faults.google = 200;
      await refreshProviders();
      await page.getByText('qa@example.test', { exact: true }).last().waitFor();
      await account(page);
      await page
        .getByRole('region', { name: 'Action: Create document', exact: true })
        .getByRole('button', { name: 'View action', exact: true })
        .click();
      assert.equal(await approve.isDisabled(), true);
      await checkbox.check();
      await approve.click();
      // A document create is a file save, labelled by cloud 51d9a255 (#1053), src/features/google/action-state.ts:12.
      await page.getByRole('button', { name: 'Save approved action to Google', exact: true }).waitFor();
      assert.deepEqual(writes, [
        {
          path: `/v1/workspaces/${workspaceId}/google-workspace/operations/proposals/${proposalId}/decision`,
          method: 'POST',
          body: { digest: 'a'.repeat(64), decision: 'approve' },
        },
      ]);
    });
    await t.test('empty proposals and status errors remain actionable on a narrow screen', async () => {
      faults.empty = true;
      await page.getByRole('button', { name: 'Refresh Google proposals', exact: true }).click();
      await page.getByRole('heading', { name: 'No Google proposals', exact: true }).waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      faults.github = 404;
      await page.reload();
      await page.getByRole('button', { name: 'Check app status again', exact: true }).waitFor();
      assert.equal(
        await statusErrors.innerText(),
        'Could not check GitHub. Status is unavailable to your current membership. Check your workspace access.',
      );
      await page.screenshot({ path: `${shots}status-error-mobile-dark.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(writes.length, 1);
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    });
    async function openFreshReview() {
      faults.shell = 200;
      faults.list = 200;
      faults.google = 200;
      faults.github = 200;
      faults.empty = false;
      proposal.decision = null;
      await page.goto('about:blank');
      await page.goto(`${origin}/qa-integrations/integrations#google-calendar`);
      await account(page);
      await page
        .getByRole('region', { name: 'Action: Create document', exact: true })
        .getByRole('button', { name: 'View action', exact: true })
        .click();
      await checkbox.check();
      await checkReview();
    }
    async function invalidateWorkspace() {
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/workspaces/qa-integrations')),
        page.evaluate(() => window.dispatchEvent(new Event('tulipfarm:workspace-access-changed'))),
      ]);
    }
    await t.test('catalog 503 pauses approval without discarding confirmation', async () => {
      await openFreshReview();
      faults.google = 503;
      await account(page);
      await page.getByRole('button', { name: 'Check Google status', exact: true }).click();
      await delay(4000);
      await account(page);
      assert.equal(await checkbox.isChecked(), true);
      assert.equal(await approve.isDisabled(), true);
      faults.google = 200;
      await page.getByRole('dialog').getByRole('button', { name: 'Check app status again', exact: true }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          button => button.textContent === 'Approve exact Google action' && !button.matches(':disabled'),
        ),
      );
      await checkReview();
    });
    await t.test('workspace list denial wins over a simultaneous workspace 503', async () => {
      await openFreshReview();
      faults.shell = 503;
      faults.list = 403;
      await invalidateWorkspace();
      await review.waitFor({ state: 'detached' });
      assert.equal(await page.getByLabel('Complete Google action payload').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Check workspace access again', exact: true }).count(), 0);
    });
    await t.test('workspace list 503 preserves review and overlapping refreshes recover it', async () => {
      await openFreshReview();
      faults.list = 503;
      await invalidateWorkspace();
      await page
        .getByRole('dialog')
        .getByText(/Could not refresh workspace access/)
        .waitFor();
      assert.equal(await checkbox.isChecked(), true);
      assert.equal(await approve.isDisabled(), true);
      faults.list = 200;
      faults.shellDelay = 500;
      await page.evaluate(() => {
        window.dispatchEvent(new Event('tulipfarm:workspace-access-changed'));
        window.dispatchEvent(new Event('tulipfarm:workspace-access-changed'));
      });
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          button => button.textContent === 'Approve exact Google action' && !button.matches(':disabled'),
        ),
      );
      await checkReview();
      faults.shellDelay = 0;
    });
    await t.test('confirmed membership loss removes stale review and restoration needs new confirmation', async () => {
      for (const denied of [403, 404]) {
        await openFreshReview();
        faults.shell = 503;
        await invalidateWorkspace();
        await page
          .getByRole('dialog')
          .getByText(/Could not refresh workspace access/)
          .waitFor();
        faults.shell = denied;
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Check workspace access again', exact: true })
          .click();
        await review.waitFor({ state: 'detached' });
        assert.equal(await page.getByLabel('Complete Google action payload').count(), 0);
        faults.shell = 200;
        await page.goto(`${origin}/qa-integrations/integrations#google-calendar`);
        await account(page);
        await page
          .getByRole('region', { name: 'Action: Create document', exact: true })
          .getByRole('button', { name: 'View action', exact: true })
          .click();
        assert.equal(await checkbox.isChecked(), false);
      }
    });
    await t.test('initial 503 and leaving integrations never admit stale workspace data', async () => {
      faults.shell = 503;
      await page.goto('about:blank');
      await page.goto(`${origin}/qa-integrations/integrations#google-calendar`);
      await page.getByRole('heading', { name: 'Could not open TulipFarm', exact: true }).waitFor();
      assert.equal(await review.count(), 0);
      await openFreshReview();
      faults.shell = 503;
      await invalidateWorkspace();
      await page
        .getByRole('dialog')
        .getByText(/Could not refresh workspace access/)
        .waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page
        .getByRole('navigation', { name: 'Workspace navigation', exact: true })
        .getByRole('link', { name: 'Agents', exact: true })
        .click();
      await page.getByRole('heading', { name: 'Could not open TulipFarm', exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Agents', exact: true }).count(), 0);
    });
    async function refreshSession() {
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/auth/get-session')),
        page.evaluate(() =>
          window.dispatchEvent(
            new StorageEvent('storage', {
              key: 'better-auth.message',
              newValue: JSON.stringify({ event: 'session', data: { trigger: 'signout' } }),
            }),
          ),
        ),
      ]);
    }
    await t.test('focus-driven membership denial conceals the review', async () => {
      await openFreshReview();
      faults.shell = 403;
      await focusRefresh();
      await review.waitFor({ state: 'detached' });
      assert.equal(await page.getByLabel('Complete Google action payload').count(), 0);
    });
    await t.test('session rotation and account change discard private confirmation', async () => {
      await openFreshReview();
      for (const next of [
        { session: { id: 'renewed', userId: 'qa-user' }, user: identity.user },
        {
          session: { id: 'other-session', userId: 'other' },
          user: { id: 'other', name: 'Other', email: 'other@example.test' },
        },
      ]) {
        identity = next;
        await refreshSession();
        await review.waitFor({ state: 'detached' });
        await account(page);
        await page
          .getByRole('region', { name: 'Action: Create document', exact: true })
          .getByRole('button', { name: 'View action', exact: true })
          .click();
        assert.equal(await checkbox.isChecked(), false);
        await checkbox.check();
      }
    });
    await t.test('session 401 conceals a stale review and signed-out refresh opens login', async () => {
      faults.shell = 503;
      await invalidateWorkspace();
      await page
        .getByRole('dialog')
        .getByText(/Could not refresh workspace access/)
        .waitFor();
      await page.screenshot({ path: `${shots}workspace-stale-desktop.png`, fullPage: true });
      faults.session = 401;
      await refreshSession();
      await page.getByRole('heading', { name: 'Sign in to continue', exact: true }).waitFor();
      assert.equal(await review.count(), 0);
      faults.session = 200;
      identity = null;
      await refreshSession();
      await page.waitForURL(/\/login/);
      assert.equal(await page.getByLabel('Complete Google action payload').count(), 0);
      assert.equal(writes.length, 1);
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    t.diagnostic(
      `Chromium ${browser.version()}. Local UI with intercepted API responses. No provider execution. Screenshots in ${shots}`,
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
