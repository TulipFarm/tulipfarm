import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import { runStateOptions, taskFields, type RunState } from '@tulipfarm/tables/tasks-table';
import type * as Api from '../src/features/task-board/api.ts';
import type * as Moves from '../src/features/task-board/moves.ts';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
after(() => server.close());
const { taskCards } = (await server.ssrLoadModule('/src/features/task-board/api.ts')) as typeof Api;
const { taskMove } = (await server.ssrLoadModule('/src/features/task-board/moves.ts')) as typeof Moves;

const agent = '11111111-1111-4111-8111-111111111111';
const otherAgent = '22222222-2222-4222-8222-222222222222';
const member = '33333333-3333-4333-8333-333333333333';
let next = 0;
const rowId = () => `44444444-4444-4444-8444-${String(++next).padStart(12, '0')}`;

const record = (title: string, options: { assignee?: string; memberAssignee?: boolean; state?: RunState } = {}) =>
  ({
    id: rowId(),
    values: {
      [taskFields.title]: { kind: 'text', value: title },
      ...(options.assignee && {
        [taskFields.assignee]: {
          kind: 'actor',
          actor: { type: options.memberAssignee ? 'member' : 'agent', id: options.assignee },
        },
      }),
      ...(options.state && {
        [taskFields.runState]: { kind: 'single-select', optionId: runStateOptions[options.state] },
      }),
    },
  }) as unknown as Api.TaskCard['record'];

const assignment = (row: { id: string }, runState: Api.AssignmentActivity['runState'], agentId = agent) => ({
  rowId: row.id,
  agentId,
  sponsorMembershipId: member,
  runState,
  reason: null,
  wakeAt: null,
  updatedAt: '2026-11-21T10:00:00.000Z',
  run: null,
  note: null,
});

test('each task lands in the lane for its state, and the live assignment wins over a stale Run state', () => {
  const fresh = record('Order labels');
  const finished = record('Write FAQ', { state: 'done' });
  const failed = record('Send invoices', { state: 'failed' });
  const stale = record('Chase payment', { assignee: agent, state: 'queued' });
  const reassigned = record('Book slot', { assignee: otherAgent, state: 'waiting' });
  const cards = taskCards([fresh, finished, failed, stale, reassigned], {
    tableId: null,
    tasks: [assignment(stale, 'working'), assignment(reassigned, 'working')],
    comments: [{ rowId: stale.id, count: 3 }],
    me: member,
  });
  assert.deepEqual(
    cards.map(card => [card.title, card.lane, card.activity !== null, card.comments]),
    [
      ['Order labels', 'todo', false, 0],
      ['Write FAQ', 'done', false, 0],
      ['Send invoices', 'needs-you', false, 0],
      ['Chase payment', 'working', true, 3],
      ['Book slot', 'needs-you', false, 0],
    ],
  );
});

test('a drop runs the agent, marks done or reopens, and every other drop is refused', () => {
  const [todo, mine, done, queued, working, waiting, agentDone] = taskCards(
    [
      record('No agent'),
      record('Person task', { assignee: member, memberAssignee: true }),
      record('Done by hand', { state: 'done' }),
      record('In line', { assignee: agent }),
      record('Running', { assignee: agent }),
      record('Asked a question', { assignee: agent }),
      record('Agent finished', { assignee: agent }),
    ],
    undefined,
  );
  const live = taskCards(
    [queued, working, waiting, agentDone].map(card => card.record),
    {
      tableId: null,
      tasks: [
        assignment(queued, 'queued'),
        assignment(working, 'working'),
        assignment(waiting, 'waiting'),
        assignment(agentDone, 'done'),
      ],
      comments: [],
      me: member,
    },
  );
  const [inLine, running, asking, finished] = live;
  const moves = (card: Api.TaskCard) =>
    Object.fromEntries(
      (['todo', 'queued', 'working', 'needs-you', 'done'] as const).map(lane => [lane, taskMove(card, lane)]),
    );

  assert.deepEqual(moves(todo), { todo: null, queued: null, working: null, 'needs-you': null, done: 'done' });
  assert.deepEqual(moves(mine), moves(todo), 'A task without an agent has nothing to run');
  assert.deepEqual(moves(done), { todo: 'reopen', queued: null, working: null, 'needs-you': null, done: null });
  assert.deepEqual(moves(inLine), { todo: null, queued: null, working: null, 'needs-you': null, done: 'done' });
  assert.deepEqual(moves(running), { todo: null, queued: null, working: null, 'needs-you': null, done: null });
  assert.deepEqual(moves(asking), { todo: null, queued: 'run', working: null, 'needs-you': null, done: 'done' });
  assert.deepEqual(
    moves(finished),
    { todo: null, queued: 'run', working: null, 'needs-you': null, done: null },
    "An agent's finished task reopens by running again",
  );
});
