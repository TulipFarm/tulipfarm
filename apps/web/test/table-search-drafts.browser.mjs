import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { normalizeQueryRequest, TableQueryError } from '@tulipfarm/tables/query';
import { chatCatalog } from './chat-catalog.fixture.mjs';

const port = Number(process.env.TABLE_SEARCH_PORT ?? 5398);
const origin = `http://127.0.0.1:${port}`;
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
});
const workspace = {
  id: randomUUID(),
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-10-02T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const memberId = randomUUID(),
  teamId = randomUUID(),
  tableId = randomUUID();
const revision = 'a'.repeat(40);
const definition = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: teamId,
  label: 'Support tickets',
  fields: [
    { id: randomUUID(), label: 'Subject', kind: 'text', required: true, maxLength: 200 },
    { id: randomUUID(), label: 'Priority', kind: 'numeric', required: false, precision: 5, scale: 0 },
  ],
  uniqueKeys: [],
};
const normalize = request => {
  try {
    return { json: normalizeQueryRequest(definition, request) };
  } catch (error) {
    if (error instanceof TableQueryError)
      return { status: 400, json: { error: 'invalid-query', issues: error.issues } };
    throw error;
  }
};

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
    assert.ok(attempt < 100, 'Vite starts');
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const validations = [];
  await page.route('**/v1/**', async route => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let json;
    if (path === '/v1/auth/get-session')
      json = {
        session: { id: 'session-ada', userId: 'ada' },
        user: { id: 'ada', name: 'Ada', email: 'ada@example.com' },
      };
    else if (path === '/v1/workspaces') json = [workspace];
    else if (path === '/v1/workspaces/acme') json = workspace;
    else if (path.endsWith('/model-catalog')) json = chatCatalog;
    else if (path.endsWith('/governance/me'))
      json = {
        membershipId: memberId,
        role: 'member',
        teams: [{ id: teamId, name: 'Support', description: '', membershipIds: [memberId] }],
        capabilities: { manageGovernance: false, canLeave: true },
      };
    else if (path.endsWith(`/tables/${tableId}`))
      json = {
        id: tableId,
        saved: null,
        applied: { revision, definition, appliedAt: workspace.createdAt },
        rowPermissions: { create: true, update: true, delete: true },
      };
    else if (path.endsWith(`/tables/${tableId}/query/validate`)) {
      const body = request.postDataJSON();
      validations.push(body.request.where);
      const result = normalize(body.request);
      return route.fulfill(
        result.status ? result : { json: { query: result.json.query, rsql: result.json.rsql, references: {} } },
      );
    } else if (path.endsWith(`/tables/${tableId}/query`)) {
      const result = normalize(request.postDataJSON().request);
      return route.fulfill(
        result.status
          ? result
          : {
              json: {
                mode: 'rows',
                query: result.json.query,
                rsql: result.json.rsql,
                references: {},
                records: [],
                total: '0',
                nextCursor: null,
              },
            },
      );
    } else if (path.endsWith(`/tables/${tableId}/schema-history`)) json = { entries: [], nextCursor: null };
    else if (path.endsWith(`/tables/${tableId}/deleted-rows`)) json = { records: [], nextCursor: null };
    else return route.fulfill({ status: 404, json: { error: 'unavailable' } });
    return route.fulfill({ json });
  });

  const applied = 'Priority>=3';
  await page.goto(`${origin}/acme/tables/${tableId}?where=${encodeURIComponent(applied)}`);
  await page.getByRole('heading', { name: 'Support tickets', exact: true }).waitFor();
  const searchButton = page.getByRole('button', { name: /^(Search|“.*”)$/ });
  const tab = name => page.getByRole('tab', { name, exact: true });
  const rsql = page.getByRole('textbox', { name: /^RSQL query/ });
  const where = () => new URL(page.url()).searchParams.get('where');
  const appliedWhere = where();

  await searchButton.click();
  await tab('RSQL').click();
  const initial = await rsql.inputValue();
  assert.ok(initial, 'RSQL opens with the applied query');
  const draft = `${initial};Subject==`;
  await rsql.fill(draft);

  for (const other of ['Ask AI', 'Text']) {
    await tab(other).click();
    await rsql.waitFor({ state: 'detached' });
    await tab('RSQL').click();
    assert.equal(await rsql.inputValue(), draft, `Switching to ${other} and back keeps the RSQL draft`);
  }

  await page.keyboard.press('Escape');
  await rsql.waitFor({ state: 'detached' });
  await searchButton.click();
  await tab('RSQL').click();
  assert.equal(await rsql.inputValue(), draft, 'Closing and reopening Search keeps the RSQL draft');
  assert.equal(where(), appliedWhere, 'A draft never changes the applied query');
  assert.deepEqual(validations, [], 'A draft is not checked until Apply RSQL');

  const next = `${initial};Subject==Printer`;
  await rsql.fill(next);
  await page.getByRole('button', { name: 'Apply RSQL', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('where') !== appliedWhere);
  const nextWhere = where();
  assert.equal(validations.length, 1, 'Apply RSQL checks the draft once');
  await tab('Text').click();
  await tab('RSQL').click();
  assert.equal(await rsql.inputValue(), nextWhere, 'After applying, RSQL shows the applied query');

  assert.deepEqual(errors, []);
  console.log('Table search draft proof passed. Unapplied RSQL survives tab switches and reopening Search.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
