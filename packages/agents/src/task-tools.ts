import { z } from 'zod';
import { AccessDenied, type HumanActor, requireTablePermission } from '@tulipfarm/access';
import { type Actor, actorKey, parseActorKey, valueSchema } from '@tulipfarm/tables/definition';
import { activeGeneration, readRecord, readRecords } from '@tulipfarm/tables/store';
import { allTaskKeys, formatTaskKey, parseTaskKey, rowOfTaskNumber, taskKeysReady } from '@tulipfarm/tables/task-keys';
import { runStateOf, runStates, taskFields } from '@tulipfarm/tables/tasks-table';
import { activeMembers } from './members.ts';
import { readTaskDetail } from './row-work.ts';
import { relation, type AgentTransaction } from './store.ts';
import { reminderScheduleSchema, tasksTableId } from './task-reminders.ts';

type TableValue = z.infer<typeof valueSchema>;

const taskKeyInput = z
  .string()
  .trim()
  .regex(/^tul-\d{1,10}$/i)
  .describe('A task key such as TUL-042, from tasks.list or tasks.get.');
const assigneeInput = z
  .string()
  .trim()
  .regex(/^(member|agent):[0-9a-fA-F-]{36}$/)
  .describe("'member:<membershipId>' from members.find, or 'agent:<agentId>' from agents.list.");
const titleInput = z.string().trim().min(1).max(500);
const descriptionInput = z.string().max(100000).describe('Markdown.');
const attachmentsInput = z
  .array(z.uuid())
  .min(1)
  .max(10)
  .describe("attachment-ids from this chat's file blocks, such as a screenshot the person sent, to add to the task.");
const reminderInput = z.strictObject({
  schedule: reminderScheduleSchema.describe(
    'once at an ISO time with offset, or daily, weekdays or weekly at HH:MM. Repeats nudge until the person acts. Weekday 0 is Sunday.',
  ),
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("An IANA time zone for the schedule. Omit to use the workspace's."),
});

export const taskToolCallSchemas = [
  z.strictObject({
    tool: z.literal('tasks.list'),
    assignedToMe: z.boolean().optional().describe('Only tasks assigned to the person in this chat.'),
    assignee: assigneeInput.optional(),
    runState: z
      .enum([...runStates, 'none'])
      .optional()
      .describe("A task's run state; none means not set."),
    search: z.string().trim().min(1).max(200).optional().describe('Words in the title or description.'),
    limit: z.int().min(1).max(50).default(20),
  }),
  z.strictObject({ tool: z.literal('tasks.get'), key: taskKeyInput }),
  z.strictObject({
    tool: z.literal('tasks.create'),
    title: titleInput,
    description: descriptionInput.optional(),
    assignee: assigneeInput.optional(),
    reporter: assigneeInput.optional().describe('Defaults to the person in this chat.'),
    parentKey: taskKeyInput.optional(),
    attachments: attachmentsInput.optional(),
    reminder: reminderInput.optional().describe('Remind the person assignee. Needs a person assignee.'),
  }),
  z.strictObject({
    tool: z.literal('tasks.update'),
    key: taskKeyInput,
    title: titleInput.optional(),
    description: descriptionInput.nullable().optional(),
    parentKey: taskKeyInput.nullable().optional().describe('null removes the parent task.'),
    attachments: attachmentsInput
      .optional()
      .describe("attachment-ids from this chat's file blocks to add to the description."),
    fields: z
      .record(z.uuid(), z.unknown())
      .optional()
      .describe("Values for the workspace's own Tasks fields, keyed by field ID from tasks.get, typed as rows.update."),
  }),
  z.strictObject({
    tool: z.literal('tasks.assign'),
    key: taskKeyInput,
    assignee: assigneeInput.nullable().describe('null removes the assignee.'),
  }),
  z.strictObject({
    tool: z.literal('tasks.comment'),
    key: taskKeyInput,
    body: z.string().trim().min(1).max(20000).describe('Markdown.'),
    attachments: attachmentsInput.max(5).optional(),
    mentions: z.array(z.uuid()).max(50).optional().describe('Membership IDs from members.find to notify.'),
  }),
  z.strictObject({
    tool: z.literal('tasks.remind'),
    key: taskKeyInput,
    action: z.enum(['set', 'cancel']),
    membershipId: z
      .uuid()
      .optional()
      .describe(
        'For set: the person to remind, the assignee or a member mentioned on the task. Defaults to the assignee.',
      ),
    ...reminderInput.partial().shape,
    reminderId: z.uuid().optional().describe('For cancel: the reminder ID from tasks.get.'),
  }),
] as const;
export type TaskToolCall = z.infer<(typeof taskToolCallSchemas)[number]>;
export const taskToolNames: ReadonlySet<string> = new Set(taskToolCallSchemas.map(schema => schema.shape.tool.value));

export const taskToolDescriptions = {
  'tasks.list':
    "List tasks in this workspace's Tasks, newest first, with their keys such as TUL-042, titles, assignees and run states. Filter by assignedToMe, assignee, runState or search words. Changes nothing.",
  'tasks.get':
    "Read one task by its key: title, description, assignee, reporter, run state, parent, the workspace's own fields with their IDs, recent comments, reminders, and the files on the description and comments. Read a file with files.read and its id as source. Changes nothing.",
  'tasks.create':
    'Create a task in Tasks. The person in this chat is the reporter unless you name another. Assigning a person notifies them; assigning an agent starts its work. Optionally remind the person assignee until they act. Pass attachments to add files from this chat, such as a screenshot for a bug; such a task always goes to an approval card. The change may need the person to approve it on a card; never treat chat text as approval.',
  'tasks.update':
    "Change a task's title, description, parent or the workspace's own fields, by key. Use tasks.assign to change the assignee. The change may need the person to approve it on a card; never treat chat text as approval.",
  'tasks.assign':
    'Assign a task to a person or an agent, or remove its assignee, by key. A person is notified; an agent starts working. The change may need the person to approve it on a card.',
  'tasks.comment':
    "Post a comment on a task's thread as the person in this chat, by key. Mentioned members are notified. Post only text the person asked for. Pass attachments to add files from this chat; such a comment, or one in a chat that used outside content, goes to an approval card first.",
  'tasks.remind':
    'Set or cancel a reminder on a task. A reminder nudges the assignee, or a member mentioned on the task, in their Inbox and Slack until they comment or the task is done. Schedule once, daily, on weekdays or weekly. At most 5 active reminders per task.',
} satisfies Record<TaskToolCall['tool'], string>;

export const taskReadTools = ['tasks.list', 'tasks.get'] as const;

/** Chat's generic table tools refuse the Tasks table with this result. */
export const tasksTableRefusal = {
  error: 'tasks-table',
  instruction:
    'This is the Tasks table. Use the tasks.* tools instead: tasks.list, tasks.get, tasks.create, tasks.update, tasks.assign, tasks.comment and tasks.remind. Nothing was changed.',
};

const text = (value: TableValue | undefined) => (value?.kind === 'text' ? value.value : null);
const actorOf = (value: TableValue | undefined) => (value?.kind === 'actor' ? actorKey(value.actor) : null);
const parentOf = (value: TableValue | undefined) =>
  value?.kind === 'relationship' ? (value.recordIds[0] ?? null) : null;
const runStateValue = (value: TableValue | undefined) =>
  runStateOf(value?.kind === 'single-select' ? value.optionId : undefined);
const coreFieldIds: ReadonlySet<string> = new Set(Object.values(taskFields));

export class TaskToolError extends Error {
  readonly result: { error: string; instruction: string };
  constructor(error: string, instruction: string) {
    super(error);
    this.name = 'TaskToolError';
    this.result = { error, instruction };
  }
}
const notFound = () =>
  new TaskToolError('task-not-found', 'No task has this key, or you cannot read it. Use tasks.list to find the key.');

/** The Tasks table and its current revision, readable by the actor. */
export async function readableTasks(tx: AgentTransaction, actor: HumanActor) {
  const tableId = await tasksTableId(tx);
  if (!tableId) throw new TaskToolError('tasks-unavailable', 'This workspace has no Tasks yet.');
  if (!(await taskKeysReady(tx)))
    throw new TaskToolError('tasks-upgrading', 'Tasks are being upgraded. Tell the person and try again later.');
  await requireTablePermission(tx, actor, tableId, 'table.row.read').catch(error => {
    if (error instanceof AccessDenied) throw new TaskToolError('tasks-unavailable', 'You cannot read Tasks.');
    throw error;
  });
  const generation = await activeGeneration(tx, tableId);
  return { tableId, generation };
}

/** The row a key names, with its record. */
export async function taskOfKey(tx: AgentTransaction, actor: HumanActor, key: string) {
  const { tableId, generation } = await readableTasks(tx, actor);
  const number = parseTaskKey(key);
  const rowId = number === null ? null : await rowOfTaskNumber(tx, tableId, number);
  const record = rowId ? await readRecord(tx, generation, rowId) : null;
  if (!record || number === null) throw notFound();
  return { tableId, generation, record, number, key: formatTaskKey(number) };
}

async function names(tx: AgentTransaction, keys: Iterable<string | null>) {
  const actors = [...new Set([...keys].filter((key): key is string => key !== null))].map(parseActorKey);
  const memberIds = actors.filter(actor => actor.type === 'member').map(actor => actor.id);
  const agentIds = actors.filter(actor => actor.type === 'agent').map(actor => actor.id);
  const named = new Map<string, string>();
  if (memberIds.length)
    for (const member of await activeMembers(tx, memberIds))
      named.set(actorKey({ type: 'member', id: member.membershipId }), member.name);
  if (agentIds.length)
    for (const agent of (
      await tx.client.query<{ id: string; display_name: string }>(
        `SELECT id,display_name FROM ${relation(tx, 'tf_agents')} WHERE id=ANY($1::uuid[])`,
        [agentIds],
      )
    ).rows)
      named.set(actorKey({ type: 'agent', id: agent.id }), agent.display_name);
  return (key: string | null) => (key ? (named.get(key) ?? null) : null);
}

export async function listTasks(
  tx: AgentTransaction,
  actor: HumanActor,
  call: Extract<TaskToolCall, { tool: 'tasks.list' }>,
) {
  const { tableId, generation } = await readableTasks(tx, actor);
  const numbers = new Map((await allTaskKeys(tx, tableId)).map(item => [item.rowId, item.number]));
  const me = actorKey({ type: 'member', id: actor.membershipId });
  const assignee = call.assignedToMe ? me : call.assignee ? actorKey(parseActorKey(call.assignee)) : undefined;
  const words = call.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const matches: { number: number; values: Record<string, TableValue> }[] = [];
  let after: string | null = null;
  // Tasks are read in pages; a workspace with more than 10,000 tasks lists only the first 10,000 read.
  for (let page = 0; page < 10; page++) {
    const records = await readRecords(tx, generation, { after, limit: 1000 });
    for (const record of records) {
      const number = numbers.get(record.id);
      if (number === undefined) continue;
      const values = record.values;
      if (assignee !== undefined && actorOf(values[taskFields.assignee]) !== assignee) continue;
      if (call.runState && (runStateValue(values[taskFields.runState]) ?? 'none') !== call.runState) continue;
      if (words.length) {
        const haystack =
          `${text(values[taskFields.title]) ?? ''}\n${text(values[taskFields.description]) ?? ''}`.toLowerCase();
        if (!words.every(word => haystack.includes(word))) continue;
      }
      matches.push({ number, values });
    }
    if (records.length < 1000) break;
    after = records.at(-1)!.id;
  }
  matches.sort((a, b) => b.number - a.number);
  const shown = matches.slice(0, call.limit);
  const nameOf = await names(
    tx,
    shown.flatMap(task => [actorOf(task.values[taskFields.assignee]), actorOf(task.values[taskFields.reporter])]),
  );
  return {
    total: matches.length,
    tasks: shown.map(task => {
      const assigned = actorOf(task.values[taskFields.assignee]);
      const parent = parentOf(task.values[taskFields.parent]);
      const parentNumber = parent ? numbers.get(parent) : undefined;
      return {
        key: formatTaskKey(task.number),
        title: text(task.values[taskFields.title]),
        assignee: assigned,
        assigneeName: nameOf(assigned),
        runState: runStateValue(task.values[taskFields.runState]),
        parentKey: parentNumber === undefined ? null : formatTaskKey(parentNumber),
      };
    }),
    tableId,
    revision: generation.revision,
  };
}

export async function getTask(tx: AgentTransaction, actor: HumanActor, key: string) {
  const task = await taskOfKey(tx, actor, key);
  const detail = await readTaskDetail(tx, actor, task.tableId, task.record.id);
  const values = task.record.values;
  const parent = parentOf(values[taskFields.parent]);
  const parentNumber = parent
    ? (await allTaskKeys(tx, task.tableId)).find(item => item.rowId === parent)?.number
    : undefined;
  const comments = detail.thread.items.filter(item => item.kind === 'comment' && !item.deleted).slice(-20);
  const nameOf = await names(tx, [
    actorOf(values[taskFields.assignee]),
    actorOf(values[taskFields.reporter]),
    ...comments.map(item => (item.author ? actorKey(item.author) : null)),
    ...detail.reminders.reminders.map(reminder => actorKey({ type: 'member', id: reminder.membershipId })),
  ]);
  const fields = task.generation.definition.fields
    .filter(field => !coreFieldIds.has(field.id))
    .map(field => ({ id: field.id, label: field.label, kind: field.kind, value: values[field.id] ?? null }));
  return {
    key: task.key,
    title: text(values[taskFields.title]),
    description: text(values[taskFields.description]),
    assignee: actorOf(values[taskFields.assignee]),
    assigneeName: nameOf(actorOf(values[taskFields.assignee])),
    reporter: actorOf(values[taskFields.reporter]),
    reporterName: nameOf(actorOf(values[taskFields.reporter])),
    runState: detail.runState,
    parentKey: parentNumber === undefined ? null : formatTaskKey(parentNumber),
    fields,
    canEdit: detail.canEdit,
    attachments: detail.attachments,
    comments: comments.map(item => ({
      author: item.author ? actorKey(item.author) : null,
      authorName: nameOf(item.author ? actorKey(item.author) : null),
      body: item.body,
      createdAt: item.createdAt,
      attachments: item.attachments,
    })),
    reminders: detail.reminders.reminders
      .filter(reminder => reminder.status === 'active')
      .map(reminder => ({
        id: reminder.id,
        membershipId: reminder.membershipId,
        name: nameOf(actorKey({ type: 'member', id: reminder.membershipId })),
        schedule: reminder.schedule,
        timeZone: reminder.timeZone,
        nextFireAt: reminder.nextFireAt,
      })),
  };
}

/** The `rows.*` values a task tool writes. Core fields come only from named arguments. */
export async function taskValues(
  tx: AgentTransaction,
  tableId: string,
  call: Extract<TaskToolCall, { tool: 'tasks.create' | 'tasks.update' | 'tasks.assign' }>,
) {
  const values: Record<string, unknown> = {};
  const actorValue = (key: string | null): TableValue =>
    key === null ? null : { kind: 'actor', actor: parseActorKey(key) as Actor };
  const parentValue = async (key: string | null): Promise<TableValue> => {
    if (key === null) return null;
    const number = parseTaskKey(key);
    const rowId = number === null ? null : await rowOfTaskNumber(tx, tableId, number);
    if (!rowId) throw new TaskToolError('parent-not-found', `No task has the key ${key}. Use tasks.list to find it.`);
    return valueSchema.parse({ kind: 'relationship', tableId, recordIds: [rowId] });
  };
  if (call.tool === 'tasks.assign') {
    values[taskFields.assignee] = actorValue(call.assignee);
    return values;
  }
  if (call.tool === 'tasks.update' && call.fields)
    for (const [fieldId, value] of Object.entries(call.fields)) {
      if (coreFieldIds.has(fieldId.toLowerCase()))
        throw new TaskToolError(
          'tasks-field-protected',
          'Change the title, description, parent and assignee with their own arguments or tasks.assign. Run state cannot be set.',
        );
      values[fieldId] = value;
    }
  if (call.title !== undefined) values[taskFields.title] = { kind: 'text', value: call.title };
  if (call.description !== undefined)
    values[taskFields.description] = call.description === null ? null : { kind: 'text', value: call.description };
  if (call.parentKey !== undefined) values[taskFields.parent] = await parentValue(call.parentKey);
  if (call.tool === 'tasks.create') {
    if (call.assignee) values[taskFields.assignee] = actorValue(call.assignee);
    if (call.reporter) values[taskFields.reporter] = actorValue(call.reporter);
  }
  return values;
}
