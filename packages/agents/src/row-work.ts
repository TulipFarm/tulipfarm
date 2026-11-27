import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  definitionGrantPredicate,
  type HumanActor,
  lockAndResolveHuman,
  requireTablePermission,
} from '@tulipfarm/access';
import { valuesSchema } from '@tulipfarm/tables/definition';
import { activeGeneration, readRecord, writeRunState } from '@tulipfarm/tables/store';
import {
  allTaskKeys,
  formatTaskKey,
  parseTaskKey,
  rowOfTaskNumber,
  taskKeysOf,
  taskKeysReady,
  taskNumberOf,
} from '@tulipfarm/tables/task-keys';
import { runStateOf, TaskTableError, taskFields } from '@tulipfarm/tables/tasks-table';
import { deliverComment, deliverRowFiles, rowExists, wakeRow } from './row-assignments.ts';
import {
  cancelReminder,
  createReminder,
  listReminders,
  reminderSchema,
  remindersSchema,
  stopReminders,
  tasksTableId,
  TaskReminderError,
} from './task-reminders.ts';
import { relation, type AgentTransaction } from './store.ts';
import {
  commentAttachmentLimit,
  listRowAttachments,
  rowAttachmentIdsSchema,
  rowAttachmentSchema,
  changeRowAttachments,
  setRowAttachments,
} from './row-attachments.ts';

const runStateSchema = z.enum(['queued', 'working', 'waiting', 'done', 'failed', 'stopped']);

export const rowThreadSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['comment', 'progress', 'event']),
      author: z
        .discriminatedUnion('type', [
          z.object({ type: z.literal('member'), id: z.uuid() }),
          z.object({ type: z.literal('agent'), id: z.uuid() }),
        ])
        .nullable(),
      body: z.string().nullable(),
      event: z.record(z.string(), z.unknown()).nullable(),
      mentions: z.array(z.uuid()),
      createdAt: z.string(),
      editedAt: z.string().nullable(),
      deleted: z.boolean(),
      mine: z.boolean(),
      attachments: z.array(rowAttachmentSchema),
    }),
  ),
  assignment: z
    .object({
      agentId: z.uuid(),
      sponsorMembershipId: z.uuid(),
      runState: runStateSchema,
      reason: z.string().nullable(),
      wakeAt: z.string().nullable(),
      canRunNow: z.boolean(),
    })
    .nullable(),
  runs: z.array(
    z.object({
      taskId: z.uuid(),
      agentId: z.uuid(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      outcome: z.string().nullable(),
    }),
  ),
});
export type RowThread = z.infer<typeof rowThreadSchema>;

/** The workspace's built-in Tasks table, or null before the workspace has one. */
export const tasksTableSchema = z.object({ tableId: z.uuid().nullable() });

/** What the Tasks page shows beside each row: who is working on it, how far the current run got, and the latest note. */
export const taskActivitySchema = z.object({
  tableId: z.uuid().nullable(),
  tasks: z.array(
    z.object({
      rowId: z.uuid(),
      agentId: z.uuid(),
      sponsorMembershipId: z.uuid(),
      runState: runStateSchema.exclude(['stopped']),
      reason: z.string().nullable(),
      wakeAt: z.string().nullable(),
      updatedAt: z.string(),
      run: z
        .object({
          taskId: z.uuid(),
          startedAt: z.string(),
          endedAt: z.string().nullable(),
          outcome: z.string().nullable(),
          steps: z.number().int().nonnegative(),
        })
        .nullable(),
      note: z.object({ body: z.string(), createdAt: z.string() }).nullable(),
    }),
  ),
  comments: z.array(z.object({ rowId: z.uuid(), count: z.number().int().positive() })),
  me: z.uuid(),
});
export type TaskActivity = z.infer<typeof taskActivitySchema>;

/** A task, found by its key, with everything its page shows. */
export const taskDetailSchema = z.object({
  key: z.string(),
  number: z.number().int().nonnegative(),
  tableId: z.uuid(),
  rowId: z.uuid(),
  record: z.object({ id: z.uuid(), token: z.uuid(), values: valuesSchema }),
  runState: z.enum(['queued', 'working', 'waiting', 'done', 'failed']).nullable(),
  canEdit: z.boolean(),
  thread: rowThreadSchema,
  reminders: remindersSchema,
  attachments: z.array(rowAttachmentSchema),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

/** Each task's key, so lists and boards can show it. */
export const taskKeysSchema = z.object({
  tableId: z.uuid().nullable(),
  keys: z.array(z.object({ rowId: z.uuid(), key: z.string(), number: z.number().int().nonnegative() })),
});
export type TaskKeys = z.infer<typeof taskKeysSchema>;

export { reminderSchema, remindersSchema, TaskReminderError };
export { reminderInputSchema } from './task-reminders.ts';

export const commentInputSchema = z.strictObject({
  body: z.string().trim().min(1).max(20000),
  mentions: z.array(z.uuid()).max(50).default([]),
  attachmentIds: z.array(z.uuid()).max(commentAttachmentLimit).default([]),
});
export const commentEditSchema = commentInputSchema.extend({
  attachmentIds: z.array(z.uuid()).max(commentAttachmentLimit).optional(),
});
export const rowAttachmentsInputSchema = z
  .strictObject({ add: rowAttachmentIdsSchema.default([]), remove: rowAttachmentIdsSchema.default([]) })
  .refine(change => change.add.length + change.remove.length > 0);
export const rowAttachmentsSchema = z.object({ attachments: z.array(rowAttachmentSchema) });

export const inboxSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['assigned', 'waiting', 'finished', 'mention', 'reminder']),
      tableId: z.uuid(),
      tableName: z.string(),
      rowId: z.uuid(),
      /** The agent run a waiting item is about. */
      taskId: z.uuid().optional(),
      /** The reminder a reminder item is about. */
      reminderId: z.uuid().optional(),
      /** The task's key, such as TUL-007, for items about a task. */
      taskKey: z.string().optional(),
      summary: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  open: z.number(),
});
export type Inbox = z.infer<typeof inboxSchema>;

const dailyCreditsSchema = z.number().int().min(1).max(1000000).nullable();
export const assignmentLimitsSchema = z.object({
  workspace: z.number().int().min(1).max(100),
  timeZone: z.string().min(1).max(64),
  dailyCredits: dailyCreditsSchema,
  agents: z.array(
    z.object({
      agentId: z.uuid(),
      name: z.string(),
      concurrent: z.number().int().min(1).max(20),
      dailyRuns: z.number().int().min(1).max(10000).nullable(),
      dailyCredits: dailyCreditsSchema,
    }),
  ),
});
const inboxKinds = ['assigned', 'waiting', 'finished', 'mention', 'reminder'] as const;
export const inboxSlackSchema = z.object({
  connected: z.boolean(),
  kinds: z.object(
    Object.fromEntries(inboxKinds.map(kind => [kind, z.boolean()])) as Record<
      (typeof inboxKinds)[number],
      z.ZodBoolean
    >,
  ),
});
export type InboxSlack = z.infer<typeof inboxSlackSchema>;
/** Kinds left out keep their saved setting, so an older web app that doesn't know about reminders can't reset them. */
export const inboxSlackInputSchema = z.strictObject({
  kinds: inboxSlackSchema.shape.kinds.extend({ reminder: z.boolean().optional() }).strict(),
});

/** What admins send. Fields left out keep their saved values, so an older web app can't clear the newer caps. */
export const assignmentLimitsInputSchema = z.strictObject({
  workspace: assignmentLimitsSchema.shape.workspace,
  timeZone: assignmentLimitsSchema.shape.timeZone.optional(),
  dailyCredits: dailyCreditsSchema.optional(),
  agents: z
    .array(
      z.strictObject({
        agentId: z.uuid(),
        concurrent: z.number().int().min(1).max(20),
        dailyRuns: z.number().int().min(1).max(10000).nullable(),
        dailyCredits: dailyCreditsSchema.optional(),
      }),
    )
    .max(500),
});
export type AssignmentLimits = z.infer<typeof assignmentLimitsSchema>;

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

async function requireRow(tx: AgentTransaction, actor: HumanActor, tableId: string, rowId: string) {
  await requireTablePermission(tx, actor, tableId, 'table.row.read');
  if (!(await rowExists(tx, tableId, rowId))) throw new AccessDenied();
}

async function threadEvent(tx: AgentTransaction, actor: HumanActor, tableId: string, rowId: string, type: string) {
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_row_thread_items')}(id,table_id,row_id,kind,author_membership_id,event) VALUES($1,$2,$3,'event',$4,$5)`,
    [randomUUID(), tableId, rowId, actor.membershipId, JSON.stringify({ type })],
  );
}

async function mayInvoke(tx: AgentTransaction, actor: HumanActor, agentId: string) {
  return Boolean(
    (
      await tx.client.query(
        `SELECT ${definitionGrantPredicate(tx, 'agent', '$2::uuid', '$1::uuid', "'invoke'")} AS allowed`,
        [actor.membershipId, agentId],
      )
    ).rows[0]?.allowed,
  );
}

async function canEditRow(tx: AgentTransaction, actor: HumanActor, tableId: string) {
  return requireTablePermission(tx, actor, tableId, 'table.row.update').then(
    () => true,
    error => {
      if (error instanceof AccessDenied) return false;
      throw error;
    },
  );
}

async function readThread(tx: AgentTransaction, actor: HumanActor, tableId: string, rowId: string): Promise<RowThread> {
  const { comments } = await listRowAttachments(tx, tableId, rowId);
  const items = (
    await tx.client.query(
      `SELECT * FROM ${relation(tx, 'tf_row_thread_items')} WHERE table_id=$1 AND row_id=$2 ORDER BY created_at,id LIMIT 500`,
      [tableId, rowId],
    )
  ).rows.map(row => ({
    id: row.id,
    kind: row.kind,
    author: row.author_membership_id
      ? { type: 'member' as const, id: row.author_membership_id }
      : row.author_agent_id
        ? { type: 'agent' as const, id: row.author_agent_id }
        : null,
    body: row.deleted_at ? null : row.body,
    event: row.event,
    mentions: row.deleted_at ? [] : row.mentions,
    createdAt: iso(row.created_at),
    editedAt: row.edited_at ? iso(row.edited_at) : null,
    deleted: Boolean(row.deleted_at),
    mine: row.author_membership_id === actor.membershipId,
    attachments: row.deleted_at ? [] : (comments.get(row.id) ?? []),
  }));
  const assignment = (
    await tx.client.query(`SELECT * FROM ${relation(tx, 'tf_row_assignments')} WHERE table_id=$1 AND row_id=$2`, [
      tableId,
      rowId,
    ])
  ).rows[0];
  const runs = (
    await tx.client.query(
      `SELECT * FROM ${relation(tx, 'tf_row_assignment_runs')} WHERE table_id=$1 AND row_id=$2 ORDER BY started_at DESC LIMIT 20`,
      [tableId, rowId],
    )
  ).rows.map(run => ({
    taskId: run.task_id,
    agentId: run.agent_id,
    startedAt: iso(run.started_at),
    endedAt: run.ended_at ? iso(run.ended_at) : null,
    outcome: run.outcome,
  }));
  return rowThreadSchema.parse({
    items,
    assignment:
      assignment && assignment.run_state !== 'stopped'
        ? {
            agentId: assignment.agent_id,
            sponsorMembershipId: assignment.sponsor_membership_id,
            runState: assignment.run_state,
            reason: assignment.reason,
            wakeAt: assignment.wake_at ? iso(assignment.wake_at) : null,
            canRunNow: (await canEditRow(tx, actor, tableId)) && (await mayInvoke(tx, actor, assignment.agent_id)),
          }
        : null,
    runs,
  });
}

/** Mentioned members who can read the row get an Inbox item; others are dropped silently. */
async function notifyMentions(
  tx: AgentTransaction,
  actor: HumanActor,
  tableId: string,
  rowId: string,
  itemId: string,
  mentions: readonly string[],
) {
  const members = (
    await tx.client.query(
      `SELECT id,user_id FROM ${relation(tx, 'tf_memberships')} WHERE id=ANY($1::uuid[]) AND removed_at IS NULL AND id<>$2`,
      [mentions, actor.membershipId],
    )
  ).rows;
  for (const member of members) {
    const reader: HumanActor = { kind: 'human', userId: member.user_id, membershipId: member.id };
    const readable = await requireTablePermission(tx, reader, tableId, 'table.row.read').then(
      () => true,
      () => false,
    );
    if (!readable) continue;
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_inbox_items')}(id,membership_id,kind,table_id,row_id,source_id,summary) VALUES($1,$2,'mention',$3,$4,$5,'You were mentioned in a comment') ON CONFLICT DO NOTHING`,
      [randomUUID(), member.id, tableId, rowId, itemId],
    );
  }
}

type Runtime = {
  transaction<T>(
    workspaceId: string,
    compatibility: unknown,
    operation: (tx: AgentTransaction) => Promise<T>,
  ): Promise<T>;
};

/** Row threads, Run now, the Inbox and assignment limits: what people do around assigned rows. */
export function createRowWork(
  runtime: Runtime,
  compatibility: unknown,
  options: { removeObjects?: (workspaceId: string, objectKeys: readonly string[]) => Promise<void> } = {},
) {
  const as = <T>(
    workspaceId: string,
    userId: string,
    operation: (tx: AgentTransaction, actor: HumanActor) => Promise<T>,
  ) =>
    runtime.transaction(z.uuid().parse(workspaceId), compatibility, async tx => {
      return operation(tx, await lockAndResolveHuman(tx, userId));
    });
  /** Runs a change that may take attachments off, then removes their objects once it has committed. */
  async function detaching<T>(
    workspaceId: string,
    userId: string,
    operation: (tx: AgentTransaction, actor: HumanActor, removed: string[]) => Promise<T>,
  ) {
    const removed: string[] = [];
    const result = await as(workspaceId, userId, (tx, actor) => operation(tx, actor, removed));
    if (removed.length) await options.removeObjects?.(workspaceId, removed);
    return result;
  }

  async function ownComment(tx: AgentTransaction, actor: HumanActor, tableId: string, rowId: string, itemId: string) {
    await requireRow(tx, actor, tableId, rowId);
    const item = (
      await tx.client.query(
        `SELECT * FROM ${relation(tx, 'tf_row_thread_items')} WHERE id=$1 AND table_id=$2 AND row_id=$3 FOR UPDATE`,
        [itemId, tableId, rowId],
      )
    ).rows[0];
    if (!item || item.kind !== 'comment' || item.author_membership_id !== actor.membershipId || item.deleted_at)
      throw new AccessDenied();
    return item;
  }

  return {
    tasksTable: (workspaceId: string, userId: string) =>
      as(workspaceId, userId, async tx => {
        const row = (
          await tx.client.query<{ table_id: string }>(
            `SELECT table_id FROM ${relation(tx, 'tf_system_tables')} WHERE kind='tasks'`,
          )
        ).rows[0];
        return tasksTableSchema.parse({ tableId: row?.table_id ?? null });
      }),

    taskActivity: (workspaceId: string, userId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        const tableId = (
          await tx.client.query<{ table_id: string }>(
            `SELECT table_id FROM ${relation(tx, 'tf_system_tables')} WHERE kind='tasks'`,
          )
        ).rows[0]?.table_id;
        if (!tableId)
          return taskActivitySchema.parse({ tableId: null, tasks: [], comments: [], me: actor.membershipId });
        await requireTablePermission(tx, actor, tableId, 'table.row.read');
        const tasks = (
          await tx.client.query(
            `SELECT a.row_id,a.agent_id,a.sponsor_membership_id,a.run_state,a.reason,a.wake_at,a.updated_at,
               r.task_id,r.started_at,r.ended_at,r.outcome,n.body AS note,n.created_at AS note_at,
               CASE WHEN r.task_id IS NULL THEN 0 ELSE (
                 SELECT count(*)::int FROM ${relation(tx, 'tf_agent_tool_calls')} c
                 JOIN ${relation(tx, 'tf_agent_task_runs')} b ON b.run_id=c.run_id WHERE b.task_id=r.task_id
               ) END AS steps
             FROM ${relation(tx, 'tf_row_assignments')} a
             LEFT JOIN LATERAL (
               SELECT * FROM ${relation(tx, 'tf_row_assignment_runs')} x
               WHERE x.table_id=a.table_id AND x.row_id=a.row_id ORDER BY x.started_at DESC LIMIT 1
             ) r ON true
             LEFT JOIN LATERAL (
               SELECT body,created_at FROM ${relation(tx, 'tf_row_thread_items')} t
               WHERE t.table_id=a.table_id AND t.row_id=a.row_id AND t.kind='progress' AND t.deleted_at IS NULL
               ORDER BY t.created_at DESC,t.id DESC LIMIT 1
             ) n ON true
             WHERE a.table_id=$1 AND a.run_state<>'stopped'
             ORDER BY a.updated_at DESC LIMIT 500`,
            [tableId],
          )
        ).rows.map(row => ({
          rowId: row.row_id,
          agentId: row.agent_id,
          sponsorMembershipId: row.sponsor_membership_id,
          runState: row.run_state,
          reason: row.reason,
          wakeAt: row.wake_at ? iso(row.wake_at) : null,
          updatedAt: iso(row.updated_at),
          run: row.task_id
            ? {
                taskId: row.task_id,
                startedAt: iso(row.started_at),
                endedAt: row.ended_at ? iso(row.ended_at) : null,
                outcome: row.outcome,
                steps: row.steps,
              }
            : null,
          note: row.note ? { body: row.note, createdAt: iso(row.note_at) } : null,
        }));
        const comments = (
          await tx.client.query(
            `SELECT row_id,count(*)::int AS count FROM ${relation(tx, 'tf_row_thread_items')}
             WHERE table_id=$1 AND kind='comment' AND deleted_at IS NULL GROUP BY row_id LIMIT 2000`,
            [tableId],
          )
        ).rows.map(row => ({ rowId: row.row_id, count: row.count }));
        return taskActivitySchema.parse({ tableId, tasks, comments, me: actor.membershipId });
      }),

    /** Every task's key in the workspace's Tasks table. */
    taskKeys: (workspaceId: string, userId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        const tableId = await tasksTableId(tx);
        if (!tableId) return taskKeysSchema.parse({ tableId: null, keys: [] });
        await requireTablePermission(tx, actor, tableId, 'table.row.read');
        return taskKeysSchema.parse({ tableId, keys: await allTaskKeys(tx, tableId) });
      }),

    /** A task by its key, such as TUL-7 or tul-007. Unknown keys, deleted tasks and unreadable tasks are not found. */
    taskByKey: (workspaceId: string, userId: string, key: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        const number = parseTaskKey(key);
        const tableId = await tasksTableId(tx);
        if (number === null || !tableId) throw new AccessDenied();
        if (!(await taskKeysReady(tx))) throw new TaskReminderError('tasks-upgrading');
        await requireTablePermission(tx, actor, tableId, 'table.row.read');
        const rowId = await rowOfTaskNumber(tx, tableId, number);
        if (!rowId) throw new AccessDenied();
        return readTaskDetail(tx, actor, tableId, rowId);
      }),

    reminders: (workspaceId: string, userId: string, tableId: string, rowId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        await requireRow(tx, actor, tableId, rowId);
        return listReminders(tx, actor, tableId, rowId);
      }),

    createReminder: (workspaceId: string, userId: string, tableId: string, rowId: string, value: unknown) =>
      as(workspaceId, userId, async (tx, actor) => {
        await requireRow(tx, actor, tableId, rowId);
        await createReminder(tx, actor, tableId, rowId, value);
        return listReminders(tx, actor, tableId, rowId);
      }),

    cancelReminder: (workspaceId: string, userId: string, tableId: string, rowId: string, reminderId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        await requireRow(tx, actor, tableId, rowId);
        await cancelReminder(tx, actor, tableId, rowId, reminderId);
        return listReminders(tx, actor, tableId, rowId);
      }),

    thread: (workspaceId: string, userId: string, tableId: string, rowId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        await requireRow(tx, actor, tableId, rowId);
        return readThread(tx, actor, tableId, rowId);
      }),

    comment: (workspaceId: string, userId: string, tableId: string, rowId: string, value: unknown) =>
      as(workspaceId, userId, async (tx, actor) => {
        await postComment(tx, actor, tableId, rowId, commentInputSchema.parse(value));
        return readThread(tx, actor, tableId, rowId);
      }),

    editComment: (
      workspaceId: string,
      userId: string,
      tableId: string,
      rowId: string,
      itemId: string,
      value: unknown,
    ) =>
      detaching(workspaceId, userId, async (tx, actor, removed) => {
        const input = commentEditSchema.parse(value);
        await ownComment(tx, actor, tableId, rowId, itemId);
        if (input.attachmentIds) {
          const target = { tableId, rowId, itemId };
          const current = (await listRowAttachments(tx, tableId, rowId)).comments.get(itemId) ?? [];
          const change = await changeRowAttachments(tx, actor.membershipId, target, {
            add: input.attachmentIds,
            remove: current.map(file => file.id).filter(id => !input.attachmentIds!.includes(id)),
          });
          removed.push(...change.removed);
          await deliverRowFiles(tx, tableId, rowId, actor.membershipId, change.added);
        }
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_row_thread_items')} SET body=$2,mentions=$3,edited_at=clock_timestamp() WHERE id=$1`,
          [itemId, input.body, input.mentions],
        );
        await notifyMentions(tx, actor, tableId, rowId, itemId, input.mentions);
        return readThread(tx, actor, tableId, rowId);
      }),

    deleteComment: (workspaceId: string, userId: string, tableId: string, rowId: string, itemId: string) =>
      detaching(workspaceId, userId, async (tx, actor, removed) => {
        await ownComment(tx, actor, tableId, rowId, itemId);
        removed.push(...(await setRowAttachments(tx, actor.membershipId, { tableId, rowId, itemId }, [])));
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_row_thread_items')} SET body=NULL,mentions='{}',deleted_at=clock_timestamp() WHERE id=$1`,
          [itemId],
        );
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_inbox_items')} SET resolved_at=clock_timestamp() WHERE kind='mention' AND source_id=$1 AND resolved_at IS NULL`,
          [itemId],
        );
        return readThread(tx, actor, tableId, rowId);
      }),

    /** Adds uploads to, or removes files from, the row's description; anyone who can edit the row may change them. */
    setAttachments: (workspaceId: string, userId: string, tableId: string, rowId: string, value: unknown) =>
      detaching(workspaceId, userId, async (tx, actor, removed) => {
        const input = rowAttachmentsInputSchema.parse(value);
        await requireRow(tx, actor, tableId, rowId);
        await requireTablePermission(tx, actor, tableId, 'table.row.update');
        const change = await changeRowAttachments(tx, actor.membershipId, { tableId, rowId, itemId: null }, input);
        removed.push(...change.removed);
        await deliverRowFiles(tx, tableId, rowId, actor.membershipId, change.added);
        return rowAttachmentsSchema.parse({ attachments: (await listRowAttachments(tx, tableId, rowId)).description });
      }),

    runNow: (workspaceId: string, userId: string, tableId: string, rowId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        await requireRow(tx, actor, tableId, rowId);
        const assignment = (
          await tx.client.query(
            `SELECT agent_id FROM ${relation(tx, 'tf_row_assignments')} WHERE table_id=$1 AND row_id=$2 AND run_state<>'stopped' FOR UPDATE`,
            [tableId, rowId],
          )
        ).rows[0];
        if (!assignment) throw new AccessDenied();
        await requireTablePermission(tx, actor, tableId, 'table.row.update');
        if (!(await mayInvoke(tx, actor, assignment.agent_id))) throw new AccessDenied();
        await wakeRow(tx, tableId, rowId, actor.membershipId);
        return readThread(tx, actor, tableId, rowId);
      }),

    clearWake: (workspaceId: string, userId: string, tableId: string, rowId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        await requireRow(tx, actor, tableId, rowId);
        await requireTablePermission(tx, actor, tableId, 'table.row.update');
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_row_assignments')} SET wake_at=NULL,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
          [tableId, rowId],
        );
        return readThread(tx, actor, tableId, rowId);
      }),

    /** Marks a task done by hand. A queued or waiting agent stops waiting for a turn; a working run must end first. */
    completeTask: (workspaceId: string, userId: string, tableId: string, rowId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        await requireRow(tx, actor, tableId, rowId);
        await requireTablePermission(tx, actor, tableId, 'table.row.update');
        const assignment = (
          await tx.client.query<{ current_task_id: string | null }>(
            `SELECT current_task_id FROM ${relation(tx, 'tf_row_assignments')} WHERE table_id=$1 AND row_id=$2 AND run_state<>'stopped' FOR UPDATE`,
            [tableId, rowId],
          )
        ).rows[0];
        if (assignment?.current_task_id) throw new TaskTableError('run-state-protected');
        if (assignment)
          await tx.client.query(
            `UPDATE ${relation(tx, 'tf_row_assignments')} SET run_state='done',reason=NULL,wake_at=NULL,pending_wakes=0,updated_at=clock_timestamp() WHERE table_id=$1 AND row_id=$2`,
            [tableId, rowId],
          );
        await writeRunState(tx, { tableId, recordId: rowId, state: 'done' });
        await tx.client.query(
          `UPDATE ${relation(tx, 'tf_inbox_items')} SET resolved_at=clock_timestamp() WHERE kind='waiting' AND table_id=$1 AND row_id=$2 AND resolved_at IS NULL`,
          [tableId, rowId],
        );
        await threadEvent(tx, actor, tableId, rowId, 'marked-done');
        await stopReminders(tx, tableId, rowId, 'done');
        return readThread(tx, actor, tableId, rowId);
      }),

    /** Moves a finished task without an agent back to To do. An agent's task reopens by running it again. */
    reopenTask: (workspaceId: string, userId: string, tableId: string, rowId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        await requireRow(tx, actor, tableId, rowId);
        await requireTablePermission(tx, actor, tableId, 'table.row.update');
        const assigned = await tx.client.query(
          `SELECT 1 FROM ${relation(tx, 'tf_row_assignments')} WHERE table_id=$1 AND row_id=$2 AND run_state<>'stopped' FOR UPDATE`,
          [tableId, rowId],
        );
        if (assigned.rowCount) throw new TaskTableError('run-state-protected');
        await writeRunState(tx, { tableId, recordId: rowId, state: null });
        await threadEvent(tx, actor, tableId, rowId, 'reopened');
        return readThread(tx, actor, tableId, rowId);
      }),

    inbox: (workspaceId: string, userId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        const rows = (
          await tx.client.query(
            `SELECT i.*,COALESCE(g.definition->>'label',c.display_name) AS table_name FROM ${relation(tx, 'tf_inbox_items')} i
            JOIN ${relation(tx, 'tf_table_catalog')} c ON c.id=i.table_id AND c.archived_at IS NULL
            LEFT JOIN ${relation(tx, 'tf_table_generations')} g ON g.table_id=i.table_id AND g.state='active'
            WHERE i.membership_id=$1 AND i.done_at IS NULL AND i.resolved_at IS NULL
            ORDER BY i.created_at DESC,i.id LIMIT 200`,
            [actor.membershipId],
          )
        ).rows;
        const keys = new Map<string, string>();
        const tasksId = await tasksTableId(tx);
        if (tasksId)
          for (const [rowId, key] of await taskKeysOf(
            tx,
            tasksId,
            rows.filter(row => row.table_id === tasksId).map(row => String(row.row_id)),
          ))
            keys.set(rowId, key);
        const items = [];
        for (const row of rows) {
          // Behavior 60: never show an item for a row the member can no longer read.
          const readable = await requireRow(tx, actor, row.table_id, row.row_id).then(
            () => true,
            () => false,
          );
          if (!readable) continue;
          items.push({
            id: row.id,
            kind: row.kind,
            tableId: row.table_id,
            tableName: row.table_name,
            rowId: row.row_id,
            ...(row.kind === 'waiting' ? { taskId: row.source_id } : {}),
            ...(row.kind === 'reminder' ? { reminderId: row.source_id } : {}),
            ...(row.table_id === tasksId && keys.has(row.row_id) ? { taskKey: keys.get(row.row_id) } : {}),
            summary: row.summary,
            createdAt: iso(row.created_at),
          });
        }
        return inboxSchema.parse({ items, open: items.length });
      }),

    markDone: (workspaceId: string, userId: string, itemId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        const changed = await tx.client.query(
          `UPDATE ${relation(tx, 'tf_inbox_items')} SET done_at=clock_timestamp() WHERE id=$1 AND membership_id=$2 AND done_at IS NULL`,
          [z.uuid().parse(itemId), actor.membershipId],
        );
        if (!changed.rowCount) throw new AccessDenied();
      }),

    slackPreferences: (workspaceId: string, userId: string) =>
      as(workspaceId, userId, (tx, actor) => readSlackPreferences(tx, actor.membershipId)),

    setSlackPreferences: (workspaceId: string, userId: string, value: unknown) =>
      as(workspaceId, userId, async (tx, actor) => {
        const { kinds } = inboxSlackInputSchema.parse(value);
        const taskKeys = await taskKeysReady(tx);
        const known = inboxKinds.filter(kind => kind !== 'reminder' || (kinds.reminder !== undefined && taskKeys));
        await tx.client.query(
          `DELETE FROM ${relation(tx, 'tf_inbox_slack_muted')} WHERE membership_id=$1 AND kind=ANY($2::text[])`,
          [actor.membershipId, known],
        );
        const muted = known.filter(kind => kinds[kind] === false);
        if (muted.length)
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_inbox_slack_muted')}(membership_id,kind) SELECT $1,unnest($2::text[])`,
            [actor.membershipId, muted],
          );
        return readSlackPreferences(tx, actor.membershipId);
      }),

    limits: (workspaceId: string, userId: string) =>
      as(workspaceId, userId, async (tx, actor) => {
        if ((await currentMember(tx, actor)).role !== 'admin') throw new AccessDenied();
        return readLimits(tx);
      }),

    setLimits: (workspaceId: string, userId: string, value: unknown) =>
      as(workspaceId, userId, async (tx, actor) => {
        if ((await currentMember(tx, actor)).role !== 'admin') throw new AccessDenied();
        const input = assignmentLimitsInputSchema.parse(value);
        if (
          input.timeZone !== undefined &&
          !(await tx.client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [input.timeZone])).rowCount
        )
          throw new AssignmentLimitsError('unknown-time-zone');
        await tx.client.query(
          `INSERT INTO ${relation(tx, 'tf_workspace_assignment_limits')}(singleton,concurrent,time_zone,daily_credits) VALUES(true,$1,COALESCE($2,'UTC'),$3)
          ON CONFLICT (singleton) DO UPDATE SET concurrent=EXCLUDED.concurrent,
            time_zone=COALESCE($2,${relation(tx, 'tf_workspace_assignment_limits')}.time_zone),
            daily_credits=CASE WHEN $4 THEN EXCLUDED.daily_credits ELSE ${relation(tx, 'tf_workspace_assignment_limits')}.daily_credits END`,
          [input.workspace, input.timeZone ?? null, input.dailyCredits ?? null, input.dailyCredits !== undefined],
        );
        for (const agent of input.agents)
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_agent_assignment_limits')}(agent_id,concurrent,daily_runs,daily_credits)
            SELECT id,$2,$3,$4 FROM ${relation(tx, 'tf_agents')} WHERE id=$1
            ON CONFLICT (agent_id) DO UPDATE SET concurrent=EXCLUDED.concurrent,daily_runs=EXCLUDED.daily_runs,
              daily_credits=CASE WHEN $5 THEN EXCLUDED.daily_credits ELSE ${relation(tx, 'tf_agent_assignment_limits')}.daily_credits END`,
            [
              agent.agentId,
              agent.concurrent,
              agent.dailyRuns,
              agent.dailyCredits ?? null,
              agent.dailyCredits !== undefined,
            ],
          );
        return readLimits(tx);
      }),
  };
}

/** A task's record, key, thread and reminders. The caller has checked that the actor can read the row. */
export async function readTaskDetail(
  tx: AgentTransaction,
  actor: HumanActor,
  tableId: string,
  rowId: string,
): Promise<TaskDetail> {
  const generation = await activeGeneration(tx, tableId);
  const record = await readRecord(tx, generation, rowId);
  if (!record) throw new AccessDenied();
  const number = await taskNumberOf(tx, tableId, rowId);
  if (number === null) throw new AccessDenied();
  const state = record.values[taskFields.runState];
  return taskDetailSchema.parse({
    key: formatTaskKey(number),
    number,
    tableId,
    rowId,
    record: { id: record.id, token: record.token, values: record.values },
    runState: runStateOf(state?.kind === 'single-select' ? state.optionId : undefined),
    canEdit: await canEditRow(tx, actor, tableId),
    thread: await readThread(tx, actor, tableId, rowId),
    reminders: await listReminders(tx, actor, tableId, rowId),
    attachments: (await listRowAttachments(tx, tableId, rowId)).description,
  });
}

/** Posts a comment as the actor. `id` lets an approved chat card post its comment exactly once. */
export async function postComment(
  tx: AgentTransaction,
  actor: HumanActor,
  tableId: string,
  rowId: string,
  input: z.infer<typeof commentInputSchema>,
  id: string = randomUUID(),
) {
  await requireRow(tx, actor, tableId, rowId);
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_row_thread_items')}(id,table_id,row_id,kind,author_membership_id,body,mentions) VALUES($1,$2,$3,'comment',$4,$5,$6)`,
    [id, tableId, rowId, actor.membershipId, input.body, input.mentions],
  );
  await setRowAttachments(tx, actor.membershipId, { tableId, rowId, itemId: id }, input.attachmentIds);
  await notifyMentions(tx, actor, tableId, rowId, id, input.mentions);
  await deliverComment(tx, tableId, rowId, actor.membershipId, input.body, input.attachmentIds);
  await stopReminders(tx, tableId, rowId, 'commented', actor.membershipId);
  return id;
}

async function readLimits(tx: AgentTransaction): Promise<AssignmentLimits> {
  const workspace = (
    await tx.client.query(
      `SELECT concurrent,time_zone AS "timeZone",daily_credits AS "dailyCredits" FROM ${relation(tx, 'tf_workspace_assignment_limits')}`,
    )
  ).rows[0];
  const agents = (
    await tx.client.query(
      `SELECT a.id AS "agentId",a.display_name AS name,COALESCE(l.concurrent,3) AS concurrent,l.daily_runs AS "dailyRuns",
        l.daily_credits AS "dailyCredits"
      FROM ${relation(tx, 'tf_agents')} a LEFT JOIN ${relation(tx, 'tf_agent_assignment_limits')} l ON l.agent_id=a.id
      WHERE a.saved_revision IS NOT NULL AND a.deleted_at IS NULL ORDER BY lower(a.display_name),a.id`,
    )
  ).rows;
  return assignmentLimitsSchema.parse({
    workspace: workspace?.concurrent ?? 10,
    timeZone: workspace?.timeZone ?? 'UTC',
    dailyCredits: workspace?.dailyCredits ?? null,
    agents,
  });
}

async function readSlackPreferences(tx: AgentTransaction, membershipId: string): Promise<InboxSlack> {
  const muted = new Set(
    (
      await tx.client.query(`SELECT kind FROM ${relation(tx, 'tf_inbox_slack_muted')} WHERE membership_id=$1`, [
        membershipId,
      ])
    ).rows.map(row => String(row.kind)),
  );
  const connected = Boolean(
    (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_slack_identities')} i JOIN ${relation(tx, 'tf_slack_installations')} s
          ON s.id=i.installation_id AND s.generation=i.generation AND s.state='active'
        WHERE i.membership_id=$1 AND i.state<>'revoked'`,
        [membershipId],
      )
    ).rowCount,
  );
  return inboxSlackSchema.parse({
    connected,
    kinds: Object.fromEntries(inboxKinds.map(kind => [kind, !muted.has(kind)])),
  });
}

export class AssignmentLimitsError extends Error {
  readonly code: 'unknown-time-zone';
  constructor(code: 'unknown-time-zone') {
    super(code);
    this.code = code;
    this.name = 'AssignmentLimitsError';
  }
}
