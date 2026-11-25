import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AccessDenied } from '@tulipfarm/access';
import { createWorkspaceRuntime, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { workspaceTableMigrations } from '@tulipfarm/workspaces/table-migrations';
import { createTableService } from '@tulipfarm/tables/service';
import { activeGeneration } from '@tulipfarm/tables/store';
import { taskFields } from '@tulipfarm/tables/tasks-table';
import { createConversations } from '../../conversations/src/index.ts';
import { fixture } from '../../workspace-storage/test/integration/fixture.mjs';
import { createRowWork } from '../src/row-work.ts';
import { createTaskUpkeep } from '../src/task-reminders.ts';
import { createChatTools } from '../src/tools.ts';

async function harness(t) {
  const db = await fixture();
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await db.close();
  });
  const workspace = await db.create(await workspaceTableMigrations());
  const s = `"${workspace.names.schema}"`;
  runtime = createWorkspaceRuntime({
    resolveCredential: async () => ({
      workspaceId: workspace.id,
      generation: 1,
      connectionString: db.login(workspace),
    }),
    replicaCount: 1,
    reservedConnections: 2,
    databaseConnectionBudget: 30,
  });
  const query = async (sql, params) => (await db.platform.query(sql, params)).rows;
  const tables = createTableService(runtime, { readableFiles: async () => new Set() }, commonCompatibility);
  const [{ id: tableId }] = await query(
    `SELECT core_definition->>'id' AS id FROM ${s}.tf_system_tables WHERE kind='tasks'`,
  );
  const { revision } = await runtime.transaction(workspace.id, commonCompatibility, tx =>
    activeGeneration(tx, tableId),
  );
  const base = { tableId, revision };
  const teammate = randomUUID();
  await query(`INSERT INTO ${s}.tf_memberships(id,user_id,role) VALUES($1,$2,'member')`, [teammate, randomUUID()]);
  const member = id => ({ kind: 'actor', actor: { type: 'member', id } });
  const create = (title, values = {}) =>
    tables.mutate(workspace.id, workspace.userId, {
      ...base,
      kind: 'create',
      recordId: randomUUID(),
      values: { [taskFields.title]: { kind: 'text', value: title }, ...values },
    });
  const update = (record, values) =>
    tables.mutate(workspace.id, workspace.userId, {
      ...base,
      kind: 'update',
      recordId: record.id,
      expectedToken: record.token,
      values,
    });
  const remove = record =>
    tables.mutate(workspace.id, workspace.userId, {
      ...base,
      kind: 'delete',
      recordId: record.id,
      expectedToken: record.token,
    });
  const work = createRowWork(runtime, commonCompatibility);
  const upkeep = createTaskUpkeep(runtime);
  const reminder = (row, schedule, membershipId = workspace.membershipId, timeZone = 'UTC') =>
    work.createReminder(workspace.id, workspace.userId, tableId, row.id, { membershipId, schedule, timeZone });
  const stops = async row =>
    (
      await query(
        `SELECT schedule,status,stop_reason FROM ${s}.tf_task_reminders WHERE row_id=$1 ORDER BY created_at`,
        [row.id],
      )
    ).map(item => `${item.schedule}:${item.status}:${item.stop_reason ?? ''}`);
  return {
    workspace,
    s,
    query,
    runtime,
    tables,
    tableId,
    teammate,
    member,
    create,
    update,
    remove,
    work,
    upkeep,
    reminder,
    stops,
  };
}

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

test('tasks get sequential TUL keys, a welcome task once, and lookup by key', { timeout: 60000 }, async t => {
  const { workspace: ws, tableId, create, remove, work, upkeep } = await harness(t);
  const first = await create('Call the logistics partner');
  const second = await create('Confirm pickup time');
  await upkeep.step(ws.id);
  await upkeep.step(ws.id);
  const keys = await work.taskKeys(ws.id, ws.userId);
  assert.equal(keys.tableId, tableId);
  const byNumber = new Map(keys.keys.map(item => [item.number, item]));
  assert.deepEqual(
    keys.keys.map(item => item.key).sort(),
    ['TUL-000', 'TUL-001', 'TUL-002'],
    'The welcome task is TUL-000 and is created once',
  );
  assert.equal(byNumber.get(1).rowId, first.id);
  assert.equal(byNumber.get(2).rowId, second.id);

  const found = await work.taskByKey(ws.id, ws.userId, 'tul-1');
  assert.equal(found.key, 'TUL-001');
  assert.equal(found.rowId, first.id);
  assert.equal(found.tableId, tableId);
  assert.equal((await work.taskByKey(ws.id, ws.userId, 'TUL-002')).rowId, second.id);
  await assert.rejects(work.taskByKey(ws.id, ws.userId, 'TUL-999'), AccessDenied);
  await assert.rejects(work.taskByKey(ws.id, ws.userId, 'nope'), AccessDenied);

  await remove((await work.taskByKey(ws.id, ws.userId, 'TUL-000')).record);
  await remove(second);
  await upkeep.step(ws.id);
  await assert.rejects(work.taskByKey(ws.id, ws.userId, 'TUL-002'), AccessDenied, 'A deleted task is not found');
  const third = await create('Book the van');
  const after = await work.taskKeys(ws.id, ws.userId);
  assert.equal(after.keys.find(item => item.key === 'TUL-003').rowId, third.id, 'Numbers are not reused');
  assert.equal(after.keys.filter(item => item.number === 0).length, 1);
  await assert.rejects(
    work.taskByKey(ws.id, ws.userId, 'TUL-000'),
    AccessDenied,
    'A deleted welcome task does not come back',
  );
});

test('reminders repeat on their schedule, cap at five and check their target', { timeout: 60000 }, async t => {
  const { workspace: ws, tableId, teammate, member, create, work, reminder } = await harness(t);
  const task = await create('Send the invoice', { [taskFields.assignee]: member(ws.membershipId) });

  const once = await reminder(task, { kind: 'once', at: inAnHour() });
  assert.equal(once.reminders[0].schedule.kind, 'once');
  await reminder(task, { kind: 'daily', time: '09:00' });
  const weekdays = await reminder(task, { kind: 'weekdays', time: '09:00' });
  const weekdayFire = new Date(weekdays.reminders.find(item => item.schedule.kind === 'weekdays').nextFireAt);
  assert.ok(![0, 6].includes(weekdayFire.getUTCDay()), 'Weekday reminders skip the weekend');
  const weekly = await reminder(task, { kind: 'weekly', time: '17:30', weekday: 3 });
  const weeklyFire = new Date(weekly.reminders.find(item => item.schedule.kind === 'weekly').nextFireAt);
  assert.equal(weeklyFire.getUTCDay(), 3);
  assert.equal(weeklyFire.getUTCHours(), 17);
  assert.equal(weeklyFire.getUTCMinutes(), 30);
  assert.ok(weeklyFire.getTime() > Date.now());

  const listed = await work.reminders(ws.id, ws.userId, tableId, task.id);
  assert.deepEqual(listed.targets, [ws.membershipId]);
  assert.equal(listed.canEdit, true);
  await reminder(task, { kind: 'daily', time: '13:00' });
  await assert.rejects(reminder(task, { kind: 'daily', time: '14:00' }), { code: 'reminder-limit' });

  const other = await create('Renew the lease', { [taskFields.assignee]: member(ws.membershipId) });
  await assert.rejects(reminder(other, { kind: 'once', at: new Date(Date.now() - 60_000).toISOString() }), {
    code: 'reminder-in-past',
  });
  await assert.rejects(reminder(other, { kind: 'daily', time: '09:00' }, ws.membershipId, 'Mars/Olympus'), {
    code: 'unknown-time-zone',
  });
  await assert.rejects(reminder(other, { kind: 'daily', time: '09:00' }, teammate), { code: 'reminder-target' });
  await work.comment(ws.id, ws.userId, tableId, other.id, { body: 'Can you check this?', mentions: [teammate] });
  await reminder(other, { kind: 'daily', time: '09:00' }, teammate);
  assert.deepEqual(
    (await work.reminders(ws.id, ws.userId, tableId, other.id)).targets.sort(),
    [ws.membershipId, teammate].sort(),
    'A mentioned member can be reminded',
  );

  const cancelled = await work.cancelReminder(ws.id, ws.userId, tableId, task.id, once.reminders[0].id);
  assert.equal(cancelled.reminders.find(item => item.id === once.reminders[0].id).stopReason, 'cancelled');
});

test('due reminders land in the Inbox and stop on comment, done or reassignment', { timeout: 60000 }, async t => {
  const {
    workspace: ws,
    s,
    query,
    tableId,
    teammate,
    member,
    create,
    update,
    work,
    upkeep,
    reminder,
    stops,
  } = await harness(t);
  const task = await create('Send the invoice', { [taskFields.assignee]: member(ws.membershipId) });
  const once = (await reminder(task, { kind: 'once', at: inAnHour() })).reminders[0];
  await reminder(task, { kind: 'daily', time: '09:00' });
  await query(`UPDATE ${s}.tf_task_reminders SET next_fire_at=now()-interval '1 minute' WHERE row_id=$1`, [task.id]);
  await upkeep.step(ws.id);

  const items = (await work.inbox(ws.id, ws.userId)).items.filter(item => item.kind === 'reminder');
  assert.equal(items.length, 2, 'Each due reminder adds an Inbox item');
  assert.ok(items.every(item => item.taskKey === 'TUL-001' && item.rowId === task.id));
  assert.ok(items.some(item => item.reminderId === once.id));
  assert.match(items[0].summary, /^Reminder: TUL-001 Send the invoice$/);
  assert.deepEqual(await stops(task), ['once:stopped:finished', 'daily:active:']);
  const [{ next }] = await query(
    `SELECT next_fire_at>now() AS next FROM ${s}.tf_task_reminders WHERE row_id=$1 AND schedule='daily'`,
    [task.id],
  );
  assert.equal(next, true, 'A repeating reminder moves to its next time');

  await work.comment(ws.id, ws.userId, tableId, task.id, { body: 'On it.', mentions: [] });
  assert.deepEqual(await stops(task), ['once:stopped:finished', 'daily:stopped:commented']);

  const done = await create('File the receipts', { [taskFields.assignee]: member(ws.membershipId) });
  await reminder(done, { kind: 'daily', time: '09:00' });
  await work.completeTask(ws.id, ws.userId, tableId, done.id);
  assert.deepEqual(await stops(done), ['daily:stopped:done']);

  const handed = await create('Order labels', { [taskFields.assignee]: member(ws.membershipId) });
  await reminder(handed, { kind: 'weekdays', time: '09:00' });
  await update(handed, { [taskFields.assignee]: member(teammate) });
  assert.deepEqual(await stops(handed), ['weekdays:stopped:reassigned']);
});

test('assigning a task on create notifies the assignee, but not yourself', { timeout: 60000 }, async t => {
  const { workspace: ws, s, query, teammate, member, create } = await harness(t);
  const theirs = await create('Check the stock', { [taskFields.assignee]: member(teammate) });
  const mine = await create('Check the float', { [taskFields.assignee]: member(ws.membershipId) });
  const open = async row =>
    query(`SELECT membership_id,kind FROM ${s}.tf_inbox_items WHERE row_id=$1 AND resolved_at IS NULL`, [row.id]);
  assert.deepEqual(await open(theirs), [{ membership_id: teammate, kind: 'assigned' }]);
  assert.deepEqual(await open(mine), []);
});

test('table lists can leave out the Tasks table', { timeout: 60000 }, async t => {
  const { workspace: ws, tables, tableId } = await harness(t);
  const ids = async input => (await tables.definitions(ws.id, ws.userId, input)).tables.map(table => table.id);
  assert.ok((await ids({})).includes(tableId), 'Other callers still see the Tasks table');
  assert.ok(!(await ids({ excludeTasks: true })).includes(tableId));
  assert.ok(!(await ids({ excludeTasks: true, sort: 'name' })).includes(tableId));
});

test('chat works with tasks through tasks.* tools and never as table rows', { timeout: 60000 }, async t => {
  const { workspace: ws, runtime, tableId, teammate, member, create } = await harness(t);
  const chatId = randomUUID();
  const chats = createConversations(runtime);
  await chats.create(ws.id, ws.userId, { chatId, commandId: randomUUID() });
  const { turnId } = await chats.send(ws.id, ws.userId, chatId, {
    messageId: randomUUID(),
    commandId: randomUUID(),
    parts: [{ kind: 'text', text: 'Add a task to send the invoice.' }],
  });
  const actor = { kind: 'human', userId: ws.userId, membershipId: ws.membershipId };
  const tools = createChatTools(runtime);
  const call = async input =>
    (
      await tools.invokeWithSources(
        {
          workspaceId: ws.id,
          actor,
          callId: randomUUID(),
          origin: { conversationId: chatId, turnId, sources: [] },
        },
        input,
      )
    ).result;
  const existing = await create('Call the logistics partner', { [taskFields.assignee]: member(teammate) });

  const created = await call({
    tool: 'tasks.create',
    title: 'Send the invoice',
    description: 'Before Friday.',
    assignee: `member:${ws.membershipId}`,
    reminder: { schedule: { kind: 'daily', time: '09:00' }, timeZone: 'UTC' },
  });
  assert.equal(created.key, 'TUL-002');
  assert.equal(created.reminder.set, true);

  const listed = await call({ tool: 'tasks.list', assignedToMe: true, limit: 20 });
  assert.deepEqual(
    listed.tasks.map(task => task.key),
    ['TUL-002'],
  );
  const read = await call({ tool: 'tasks.get', key: 'tul-2' });
  assert.equal(read.title, 'Send the invoice');
  assert.equal(read.description, 'Before Friday.');
  assert.equal(read.reporter, `member:${ws.membershipId}`);
  assert.equal(read.reminders.length, 1);
  assert.equal((await call({ tool: 'tasks.get', key: 'TUL-404' })).error, 'task-not-found');

  await call({ tool: 'tasks.assign', key: 'TUL-002', assignee: `member:${teammate}` });
  assert.equal((await call({ tool: 'tasks.get', key: 'TUL-002' })).assignee, `member:${teammate}`);
  assert.equal((await call({ tool: 'tasks.comment', key: 'TUL-002', body: 'Sent.' })).posted, true);
  const remind = await call({
    tool: 'tasks.remind',
    key: 'TUL-002',
    action: 'set',
    schedule: { kind: 'once', at: new Date(Date.now() - 60_000).toISOString() },
  });
  assert.equal(remind.error, 'reminder-in-past');

  const { revision } = await runtime.transaction(ws.id, commonCompatibility, tx => activeGeneration(tx, tableId));
  const refused = await call({ tool: 'rows.get', tableId, expectedAppliedRevision: revision, recordId: existing.id });
  assert.equal(refused.error, 'tasks-table');
  const listedTables = await call({ tool: 'tables.list', limit: 50 });
  assert.ok(!JSON.stringify(listedTables).includes(tableId), 'tables.list leaves out the Tasks table');
});
