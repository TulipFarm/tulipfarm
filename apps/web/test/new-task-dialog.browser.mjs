import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { taskFields } from '@tulipfarm/tables/tasks-table';
import { membership } from './chat-query.fixture.mjs';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';
import { tableId, tasksApi, teammate, teammatePhoto, until } from './tasks.fixture.mjs';

// The new task dialog: compact chips with the creator as Reporter, a reminder for the assignee set right after the
// task is created, Create more to keep the dialog open for the next task, and ⌘/Ctrl+Enter to create.
const server = await startBuiltApp();
const { origin } = server;
const api = tasksApi();

let browser;
let page;
try {
  browser = await chromium.launch(builderBrowserOptions());
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await api.route(page);

  await page.goto(`${origin}/acme/tasks`);
  await page.getByRole('button', { name: 'New task', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await dialog.waitFor();
  const chip = name => dialog.getByRole('button', { name, exact: true });
  for (const name of [
    'Status: Todo',
    'Assignee: Assignee',
    'Reporter: Ada',
    'Parent task: Parent task',
    'Reminder: Reminder',
    'More fields',
  ])
    await chip(name).waitFor();
  const title = dialog.getByRole('textbox', { name: 'Task title' });
  const description = dialog.getByRole('textbox', { name: 'Description' });

  // A reminder goes to a person assignee.
  await chip('Reminder: Reminder').click();
  await page.getByText('Reminders go to the assignee. Assign the task to a person first.').waitFor();
  await page.keyboard.press('Escape');
  await chip('Assignee: Assignee').click();
  // Every member is listed, not only the person assigning, each with their Members table photo.
  const teammateOption = page.getByRole('option', { name: teammate.name });
  await teammateOption.locator(`img[src$="${teammatePhoto}"]`).waitFor();
  await page.getByRole('option', { name: 'Ada' }).click();
  await chip('Assignee: Ada').waitFor();
  await chip('Reminder: Reminder').click();
  await page.getByRole('combobox', { name: 'Repeat' }).click();
  await page.getByRole('option', { name: 'Every weekday' }).click();
  await page.getByLabel('Time', { exact: true }).fill('08:30');
  await page.getByRole('button', { name: 'Set reminder' }).click();
  await dialog.getByRole('button', { name: /^Reminder: Every weekday at / }).waitFor();

  await dialog.getByRole('switch', { name: 'Create more' }).click();
  await title.fill('Book the van');
  await description.fill('For Friday’s pickup.');
  await title.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');

  await page.getByText('TUL-004 created').waitFor();
  const [, method, path, created] = api.writes.find(([kind]) => kind === 'row');
  assert.equal(method, 'POST');
  assert.equal(path, `/tables/${tableId}/rows`);
  assert.equal(created.kind, 'create');
  assert.deepEqual(created.values[taskFields.title], { kind: 'text', value: 'Book the van' });
  assert.deepEqual(created.values[taskFields.description], { kind: 'text', value: 'For Friday’s pickup.' });
  const me = { kind: 'actor', actor: { type: 'member', id: membership.membershipId } };
  assert.deepEqual(created.values[taskFields.assignee], me);
  assert.deepEqual(created.values[taskFields.reporter], me, 'The creator is the Reporter');
  const [, reminderRow, reminder] = api.writes.find(([kind]) => kind === 'reminder');
  assert.equal(reminderRow, created.recordId, 'The reminder is set on the new task');
  assert.equal(reminder.membershipId, membership.membershipId);
  assert.deepEqual(reminder.schedule, { kind: 'weekdays', time: '08:30' });
  assert.equal(reminder.timeZone, await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone));

  // Create more keeps the dialog open and empty for the next task.
  await until(async () => (await title.inputValue()) === '', 'The title clears for the next task');
  assert.equal(await description.inputValue(), '');
  assert.equal(await dialog.isVisible(), true);

  await dialog.getByRole('switch', { name: 'Create more' }).click();
  await title.fill('Print the labels');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const rows = api.writes.filter(([kind]) => kind === 'row');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[1][3].recordId, created.recordId, 'Each task gets its own row');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('The new task dialog creates tasks with their reminder and keeps going with Create more.');
} catch (error) {
  console.error('Unmocked API requests:', api.unhandled);
  await captureBrowserFailure(page, 'new-task-dialog');
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
