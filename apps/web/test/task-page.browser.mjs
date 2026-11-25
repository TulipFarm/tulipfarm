import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { taskFields } from '@tulipfarm/tables/tasks-table';
import { membership } from './chat-query.fixture.mjs';
import { startBuiltApp, builderBrowserOptions, captureBrowserFailure } from './built-app.fixture.mjs';
import { base, customField, rowId, tableId, tasksApi, teammate, until } from './tasks.fixture.mjs';

// The full-page task at /<workspace>/tasks/<KEY>: an editable title, the property panel, the workspace's own fields,
// reminders with their errors, and a not-found page for unknown keys. The page keeps up with other people on its own.
const server = await startBuiltApp();
const { origin } = server;
const api = tasksApi();

let browser;
let page;
try {
  browser = await chromium.launch(builderBrowserOptions());
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await api.route(page);

  // Keys are case-insensitive.
  await page.goto(`${origin}/acme/tasks/tul-001`);
  await page.getByRole('heading', { name: 'TUL-001' }).waitFor();
  const title = page.getByRole('textbox', { name: 'Title' });
  await until(async () => (await title.inputValue()) === 'Order new labels', 'The task title shows');
  const properties = page.getByRole('complementary', { name: 'Properties' });
  await properties.getByRole('button', { name: /^Status: / }).waitFor();
  await properties.getByRole('button', { name: 'Reporter: Ada' }).waitFor();
  await page.getByRole('region', { name: 'Fields' }).getByRole('textbox', { name: customField.label }).waitFor();

  await title.fill('Order new shipping labels');
  await title.press('Enter');
  await until(() => api.writes.some(([kind]) => kind === 'row'), 'The new title is saved');
  const [, method, , update] = api.writes.find(([kind]) => kind === 'row');
  assert.equal(method, 'POST');
  assert.equal(update.kind, 'update');
  assert.equal(update.recordId, rowId(1));
  assert.deepEqual(update.values, { [taskFields.title]: { kind: 'text', value: 'Order new shipping labels' } });

  // Someone else renames the task and comments; the open page picks both up without a reload.
  api.rows.get(rowId(1)).title = 'Order labels from the new printer';
  api.thread.items.push({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
    kind: 'comment',
    author: { type: 'member', id: teammate.id },
    body: 'The printer can deliver on Thursday.',
    event: null,
    mentions: [],
    createdAt: '2026-11-25T10:00:00.000Z',
    editedAt: null,
    deleted: false,
    mine: false,
  });
  await page.getByText('The printer can deliver on Thursday.').waitFor({ timeout: 15_000 });
  await until(
    async () => (await title.inputValue()) === 'Order labels from the new printer',
    'The new title shows',
    15_000,
  );

  // A weekly reminder in the browser's time zone, then cancelled.
  const reminders = page.getByRole('region', { name: 'Reminders' });
  await reminders.getByText('No reminders.').waitFor();
  await reminders.getByRole('button', { name: 'Add reminder' }).click();
  await reminders.getByRole('combobox', { name: 'Remind' }).waitFor();
  await reminders.getByRole('combobox', { name: 'Repeat' }).click();
  await page.getByRole('option', { name: 'Every week', exact: true }).click();
  await reminders.getByRole('combobox', { name: 'Day' }).click();
  await page.getByRole('option', { name: 'Friday' }).click();
  await reminders.getByLabel('Time', { exact: true }).fill('16:00');
  await reminders.getByRole('button', { name: 'Set reminder' }).click();
  await reminders.getByText(/^Every Friday at /).waitFor();
  const [, reminderRow, body] = api.writes.find(([kind]) => kind === 'reminder');
  assert.equal(reminderRow, rowId(1));
  assert.deepEqual(body, {
    membershipId: membership.membershipId,
    schedule: { kind: 'weekly', time: '16:00', weekday: 5 },
    timeZone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
  });
  await reminders.getByRole('button', { name: 'Cancel reminder for Ada' }).click();
  await reminders.getByText('No reminders.').waitFor();
  assert.deepEqual(api.writes.at(-1), ['cancel reminder', api.reminders[0].id]);

  // Reminder errors are explained.
  await page.route(`**${base}/tables/${tableId}/rows/*/reminders`, route =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 409, json: { error: 'reminder-limit' } })
      : route.fallback(),
  );
  await reminders.getByRole('button', { name: 'Add reminder' }).click();
  await reminders.getByRole('button', { name: 'Set reminder' }).click();
  await reminders.getByRole('alert').getByText('This task already has 5 active reminders. Cancel one first.').waitFor();

  // An unknown key has its own page with a way back.
  await page.goto(`${origin}/acme/tasks/TUL-404`);
  await page.getByText('Task not found').waitFor();
  await page
    .getByRole('link', { name: 'Back to Tasks' })
    .or(page.getByRole('button', { name: 'Back to Tasks' }))
    .click();
  await page.waitForURL(`${origin}/acme/tasks`);
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('Task pages edit tasks, set and cancel reminders, and explain unknown keys.');
} catch (error) {
  console.error('Unmocked API requests:', api.unhandled);
  await captureBrowserFailure(page, 'task-page');
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
