import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createServer } from 'vite';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';

const originalFetch = globalThis.fetch;
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme',
  slug: 'acme',
  createdAt: '2026-09-27T00:00:00.000Z',
  status: 'ready',
  soulCommit: 'a'.repeat(40),
};
const tableId = '22222222-2222-4222-8222-222222222222';
const requests: { path: string; method: string; body: unknown; credentials: RequestCredentials | undefined }[] = [];
let signedIn = true;
let workspaceStatus = 200;
let tableResponse: unknown = {};
let tableStatus = 200;
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  requests.push({
    path: url.pathname + url.search,
    method: options?.method ?? 'GET',
    body: typeof options?.body === 'string' ? JSON.parse(options.body) : undefined,
    credentials: options?.credentials,
  });
  if (url.pathname === '/v1/auth/get-session')
    return Response.json(signedIn ? { session: { id: 'session' }, user: { id: 'user', name: 'Ada' } } : null);
  if (url.pathname === '/v1/workspaces') return Response.json([workspace], { status: workspaceStatus });
  if (url.pathname === '/v1/workspaces/acme') return Response.json(workspace, { status: workspaceStatus });
  if (url.pathname.endsWith('/governance/me'))
    return Response.json({
      membershipId: '44444444-4444-4444-8444-444444444444',
      role: 'admin',
      teams: [],
      capabilities: { manageGovernance: true, canLeave: true },
    });
  return Response.json(tableResponse, { status: tableStatus });
};
const server = await createServer({
  cacheDir: 'node_modules/.vite-table-tests',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(async () => {
  releaseGuardSessionHold();
  globalThis.fetch = originalFetch;
  await server.close();
});
const { router: appRouter } = await server.ssrLoadModule('/src/router.tsx');
const { releaseGuardSessionHold } = await server.ssrLoadModule('/src/lib/auth.ts');
beforeEach(() => {
  requests.length = 0;
  signedIn = true;
  workspaceStatus = 200;
  tableStatus = 200;
  tableResponse = {};
});
async function load(path: string) {
  const router = createRouter({
    routeTree: appRouter.options.routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer: true,
  });
  await router.load();
  return router;
}

test('table list, creation, and detail routes remain under workspace admission', async () => {
  for (const path of ['/acme/tables', '/acme/tables/new', `/acme/tables/${tableId}`]) {
    const route = await load(path);
    assert.equal(route.state.matches.at(-1)?.status, 'success');
  }
  assert.ok(requests.every(request => request.method === 'GET'));
});

test('signed-out table deep links preserve their exact sign-in destination', async () => {
  signedIn = false;
  const path = `/acme/tables/${tableId}`;
  const route = await load(path);
  const result = route._serverResult;
  assert.equal(result?.type, 'redirect');
  if (result?.type !== 'redirect') throw new Error('Expected sign-in redirect');
  const destination = new URL(result.redirect.headers.get('Location') ?? '', 'https://app.tulipfarm.ai');
  assert.equal(destination.pathname, '/login');
  assert.equal(destination.searchParams.get('redirect'), path);
});

test('lost workspace membership prevents table route admission', async () => {
  workspaceStatus = 404;
  assert.ok((await load(`/acme/tables/${tableId}`)).state.matches.some(match => match.status === 'notFound'));
});

test('table URLs keep valid row search state and drop malformed keys to their defaults', async () => {
  const fieldId = '33333333-3333-4333-8333-333333333333';
  const rowId = '55555555-5555-4555-8555-555555555555';
  const canonical = `/acme/tables/${tableId}?row=${rowId}&q=acme&sort=${fieldId}&dir=desc&field=${fieldId}&op=lte&value=%225%22`;
  const valid = await load(canonical);
  assert.notEqual(valid._serverResult?.type, 'redirect');
  assert.deepEqual(
    { ...valid.state.matches.at(-1)?.search },
    { row: rowId, q: 'acme', sort: fieldId, dir: 'desc', field: fieldId, op: 'lte', value: '5' },
  );
  const typed = await load(
    `/acme/tables/${tableId}?row=${rowId}&q=acme&sort=${fieldId}&dir=desc&field=${fieldId}&op=lte&value=5`,
  );
  assert.equal(
    typed._serverResult?.type === 'redirect' && typed._serverResult.redirect.headers.get('Location'),
    canonical,
    'A hand-typed number stays the same filter value',
  );
  const malformed = await load(`/acme/tables/${tableId}?row=missing&q=ok&sort=name&dir=up&field=1&op=like`);
  assert.equal(
    malformed._serverResult?.type === 'redirect' && malformed._serverResult.redirect.headers.get('Location'),
    `/acme/tables/${tableId}?q=ok`,
  );
  const view = await load(
    `/acme/tables/${tableId}?where=${encodeURIComponent('"status==Open and points>5"')}&order=-${fieldId}&group=${fieldId}&calc=count&cols=${fieldId}`,
  );
  assert.deepEqual(
    { ...view.state.matches.at(-1)?.search },
    { where: 'status==Open and points>5', order: `-${fieldId}`, group: fieldId, calc: 'count', cols: fieldId },
  );
  const list = await load('/acme/tables?q=cust');
  assert.deepEqual({ ...list.state.matches.at(-1)?.search }, { q: 'cust' });
});

test('table chat handoffs keep a typed intent and table ID while dropping malformed IDs', async () => {
  const edit = await load(`/acme?intent=edit-table&tableId=${tableId}`);
  assert.deepEqual({ ...edit.state.matches.at(-1)?.search }, { intent: 'edit-table', tableId });
  const rows = await load(`/acme?intent=add-rows&tableId=${tableId}`);
  assert.deepEqual({ ...rows.state.matches.at(-1)?.search }, { intent: 'add-rows', tableId });
  const malformed = await load('/acme?intent=edit-table&tableId=not-a-table');
  assert.equal(
    malformed._serverResult?.type === 'redirect' && malformed._serverResult.redirect.headers.get('Location'),
    '/acme?intent=edit-table',
  );
  const { tableHandoffPrompt } = await server.ssrLoadModule('/src/features/chat/table-handoff.tsx');
  assert.equal(
    tableHandoffPrompt('edit-table', { id: tableId, label: 'Contacts', revision: 'r7' }),
    `Help me change the fields of the “Contacts” table (table ID ${tableId}, current revision r7). Read its current fields first, ask what I want to change, then propose the schema change for my review.`,
  );
  assert.equal(
    tableHandoffPrompt('add-rows', { id: tableId, label: null, revision: null }),
    `Help me add rows to this table (table ID ${tableId}). Read its current fields first, ask which rows I want to add, then prepare them for my review.`,
  );
});
