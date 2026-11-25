import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';
import { rowId, tasksApi, until } from './tasks.fixture.mjs';

// The Tasks page shows tasks as a board by status, each card with its key. Dragging a card marks it done, reopens it
// or runs its agent; drops that would mean nothing are refused, and opening a card shows the task's own page. The board
// keeps up on its own: new tasks and run changes appear without a reload, and no column header spins.
const server = await startBuiltApp();
const { origin } = server;
const api = tasksApi();
const moves = api.writes;

let browser;
let page;
try {
  browser = await chromium.launch(builderBrowserOptions());
  page = await browser.newPage({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await api.route(page);

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
  // An earlier drag can leave the board scrolled sideways, so bring both ends into view before grabbing the card.
  const drag = async (title, column) => {
    await cell(column).scrollIntoViewIfNeeded();
    await card(title).scrollIntoViewIfNeeded();
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
    ['done', 'Order new labels'],
    ['reopen', 'Write the pricing FAQ'],
    ['run', 'Draft the launch note'],
  ]);

  assert.deepEqual(await drag('Write the pricing FAQ', 'Working'), ['blocked']);
  assert.deepEqual(await drag('Write the pricing FAQ', 'Queued'), ['blocked']);
  assert.equal(await lane('Write the pricing FAQ'), 'To do', 'A task without an agent has nothing to run');
  assert.equal(moves.length, 3, 'Refused drops change nothing');

  // Someone else adds a task and an agent starts work; the board picks both up by itself.
  const headers = page.locator('[data-task-board] .sprout-board-column-header');
  await until(async () => (await headers.count()) === columns.length, 'Every column has a header');
  assert.equal(await headers.locator('.sprout-status-spin').count(), 0, 'No column header spins');
  api.rows.set(rowId(4), { id: rowId(4), number: 4, title: 'Ship the samples', agent: null, state: null, values: {} });
  api.rows.get(rowId(3)).state = 'working';
  await card('Ship the samples').getByText('TUL-004').waitFor({ timeout: 15_000 });
  await until(async () => (await lane('Ship the samples')) === 'To do', 'The new task lands in To do');
  await until(async () => (await lane('Draft the launch note')) === 'Working', 'The run moves the card to Working');
  const working = headers.nth(columns.indexOf('Working'));
  await working.locator('[data-lane-icon="working"]').waitFor();
  assert.equal(await working.locator('.sprout-status-spin, [data-state="running"]').count(), 0, 'Working is still');
  assert.equal(await headers.locator('.sprout-status-spin').count(), 0, 'No column header spins with work under way');

  await card('Order new labels').getByText('TUL-001').waitFor();
  await card('Draft the launch note').getByText('TUL-003').waitFor();
  // The board ignores the first click straight after a drag ends, so click until the task's page opens.
  await until(async () => {
    if (page.url().endsWith('/acme/tasks/TUL-001')) return true;
    await card('Order new labels').click();
    return page.waitForURL('**/acme/tasks/TUL-001', { timeout: 2000 }).then(
      () => true,
      () => false,
    );
  }, 'Opening a card shows the task on its own page');
  await page.getByRole('heading', { name: 'TUL-001' }).or(page.getByText('TUL-001').first()).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Title' }).inputValue(), 'Order new labels');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Tasks board moves cards by meaning and refuses the rest.');
} catch (error) {
  console.error('Unmocked API requests:', api.unhandled);
  await captureBrowserFailure(page, 'task-board');
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
