/* oxlint-disable tulipfarm/product-copy -- Draft states, hostnames and fixture copy, not application copy. */
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createBuiltAppServer as createServer } from './built-app.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'northstar',
  name: 'Northstar Studio',
  status: 'ready',
  createdAt: '2026-10-01T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const appId = '33333333-3333-4333-8333-333333333333';
const liveReleaseId = '55555555-5555-4555-8555-555555555555';
const builtDraft = { revision: 4, headCommit: 'c4', previewBuildId: null, buildId: 'bld-4', commit: 'c4' };

const appDetail = draft => ({
  id: appId,
  kind: 'public',
  slug: 'order-desk',
  title: 'Order desk',
  publicName: draft.state === 'live' ? 'order-desk' : null,
  webAddress: draft.state === 'live' ? 'order-desk.tulipfarm.site' : null,
  role: 'edit',
  approval: { state: 'not-requested' },
  liveReleaseId: draft.state === 'live' ? liveReleaseId : null,
  edgeStatus: draft.state === 'live' ? 'active' : null,
  stops: { disabledAt: null, editorPausedAt: null, budgetPausedAt: null },
  draft,
  liveRelease: draft.state === 'live' ? { id: liveReleaseId, number: 1, commit: 'c4' } : null,
  sitesDomain: 'tulipfarm.site',
});

/** Stands in for the preview gateway: redeems the posted ticket, then serves the draft server's GET /. */
async function draftHost(t) {
  const seen = [];
  const server = createHttpServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push(`${request.method} ${request.url}${body ? ` ${body}` : ''}`);
    if (request.method === 'POST') return response.writeHead(303, { location: '/' }).end();
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><title>Order desk</title><h1>Track an order</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { seen, entryUrl: `http://127.0.0.1:${server.address().port}/__tulipfarm/preview` };
}

async function editPane(t, draft, { ticketFailure = null } = {}) {
  const host = await draftHost(t);
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
  });
  const page = await browser.newPage();
  const tickets = [];
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json;
    if (path === '/v1/auth/get-session')
      json = { session: { id: 'session', userId: 'viewer' }, user: { id: 'viewer', name: 'Mira', email: 'm@x.test' } };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === '/v1/workspaces/northstar') json = workspace;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: workspace.id,
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith('/model-catalog')) json = chatCatalog;
    else if (path === '/v1/user/visit') json = { firstSession: false };
    else if (path.endsWith('/credits'))
      json = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
    else if (path.endsWith('/last-used')) return route.fulfill({ status: 204 });
    else if (path.endsWith('/apps')) json = { apps: [appDetail(draft)] };
    else if (path.endsWith(`/apps/${appId}`)) json = appDetail(draft);
    else if (path.endsWith(`/apps/${appId}/preview-tickets`)) {
      tickets.push(route.request().method());
      if (ticketFailure) return route.fulfill({ status: 503, json: { failure: ticketFailure } });
      json = { ticket: 'ticket-1', entryUrl: host.entryUrl };
    } else if (path.endsWith(`/apps/${appId}/chat`)) json = { chatId: '44444444-4444-4444-8444-444444444444' };
    else return route.fulfill({ status: 404, json: { error: 'Not found' } });
    await route.fulfill({ json });
  });
  await page.goto(`${server.resolvedUrls.local[0]}northstar/apps/order-desk/edit`);
  await page.getByRole('heading', { name: 'Draft', exact: true }).waitFor({ timeout: 30_000 });
  return { page, host, tickets };
}

test('a built server draft runs in the Edit pane through a preview ticket, without workspace data', async t => {
  const { page, host, tickets } = await editPane(t, { ...builtDraft, state: 'preview-ready' });
  const frame = page.frameLocator('iframe[title="Draft of Order desk"]');
  await frame.getByRole('heading', { name: 'Track an order' }).waitFor();
  assert.deepEqual(tickets, ['POST']);
  assert.deepEqual(host.seen, ['POST /__tulipfarm/preview ticket=ticket-1', 'GET /']);
  await page.getByText('This draft runs without your workspace data. Data appears after you publish.').waitFor();
  assert.equal(await page.getByText('This draft can’t run here yet').count(), 0);
  await page.getByRole('button', { name: 'Open in new tab' }).first().waitFor();
});

test('a published server draft also runs in the Edit pane', async t => {
  const { page, tickets } = await editPane(t, { ...builtDraft, state: 'live' });
  await page
    .frameLocator('iframe[title="Draft of Order desk"]')
    .getByRole('heading', { name: 'Track an order' })
    .waitFor();
  assert.deepEqual(tickets, ['POST']);
  await page.getByText('This draft runs without your workspace data. Data appears after you publish.').waitFor();
  assert.equal(await page.getByText('This draft is live').count(), 0);
});

test('a server draft whose ticket is refused says why and offers a reload', async t => {
  const { page, host } = await editPane(
    t,
    { ...builtDraft, state: 'preview-ready' },
    { ticketFailure: { code: 'host-unavailable', message: 'unavailable' } },
  );
  const alert = page.getByRole('alert').filter({ hasText: 'Could not open the draft' });
  await alert.waitFor();
  await alert.getByRole('button', { name: 'Reload' }).waitFor();
  assert.deepEqual(host.seen, []);
});

test('a static draft shows no server data note', async t => {
  const { page } = await editPane(t, { ...builtDraft, previewBuildId: 'bld-4', state: 'preview-ready' });
  await page
    .frameLocator('iframe[title="Draft of Order desk"]')
    .getByRole('heading', { name: 'Track an order' })
    .waitFor();
  assert.equal(await page.getByText('This draft runs without your workspace data.').count(), 0);
});
