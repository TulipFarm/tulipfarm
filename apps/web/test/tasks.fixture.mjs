import assert from 'node:assert/strict';
import { runStateOptions, taskFields } from '@tulipfarm/tables/tasks-table';
import { membership, credits, governance } from './chat-query.fixture.mjs';

// A workspace whose Tasks API is mocked: three tasks with keys, one teammate and one agent.
export const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'acme',
  name: 'Acme',
  status: 'ready',
  createdAt: '2026-10-01T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};
export const base = `/v1/workspaces/${workspace.id}`;
export const tableId = '55555555-5555-4555-8555-555555555555';
export const agentId = '66666666-6666-4666-8666-666666666666';
export const teammate = governance.members[1];
export const revision = 'a'.repeat(40);
const options = Object.entries(runStateOptions).map(([state, id]) => ({ id, label: state, retired: false }));
export const customField = {
  id: '44444444-4444-4444-8444-444444444441',
  label: 'Due',
  kind: 'text',
  required: false,
  maxLength: 200,
};
export const definition = {
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
    customField,
  ],
  uniqueKeys: [],
};
export const rowId = n => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
export const keyOf = n => `TUL-${String(n).padStart(3, '0')}`;
const token = '88888888-8888-4888-8888-888888888888';

/** Mocks the API for the Tasks pages and records the requests that change something. */
export function tasksApi() {
  const rows = new Map(
    [
      [1, 'Order new labels', null, null],
      [2, 'Write the pricing FAQ', null, 'done'],
      [3, 'Draft the launch note', agentId, 'waiting'],
    ].map(([n, title, agent, state]) => [rowId(n), { id: rowId(n), number: n, title, agent, state, values: {} }]),
  );
  const reminders = [];
  const writes = [];
  const unhandled = [];
  const record = row => ({
    id: row.id,
    token,
    values: {
      [taskFields.title]: { kind: 'text', value: row.title },
      [taskFields.reporter]: { kind: 'actor', actor: { type: 'member', id: membership.membershipId } },
      ...(row.agent && { [taskFields.assignee]: { kind: 'actor', actor: { type: 'agent', id: row.agent } } }),
      ...(row.state && { [taskFields.runState]: { kind: 'single-select', optionId: runStateOptions[row.state] } }),
      ...row.values,
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
    me: membership.membershipId,
  });
  const thread = { items: [], assignment: null, runs: [] };
  const reminderList = id => ({
    reminders: reminders.filter(item => item.rowId === id),
    targets: [membership.membershipId],
    canEdit: true,
  });
  const table = {
    id: tableId,
    saved: null,
    applied: { revision, definition, appliedAt: workspace.createdAt },
    rowPermissions: { create: true, update: true, delete: true },
    canArchive: false,
    archived: false,
  };
  const otherTable = {
    id: '99999999-9999-4999-8999-999999999991',
    label: 'Customers',
    archived: false,
    appliedRevision: revision,
    appliedAt: workspace.createdAt,
    records: 0,
  };

  async function route(page) {
    await page.route('**/v1/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const json = (value, status = 200) => route.fulfill({ status, json: value });
      if (path === '/v1/auth/get-session')
        return json({
          session: { id: 'fixture-session', userId: 'ada' },
          user: { id: 'ada', name: 'Ada', email: 'ada@example.com', lastModelFamilyId: null },
        });
      if (path === '/v1/feature-flags') return json({});
      if (path === '/v1/workspaces') return json([workspace]);
      if (path === '/v1/workspaces/acme') return json(workspace);
      if (path === `${base}/governance/me`) return json(membership);
      if (path === `${base}/governance`) return json(governance);
      if (path === `${base}/credits`) return json(credits);
      if (path === `${base}/actors`)
        return json({
          members: [
            { membershipId: membership.membershipId, name: 'Ada', email: 'ada@example.test', current: true },
            { membershipId: teammate.id, name: teammate.name, email: teammate.email, current: false },
          ],
          agents: [{ id: agentId, name: 'Ops Helper', available: true }],
        });
      if (path === `${base}/tasks-table`) return json({ tableId });
      if (path === `${base}/tasks/activity`) return json(activity());
      if (path === `${base}/tasks/keys`)
        return json({
          tableId,
          keys: [...rows.values()].map(row => ({ rowId: row.id, key: keyOf(row.number), number: row.number })),
        });
      const byKey = path.match(new RegExp(`^${base}/tasks/([^/]+)$`));
      if (byKey) {
        const row = [...rows.values()].find(item => keyOf(item.number) === byKey[1].toUpperCase());
        if (!row) return json({ error: 'not-found' }, 404);
        return json({
          key: keyOf(row.number),
          number: row.number,
          tableId,
          rowId: row.id,
          record: record(row),
          runState: row.state,
          canEdit: true,
          thread,
          reminders: reminderList(row.id),
        });
      }
      if (path === `${base}/tables`) {
        const hidden = url.searchParams.get('excludeSystem') === 'tasks';
        return json({
          tables: hidden ? [otherTable] : [otherTable, { ...otherTable, id: tableId, label: 'Tasks' }],
          nextCursor: null,
        });
      }
      if (path === `${base}/tables/${tableId}`) return json(table);
      if (path === `${base}/tables/${tableId}/rows/page`)
        return json({ records: [...rows.values()].map(record), total: String(rows.size), nextCursor: null });
      const reminder = path.match(/\/rows\/([^/]+)\/reminders(?:\/([^/]+))?$/);
      if (reminder) {
        const body = method === 'POST' ? request.postDataJSON() : null;
        if (body) {
          writes.push(['reminder', reminder[1], body]);
          reminders.push({
            id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(reminders.length + 1).padStart(12, '0')}`,
            tableId,
            rowId: reminder[1],
            membershipId: body.membershipId,
            createdByMembershipId: membership.membershipId,
            schedule: body.schedule,
            timeZone: body.timeZone ?? 'UTC',
            nextFireAt: '2026-11-26T09:00:00.000Z',
            status: 'active',
            stopReason: null,
            firedCount: 0,
            lastFiredAt: null,
            createdAt: '2026-11-25T09:00:00.000Z',
            stoppedAt: null,
          });
        }
        if (method === 'DELETE') {
          writes.push(['cancel reminder', reminder[2]]);
          const item = reminders.find(entry => entry.id === reminder[2]);
          Object.assign(item, { status: 'stopped', stopReason: 'cancelled', nextFireAt: null });
        }
        return json(reminderList(reminder[1]));
      }
      const done = path.match(/\/rows\/([^/]+)\/(done|run-now)$/);
      if (done) {
        const row = rows.get(done[1]);
        const move = done[2] === 'run-now' ? 'run' : method === 'POST' ? 'done' : 'reopen';
        writes.push([move, row.title]);
        row.state = move === 'run' ? 'queued' : move === 'done' ? 'done' : null;
        return json(thread);
      }
      if (path.endsWith('/thread')) return json(thread);
      if (method !== 'GET' && path.startsWith(`${base}/tables/${tableId}/`)) {
        const body = request.postDataJSON();
        writes.push(['row', method, path.slice(base.length), body]);
        return handleRowWrite(json, body);
      }
      unhandled.push(`${method} ${path}`);
      return json({ error: 'unavailable' }, 404);
    });
  }

  // A row create or update; the reply carries the saved record.
  function handleRowWrite(json, body) {
    const id = body.recordId ?? body.id;
    let row = rows.get(id);
    if (!row) {
      row = { id, number: Math.max(...[...rows.values()].map(item => item.number)) + 1, agent: null, state: null };
      rows.set(id, row);
    }
    const values = body.values ?? {};
    row.title = values[taskFields.title]?.value ?? row.title;
    row.values = { ...row.values, ...values };
    delete row.values[taskFields.title];
    return json({ kind: 'available', ...record(row) });
  }

  return { rows, reminders, thread, writes, unhandled, route };
}

export async function until(check, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
