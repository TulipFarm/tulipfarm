import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

test('private workspace views respect revocation across concurrent refreshes', { timeout: 150_000 }, async t => {
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
  const browser = await chromium.launch();
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
    operation: { kind: 'docs.documents.create', title: 'PRIVATE-ACCOUNT-A-PAYLOAD' },
    digest: 'a'.repeat(64),
    expiresAt: '2099-10-02T00:00:00.000Z',
    integration: { integrationId, accountId: 'fixture-google', generation: 1, scopes: [], requiredScopes: [] },
    decision: null,
    receipt: null,
  };
  const identity = user => ({
    session: { id: `session-${user}`, userId: user },
    user: { id: user, name: user, email: `${user}@example.test` },
  });

  async function account(target) {
    const toggle = target.getByRole('dialog').getByRole('button', { name: 'Your account', exact: true });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  async function fixture(run) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const faults = {
      shell: 200,
      list: 200,
      google: 200,
      availability: 200,
      session: 200,
      shellDelay: 0,
      listDelay: 0,
      googleDelay: 0,
      availabilityDelay: 0,
    };
    const shellSequence = [],
      writes = [],
      errors = [],
      external = [],
      googleResponses = [];
    let session = identity('A');
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      if (!path.startsWith('/v1/')) {
        if (url.origin === origin) return route.continue();
        external.push(url.href);
        return route.abort();
      }
      if (request.method() === 'OPTIONS')
        return route.fulfill({
          status: 204,
          headers: {
            'access-control-allow-origin': origin,
            'access-control-allow-credentials': 'true',
            'access-control-allow-methods': 'GET,POST,OPTIONS',
            'access-control-allow-headers': 'content-type',
          },
        });
      let status = 200,
        json,
        ms = 0;
      if (path === '/v1/user/visit') json = { firstSession: false };
      // The shell records the last used workspace on entry since cloud a5272032 (#972), pages/workspace.tsx:358; it is not a proposal.
      else if (request.method() === 'PUT' && path === '/v1/workspaces/qa-integrations/last-used') status = 204;
      else if (request.method() !== 'GET') {
        writes.push({ path, user: session?.user.id, body: request.postDataJSON() });
        status = 403;
        json = { error: 'fixture mutation blocked' };
      } else if (path.endsWith('/auth/get-session')) {
        status = faults.session;
        json = session;
      } else if (path === '/v1/workspaces') {
        status = faults.list;
        ms = faults.listDelay;
        json = [workspace];
      } else if (path === '/v1/workspaces/qa-integrations') {
        const next = shellSequence.shift();
        status = next?.status ?? faults.shell;
        ms = next?.delay ?? faults.shellDelay;
        json = workspace;
      } else if (path.endsWith('/governance/me'))
        json = {
          membershipId: workspaceId,
          role: 'member',
          teams: [],
          capabilities: { manageGovernance: false, canLeave: true },
        };
      else if (path.endsWith('/google-workspace/availability')) {
        status = faults.availability;
        ms = faults.availabilityDelay;
        json = { configured: true };
      } else if (path.endsWith('/google-workspace')) {
        status = faults.google;
        ms = faults.googleDelay;
        json = {
          status: 'connected',
          integrationId,
          generation: 1,
          accountId: 'fixture-google',
          email: 'A@example.test',
          scopes: [],
        };
      } else if (path.endsWith('/operations/proposals'))
        json = {
          proposals: [
            {
              id: proposalId,
              operationKind: proposal.operation.kind,
              createdAt: '2026-10-02T00:00:00.000Z',
              expiresAt: proposal.expiresAt,
              decision: null,
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
      else if (path.endsWith('/github/accounts')) json = { configured: true, accounts: [] };
      else if (path.endsWith('/integrations')) json = { integrations: [] };
      else if (path.endsWith('/atlassian/accounts')) json = { accounts: [], providers: [] };
      else if (path.endsWith('/slack/status'))
        json = { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] };
      else status = 503;
      if (status !== 200 && status !== 204) json = { error: 'unavailable' };
      await delay(ms);
      await route
        .fulfill({
          status,
          json,
          headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
        })
        .catch(() => {});
      if (path.endsWith('/google-workspace')) googleResponses.push(status);
    });
    const review = page.getByRole('region', { name: 'Exact Google action review', exact: true });
    // Cloud google/proposals.tsx:150 (51d9a255 #1053) renamed the consent to point at Details.
    const checkbox = review.getByRole('checkbox', {
      name: 'I reviewed Details and authorize this exact change',
      exact: true,
    });
    const approve = review.getByRole('button', { name: 'Approve exact Google action', exact: true });
    const invalidate = () => page.evaluate(() => window.dispatchEvent(new Event('tulipfarm:workspace-access-changed')));
    const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const failedGoogleRefresh = async () => {
      const before = googleResponses.length;
      await page.getByRole('dialog').getByRole('button', { name: 'Check app status again', exact: true }).click();
      for (let attempt = 0; googleResponses.length < before + 3; attempt++) {
        assert.ok(attempt < 300, 'Transient read completes its two retries');
        await delay(20);
      }
      assert.deepEqual(googleResponses.slice(before), [503, 503, 503]);
      await delay(100);
      await concealed();
    };
    const refreshSession = async next => {
      session = next;
      await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/auth/get-session')),
        page.evaluate(() =>
          window.dispatchEvent(
            new StorageEvent('storage', {
              key: 'better-auth.message',
              newValue: JSON.stringify({ event: 'session', data: { trigger: 'signout' } }),
            }),
          ),
        ),
      ]);
    };
    async function concealed() {
      assert.equal(
        await page.getByLabel('Complete Google action payload').count(),
        0,
        'Confirmed denial or identity change must conceal the private payload immediately',
      );
      assert.equal(await checkbox.count(), 0, 'Old authorization must be unmounted');
      assert.deepEqual(writes, [], 'No old proposal may be submitted by the next identity');
    }
    try {
      await page.goto(`${origin}/qa-integrations/integrations#google-calendar`);
      await account(page);
      await page
        .getByRole('region', { name: 'Action: Create document', exact: true })
        .getByRole('button', { name: 'View action', exact: true })
        .click();
      await checkbox.check();
      assert.equal(await approve.isEnabled(), true);
      assert.deepEqual(
        JSON.parse(await page.getByLabel('Complete Google action payload').innerText()),
        proposal.operation,
      );
      await delay(150);
      await run({
        page,
        faults,
        shellSequence,
        review,
        checkbox,
        approve,
        invalidate,
        focus,
        refreshSession,
        concealed,
        failedGoogleRefresh,
      });
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
    } finally {
      await context.close();
    }
  }

  try {
    for (const denied of [403, 404])
      await t.test(`focus ${denied} cannot become retained data after invalidation 503`, () =>
        fixture(async f => {
          f.faults.shell = 503;
          f.shellSequence.push({ status: denied, delay: 0 });
          await f.focus();
          await delay(350);
          await f.concealed();
          await f.invalidate();
          await delay(350);
          await f.concealed();
          f.faults.shell = 200;
          await f.page.getByRole('button', { name: 'Try again', exact: true }).click();
          await account(f.page);
          await f.page
            .getByRole('region', { name: 'Action: Create document', exact: true })
            .getByRole('button', { name: 'View action', exact: true })
            .click();
          assert.equal(await f.checkbox.isChecked(), false);
        }),
      );
    for (const statuses of [
      [403, 503],
      [503, 403],
      [200, 403],
    ])
      await t.test(`overlap ${statuses.join('/')} cannot resurrect revoked review`, () =>
        fixture(async f => {
          f.faults.shell = 503;
          f.shellSequence.push({ status: statuses[0], delay: 700 }, { status: statuses[1], delay: 50 });
          await Promise.all([
            f.page.waitForRequest(r => r.url().endsWith('/workspaces/qa-integrations')),
            f.invalidate(),
          ]);
          await f.invalidate();
          await delay(1000);
          await f.concealed();
          await f.invalidate();
          await delay(350);
          await f.concealed();
        }),
      );
    await t.test('immediate workspace denial conceals before slow list failure', () =>
      fixture(async f => {
        f.faults.shell = 403;
        f.faults.list = 503;
        f.faults.listDelay = 2500;
        await Promise.all([
          f.page.waitForResponse(r => r.url().endsWith('/workspaces/qa-integrations') && r.status() === 403),
          f.invalidate(),
        ]);
        await delay(350);
        await f.concealed();
      }),
    );
    for (const stale of [false, true])
      for (const next of [identity('B'), { ...identity('A'), session: { id: 'rotated-A', userId: 'A' } }, null])
        await t.test(
          `${stale ? 'stale' : 'fresh'} review concealed during ${next?.session.id ?? 'signout'} revalidation`,
          () =>
            fixture(async f => {
              if (stale) {
                f.faults.shell = 503;
                await f.invalidate();
                await f.page
                  .getByRole('dialog')
                  .getByText(/Could not refresh workspace access/)
                  .waitFor();
              }
              f.faults.shell = 503;
              f.faults.shellDelay = 2500;
              await f.refreshSession(next);
              await delay(350);
              if ((await f.approve.isVisible()) && (await f.approve.isEnabled())) await f.approve.click();
              await f.concealed();
              assert.equal(await f.page.getByRole('button', { name: 'Account menu', exact: true }).count(), 0);
              await delay(2500);
              await f.concealed();
            }),
        );
    await t.test('manual Google refresh cannot mask denial behind availability failure', () =>
      fixture(async f => {
        await account(f.page);
        f.faults.availability = 503;
        f.faults.google = 403;
        f.faults.googleDelay = 400;
        await f.page.getByRole('button', { name: 'Check Google status', exact: true }).click();
        await delay(600);
        await f.concealed();
        f.faults.google = 503;
        await f.failedGoogleRefresh();
        f.faults.google = 200;
        f.faults.availability = 200;
        await f.page.getByRole('dialog').getByRole('button', { name: 'Check app status again', exact: true }).click();
        await account(f.page);
        await f.page
          .getByRole('region', { name: 'Action: Create document', exact: true })
          .getByRole('button', { name: 'View action', exact: true })
          .click();
        assert.equal(await f.checkbox.isChecked(), false);
      }),
    );
    for (const availabilityDelay of [0, 2500])
      await t.test(`Google denial wins over availability failure delayed ${availabilityDelay}ms`, () =>
        fixture(async f => {
          f.faults.availability = 503;
          f.faults.availabilityDelay = availabilityDelay;
          f.faults.google = 403;
          f.faults.googleDelay = 400;
          // Feature reads no longer run on focus. The user's status check starts the same denial race.
          await account(f.page);
          await Promise.all([
            f.page.waitForResponse(r => r.url().endsWith('/google-workspace') && r.status() === 403),
            f.page.getByRole('button', { name: 'Check Google status', exact: true }).click(),
          ]);
          await delay(150);
          await f.concealed();
          f.faults.google = 503;
          f.faults.availabilityDelay = 0;
          await f.failedGoogleRefresh();
          f.faults.google = 200;
          f.faults.availability = 200;
          await f.page.getByRole('dialog').getByRole('button', { name: 'Check app status again', exact: true }).click();
          await account(f.page);
          await f.page
            .getByRole('region', { name: 'Action: Create document', exact: true })
            .getByRole('button', { name: 'View action', exact: true })
            .click();
          assert.equal(await f.checkbox.isChecked(), false, 'Recovery requires a fresh confirmation');
        }),
      );
    await t.test('Agents and account identity are concealed on background session 401', () =>
      fixture(async f => {
        await f.page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
        await f.page
          .getByRole('navigation', { name: 'Workspace navigation' })
          .getByRole('link', { name: 'Agents', exact: true })
          .click();
        const agents = f.page.getByRole('heading', { name: 'Agents', exact: true });
        await agents.waitFor();
        assert.equal(await f.page.getByRole('button', { name: 'Account menu', exact: true }).innerText(), 'A\nA');
        f.faults.session = 401;
        await f.refreshSession(identity('A'));
        await delay(350);
        assert.equal(await agents.count(), 0, 'Shared shell must conceal sibling pages on session denial');
        assert.equal(await f.page.getByRole('button', { name: 'Account menu', exact: true }).count(), 0);
        await f.page.getByRole('heading', { name: 'Sign in to continue', exact: true }).waitFor();
        f.faults.session = 200;
        await f.refreshSession(identity('A'));
        await agents.waitFor();
        assert.equal(await f.page.getByRole('button', { name: 'Account menu', exact: true }).innerText(), 'A\nA');
      }),
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
