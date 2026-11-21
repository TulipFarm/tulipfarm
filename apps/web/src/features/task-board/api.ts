import { z } from 'zod';
import { runStateOf, taskFields, type RunState } from '@tulipfarm/tables/tasks-table';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
import type { TableApi, TableDataRow, TableDefinition } from '@/features/tables/api';
import type { Actor } from '@/features/tables/actors';

const runStateSchema = z.enum(['queued', 'working', 'waiting', 'done', 'failed']);
export const taskActivitySchema = z.object({
  tableId: z.uuid().nullable(),
  tasks: z.array(
    z.object({
      rowId: z.uuid(),
      agentId: z.uuid(),
      sponsorMembershipId: z.uuid(),
      runState: runStateSchema,
      reason: z.string().nullable(),
      wakeAt: z.string().nullable(),
      updatedAt: z.string(),
      run: z
        .object({
          taskId: z.uuid(),
          startedAt: z.string(),
          endedAt: z.string().nullable(),
          outcome: z.string().nullable(),
          steps: z.number(),
        })
        .nullable(),
      note: z.object({ body: z.string(), createdAt: z.string() }).nullable(),
    }),
  ),
  comments: z.array(z.object({ rowId: z.uuid(), count: z.number() })),
  me: z.uuid(),
});
export type TaskActivity = z.infer<typeof taskActivitySchema>;
export type AssignmentActivity = TaskActivity['tasks'][number];

export async function readTaskActivity(workspaceId: string, signal: AbortSignal) {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/tasks/activity`, {
    method: 'GET',
    signal,
    cache: 'no-store',
  });
  const value = await readJson(response, true);
  if (!response.ok)
    throw new TableRequestError(
      response.status,
      responseError(value, 'tasks-unavailable'),
      'Task progress could not be loaded. Try again.',
    );
  return taskActivitySchema.parse(value);
}

/** Most tasks the page loads. Older ones stay in the Tasks table. */
export const taskPageLimit = 300;

/** Reads the Tasks table's rows a page at a time, up to `taskPageLimit`. */
export async function readTaskRows(api: TableApi, table: TableDefinition, signal: AbortSignal) {
  const records: TableDataRow[] = [];
  let after: string | undefined;
  do {
    const page = await api.recordPage(table, {}, after, signal);
    records.push(...page.records);
    after = page.nextCursor ?? undefined;
  } while (after && records.length < taskPageLimit);
  return { records, more: Boolean(after) };
}

export type Lane = 'todo' | 'queued' | 'working' | 'needs-you' | 'done';
export const lanes: readonly { id: Lane; title: string; empty: string }[] = [
  { id: 'todo', title: 'To do', empty: 'Nothing waiting to start.' },
  { id: 'queued', title: 'Queued', empty: 'No agent work waiting for a turn.' },
  { id: 'working', title: 'Working', empty: 'No agent is working right now.' },
  { id: 'needs-you', title: 'Needs you', empty: 'Nothing needs a person.' },
  { id: 'done', title: 'Done', empty: 'Finished tasks show here.' },
];

export type TaskCard = {
  id: string;
  record: TableDataRow;
  title: string;
  description: string;
  assignee: Actor | null;
  reporter: Actor | null;
  state: RunState | null;
  lane: Lane;
  activity: AssignmentActivity | null;
  comments: number;
};

const text = (record: TableDataRow, fieldId: string) => {
  const value = record.values[fieldId];
  return value?.kind === 'text' ? value.value : '';
};
const actor = (record: TableDataRow, fieldId: string): Actor | null => {
  const value = record.values[fieldId];
  return value?.kind === 'actor' ? value.actor : null;
};

const laneOf = (state: RunState | null): Lane =>
  state === 'queued'
    ? 'queued'
    : state === 'working'
      ? 'working'
      : state === 'waiting' || state === 'failed'
        ? 'needs-you'
        : state === 'done'
          ? 'done'
          : 'todo';

/** Joins each row with its agent assignment. The assignment's state wins, since the row's Run state can lag it. */
export function taskCards(records: readonly TableDataRow[], activity: TaskActivity | undefined): TaskCard[] {
  const assignments = new Map(activity?.tasks.map(task => [task.rowId, task]));
  const comments = new Map(activity?.comments.map(item => [item.rowId, item.count]));
  return records.map(record => {
    const assignee = actor(record, taskFields.assignee);
    const assignment = assignments.get(record.id);
    const live = assignment && assignee?.type === 'agent' && assignee.id === assignment.agentId ? assignment : null;
    const value = record.values[taskFields.runState];
    const state = live?.runState ?? (value?.kind === 'single-select' ? runStateOf(value.optionId) : null);
    return {
      id: record.id,
      record,
      title: text(record, taskFields.title) || 'Untitled task',
      description: text(record, taskFields.description),
      assignee,
      reporter: actor(record, taskFields.reporter),
      state,
      lane: laneOf(state),
      activity: live,
      comments: comments.get(record.id) ?? 0,
    };
  });
}
