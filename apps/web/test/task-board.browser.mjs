import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runStateOptions, taskFields } from '@tulipfarm/tables/tasks-table';
import { membership, credits } from './chat-query.fixture.mjs';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';

// The Tasks page shows the Tasks table as a board by status. Dragging a card marks it done, reopens it or runs
// its agent; drops that would mean nothing are refused, and opening a card shows its details.
const server = await startBuiltApp();
const { origin } = server;
const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-10-01T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
const base = `/v1/workspaces/${workspace.id}`;
const tableId = '55555555-5555-4555-8555-555555555555';
const agentId = '66666666-6666-4666-8666-666666666666';
const revision = 'a'.repeat(40);
const options = Object.entries(runStateOptions).map(([state, id]) => ({ id, label: state, retired: false }));
const definition = {
  formatVersion: 2,
  id: tableId,
  owningTeamId: '33333333-3333-4333-8333-333333333333',
  label: 'Tasks',
  fields: [
    { id: taskFields.title, label: 'Title', kind: 'text', required: true, maxLength: 500 },
    {
      id: taskFields.description,
      label: 'Description',
      kind: 'text',
      required: false,
      maxLength: 100000,
      markdown: true,
    },
    { id: taskFields.assignee, label: 'Assignee', kind: 'actor', required: false, assignee: true },
    { id: taskFields.reporter, label: 'Reporter', kind: 'actor', required: false, assignee: false },
    { id: taskFields.runState, label: 'Run state', kind: 'single-select', required: false, options },
  ],
  uniqueKeys: [],
};
const rowId = n => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const rows = new Map(
  [
    [rowId(1), 'Order new labels', null, null],
    [rowId(2), 'Write the pricing FAQ', null, 'done'],
    [rowId(3), 'Draft the launch note', agentId, 'waiting'],
  ].map(([id, title, agent, state]) => [id, { id, title, agent, state }]),
);
const record = row => ({
  id: row.id,
  token: '88888888-8888-4888-8888-888888888888',
  values: {
    [taskFields.title]: { kind: 'text', value: row.title },
    ...(row.agent && { [taskFields.assignee]: { kind: 'actor', actor: { type: 'agent', id: row.agent } } }),
    ...(row.state && { [taskFields.runState]: { kind: 'single-select', optionId: runStateOptions[row.state] } }),
  },
});
const activity = () => ({
  tableId,
  tasks: [...rows.values()]
    .filter(row => row.agent)
    .map(row => ({
      rowId: row.id,
      agentId: row.agent,
      sponsorMembershipId: membership.membershipId,
      runState: row.state,
      reason: row.state === 'waiting' ? 'Which launch date should the note use?' : null,
      wakeAt: null,
      updatedAt: '2026-11-21T10:00:00.000Z',
      run: null,
      note: null,
    })),
  comments: [],
  me: '99999999-9999-4999-8999-999999999999',
});
const moves = [];

async function routeApi(page) {
  await page.route('**/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (path === '/v1/auth/get-session')
      return json({
        session: { id: 'fixture-session', userId: 'ada' },
        user: { id: 'ada', name: 'Ada', email: 'ada@example.com', lastModelFamilyId: null },
      });
    if (path === '/v1/feature-flags') return json({ 'assignable-tasks': true });
    if (path === '/v1/workspaces') return json([workspace]);
    if (path === '/v1/workspaces/acme') return json(workspace);
    if (path === `${base}/governance/me`) return json(membership);
    if (path === `${base}/credits`) return json(credits);
    if (path === `${base}/tasks-table`) return json({ tableId });
    if (path === `${base}/tasks/activity`) return json(activity());
    if (path === `${base}/tables/${tableId}`)
      return json({
        id: tableId,
        saved: null,
        applied: { revision, definition, appliedAt: workspace.createdAt },
        rowPermissions: { create: true, update: true, delete: true },
        canArchive: false,
        archived: false,
      });
    if (path === `${base}/tables/${tableId}/rows/page`)
      return json({ records: [...rows.values()].map(record), total: String(rows.size), nextCursor: null });
    const done = path.match(/\/rows\/([^/]+)\/(done|run-now)$/);
    if (done) {
      const row = rows.get(done[1]);
      const move = done[2] === 'run-now' ? 'run' : request.method() === 'POST' ? 'done' : 'reopen';
      moves.push([row.title, move]);
      row.state = move === 'run' ? 'queued' : move === 'done' ? 'done' : null;
      return json({ items: [], assignment: null, runs: [] });
    }
    if (path.endsWith('/thread')) return json({ items: [], assignment: null, runs: [] });
    return json({ error: 'unavailable' }, 404);
  });
}

async function until(check, message) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

let browser;
let page;
try {
  browser = await chromium.launch(builderBrowserOptions());
  page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await routeApi(page);

  await page.goto(`${origin}/acme/tasks`);
  const board = page.getByRole('region', { name: 'Tasks by status', exact: true });
  await board.waitFor();
  const card = title => board.getByRole('group', { name: title, exact: true });
  // Cells render in column order: To do, Queued, Working, Needs you, Done.
  const columnOf = title =>
    page.evaluate(name => {
      const cells = [...document.querySelectorAll('[data-task-board] .sprout-board-cell')];
      return cells.findIndex(cell => [...cell.querySelectorAll('[aria-label]')].some(el => el.ariaLabel === name));
    }, title);
  const columns = ['To do', 'Queued', 'Working', 'Needs you', 'Done'];
  const lane = async title => columns[await columnOf(title)];
  const cell = column => page.locator('[data-task-board] .sprout-board-cell').nth(columns.indexOf(column));
  // Drops a card on a column and returns whether the column took it while dragging, then its drop hint.
  const drag = async (title, column) => {
    const from = await card(title).boundingBox();
    const to = await cell(column).boundingBox();
    await page.mouse.move(from.x + 20, from.y + 10);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 20, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + 40, { steps: 12 });
    const drop = await cell(column).getAttribute('data-drop');
    const hint = await cell(column).locator('.sprout-board-drop-text').allInnerTexts();
    await page.mouse.up();
    return [drop, ...hint];
  };

  assert.equal(await lane('Order new labels'), 'To do');
  assert.equal(await lane('Write the pricing FAQ'), 'Done');
  assert.equal(await lane('Draft the launch note'), 'Needs you');
  await card('Draft the launch note').getByText('Which launch date should the note use?').waitFor();

  assert.deepEqual(await drag('Order new labels', 'Done'), ['allowed', 'Drop to mark done']);
  await until(async () => (await lane('Order new labels')) === 'Done', 'The dropped card moves to Done');
  assert.deepEqual(await drag('Write the pricing FAQ', 'To do'), ['allowed', 'Drop to reopen']);
  await until(async () => (await lane('Write the pricing FAQ')) === 'To do', 'The reopened card moves to To do');
  assert.deepEqual(await drag('Draft the launch note', 'Queued'), ['allowed', 'Drop to run the agent']);
  await until(async () => (await lane('Draft the launch note')) === 'Queued', 'The agent is queued to run again');
  assert.deepEqual(moves, [
    ['Order new labels', 'done'],
    ['Write the pricing FAQ', 'reopen'],
    ['Draft the launch note', 'run'],
  ]);

  assert.deepEqual(await drag('Write the pricing FAQ', 'Working'), ['blocked']);
  assert.deepEqual(await drag('Write the pricing FAQ', 'Queued'), ['blocked']);
  assert.equal(await lane('Write the pricing FAQ'), 'To do', 'A task without an agent has nothing to run');
  assert.equal(moves.length, 3, 'Refused drops change nothing');

  await card('Order new labels').click();
  await page.getByRole('dialog', { name: 'Order new labels' }).waitFor();
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Tasks board moves cards by meaning and refuses the rest.');
} catch (error) {
  await captureBrowserFailure(page, 'task-board');
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
