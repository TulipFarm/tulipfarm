import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, type HumanActor, requireTablePermission } from '@tulipfarm/access';
import { activeGeneration, ensureWelcomeTask, readRecord } from '@tulipfarm/tables/store';
import { formatTaskKey, taskKeysReady, taskNumberOf } from '@tulipfarm/tables/task-keys';
import { runStateOptions, taskFields } from '@tulipfarm/tables/tasks-table';
import { agentCompatibility, relation, type AgentStorage, type AgentTransaction } from './store.ts';

/** At most this many reminders run at once on one task. */
export const maxActiveRemindersPerTask = 5;

const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .meta({ description: 'Local time of day, HH:MM in 24-hour time.' });

/** When a reminder fires. Repeating reminders fire at most once a day. */
export const reminderScheduleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), at: z.iso.datetime({ offset: true }) }),
  z.strictObject({ kind: z.literal('daily'), time: timeOfDaySchema }),
  z.strictObject({ kind: z.literal('weekdays'), time: timeOfDaySchema }),
  z.strictObject({
    kind: z.literal('weekly'),
    time: timeOfDaySchema,
    weekday: z.number().int().min(0).max(6).meta({ description: '0 is Sunday, 6 is Saturday.' }),
  }),
]);
export type ReminderSchedule = z.infer<typeof reminderScheduleSchema>;

export const reminderInputSchema = z.strictObject({
  membershipId: z.uuid(),
  schedule: reminderScheduleSchema,
  /** An IANA time zone for the schedule. Defaults to the workspace's time zone. */
  timeZone: z.string().min(1).max(64).optional(),
});
export type ReminderInput = z.infer<typeof reminderInputSchema>;

export const reminderStopReasons = [
  'cancelled',
  'commented',
  'done',
  'access-lost',
  'deleted',
  'finished',
  'reassigned',
] as const;
export type ReminderStopReason = (typeof reminderStopReasons)[number];

export const reminderSchema = z.object({
  id: z.uuid(),
  tableId: z.uuid(),
  rowId: z.uuid(),
  membershipId: z.uuid(),
  createdByMembershipId: z.uuid(),
  schedule: reminderScheduleSchema,
  timeZone: z.string(),
  nextFireAt: z.string().nullable(),
  status: z.enum(['active', 'stopped']),
  stopReason: z.enum(reminderStopReasons).nullable(),
  stoppedByMembershipId: z.uuid().nullable(),
  firedCount: z.number().int().nonnegative(),
  lastFiredAt: z.string().nullable(),
  createdAt: z.string(),
  stoppedAt: z.string().nullable(),
});
export type Reminder = z.infer<typeof reminderSchema>;
export const remindersSchema = z.object({
  reminders: z.array(reminderSchema),
  /** Members a reminder may target: the person assignee and members mentioned in the task's comments. */
  targets: z.array(z.uuid()),
  canEdit: z.boolean(),
});
export type Reminders = z.infer<typeof remindersSchema>;

export type ReminderErrorCode =
  | 'not-a-task'
  | 'reminder-target'
  | 'reminder-limit'
  | 'reminder-in-past'
  | 'unknown-time-zone'
  | 'tasks-upgrading';
export class TaskReminderError extends Error {
  readonly code: ReminderErrorCode;
  readonly status: 400 | 409 | 503;
  constructor(code: ReminderErrorCode) {
    super(code);
    this.code = code;
    this.name = 'TaskReminderError';
    this.status =
      code === 'tasks-upgrading' ? 503 : code === 'reminder-limit' || code === 'reminder-target' ? 409 : 400;
  }
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

/** The next time a repeating schedule fires after now, as SQL that reads `time_of_day`, `weekday` and `time_zone`. */
function nextRepeatSql(alias = '') {
  const p = alias ? `${alias}.` : '';
  // Today's local time, then each following day until the schedule accepts the weekday.
  return `(SELECT candidate FROM (
      SELECT ((((clock_timestamp() AT TIME ZONE ${p}time_zone)::date + d) + ${p}time_of_day) AT TIME ZONE ${p}time_zone) AS candidate,
        extract(dow FROM ((clock_timestamp() AT TIME ZONE ${p}time_zone)::date + d))::int AS dow
      FROM generate_series(0, 7) d
    ) c
    WHERE candidate > clock_timestamp()
      AND (${p}schedule='daily' OR (${p}schedule='weekdays' AND dow BETWEEN 1 AND 5) OR (${p}schedule='weekly' AND dow=${p}weekday))
    ORDER BY candidate LIMIT 1)`;
}

function scheduleOf(row: Record<string, unknown>): ReminderSchedule {
  const time = row.time_of_day ? String(row.time_of_day).slice(0, 5) : '';
  switch (row.schedule) {
    case 'once':
      return { kind: 'once', at: iso(row.once_at) };
    case 'weekly':
      return { kind: 'weekly', time, weekday: Number(row.weekday) };
    case 'weekdays':
      return { kind: 'weekdays', time };
    default:
      return { kind: 'daily', time };
  }
}

const reminderColumns = '*';

function reminderOf(row: Record<string, unknown>): Reminder {
  return reminderSchema.parse({
    id: row.id,
    tableId: row.table_id,
    rowId: row.row_id,
    membershipId: row.membership_id,
    createdByMembershipId: row.created_by_membership_id,
    schedule: scheduleOf(row),
    timeZone: row.time_zone,
    nextFireAt: row.next_fire_at ? iso(row.next_fire_at) : null,
    status: row.status,
    stopReason: row.stop_reason ?? null,
    stoppedByMembershipId: row.stopped_by_membership_id ?? null,
    firedCount: row.fired_count,
    lastFiredAt: row.last_fired_at ? iso(row.last_fired_at) : null,
    createdAt: iso(row.created_at),
    stoppedAt: row.stopped_at ? iso(row.stopped_at) : null,
  });
}

async function requireReady(tx: AgentTransaction) {
  if (!(await taskKeysReady(tx))) throw new TaskReminderError('tasks-upgrading');
}

/** The workspace's built-in Tasks table ID, or null. */
export async function tasksTableId(tx: AgentTransaction) {
  return (
    (
      await tx.client.query<{ table_id: string }>(
        `SELECT table_id FROM ${relation(tx, 'tf_system_tables')} WHERE kind='tasks'`,
      )
    ).rows[0]?.table_id ?? null
  );
}

async function requireTask(tx: AgentTransaction, tableId: string) {
  if ((await tasksTableId(tx)) !== tableId) throw new TaskReminderError('not-a-task');
}

async function readTask(tx: AgentTransaction, tableId: string, rowId: string) {
  const generation = await activeGeneration(tx, tableId).catch(() => null);
  return generation ? readRecord(tx, generation, rowId) : null;
}

/** The person a task is assigned to, or null for no assignee or an agent. */
export async function assignedMember(tx: AgentTransaction, tableId: string, rowId: string) {
  const value = (await readTask(tx, tableId, rowId))?.values[taskFields.assignee];
  return value?.kind === 'actor' && value.actor.type === 'member' ? value.actor.id : null;
}

/** Members a reminder may target on this task. */
export async function reminderTargets(tx: AgentTransaction, tableId: string, rowId: string) {
  const mentioned = (
    await tx.client.query<{ id: string }>(
      `SELECT DISTINCT m.id FROM ${relation(tx, 'tf_row_thread_items')} t
       CROSS JOIN LATERAL unnest(t.mentions) AS mention(id)
       JOIN ${relation(tx, 'tf_memberships')} m ON m.id=mention.id AND m.removed_at IS NULL
       WHERE t.table_id=$1 AND t.row_id=$2 AND t.kind='comment' AND t.deleted_at IS NULL`,
      [tableId, rowId],
    )
  ).rows.map(row => row.id);
  const assignee = await assignedMember(tx, tableId, rowId);
  return [...new Set([...(assignee ? [assignee] : []), ...mentioned])];
}

async function canEdit(tx: AgentTransaction, actor: HumanActor, tableId: string) {
  return requireTablePermission(tx, actor, tableId, 'table.row.update').then(
    () => true,
    error => {
      if (error instanceof AccessDenied) return false;
      throw error;
    },
  );
}

async function memberActor(tx: AgentTransaction, membershipId: string): Promise<HumanActor | null> {
  const member = (
    await tx.client.query<{ user_id: string }>(
      `SELECT user_id FROM ${relation(tx, 'tf_memberships')} WHERE id=$1 AND removed_at IS NULL`,
      [membershipId],
    )
  ).rows[0];
  return member ? { kind: 'human', userId: member.user_id, membershipId } : null;
}

async function canRead(tx: AgentTransaction, membershipId: string, tableId: string) {
  const reader = await memberActor(tx, membershipId);
  if (!reader) return false;
  return requireTablePermission(tx, reader, tableId, 'table.row.read').then(
    () => true,
    () => false,
  );
}

/** The task's reminders, newest first, with whom a new reminder may target. The caller must be able to read the row. */
export async function listReminders(
  tx: AgentTransaction,
  actor: HumanActor,
  tableId: string,
  rowId: string,
): Promise<Reminders> {
  await requireReady(tx);
  await requireTask(tx, tableId);
  const rows = (
    await tx.client.query(
      `SELECT ${reminderColumns} FROM ${relation(tx, 'tf_task_reminders')} WHERE table_id=$1 AND row_id=$2
       ORDER BY (status='active') DESC,created_at DESC,id LIMIT 100`,
      [tableId, rowId],
    )
  ).rows;
  return remindersSchema.parse({
    reminders: rows.map(reminderOf),
    targets: await reminderTargets(tx, tableId, rowId),
    canEdit: await canEdit(tx, actor, tableId),
  });
}

async function workspaceTimeZone(tx: AgentTransaction) {
  return (
    (
      await tx.client.query<{ time_zone: string }>(
        `SELECT time_zone FROM ${relation(tx, 'tf_workspace_assignment_limits')}`,
      )
    ).rows[0]?.time_zone ?? 'UTC'
  );
}

/** Adds a reminder. Anyone who can edit the task may; the target must be the person assignee or a mentioned member. */
export async function createReminder(
  tx: AgentTransaction,
  actor: HumanActor,
  tableId: string,
  rowId: string,
  value: unknown,
): Promise<Reminder> {
  await requireReady(tx);
  await requireTask(tx, tableId);
  const input = reminderInputSchema.parse(value);
  await requireTablePermission(tx, actor, tableId, 'table.row.update');
  // Serializes reminder writes on one task, so the active limit holds.
  await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `task-reminders:${tableId}:${rowId}`,
  ]);
  if (!(await readTask(tx, tableId, rowId))) throw new AccessDenied();
  if (!(await reminderTargets(tx, tableId, rowId)).includes(input.membershipId))
    throw new TaskReminderError('reminder-target');
  if (!(await canRead(tx, input.membershipId, tableId))) throw new TaskReminderError('reminder-target');
  const active = (
    await tx.client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${relation(tx, 'tf_task_reminders')} WHERE table_id=$1 AND row_id=$2 AND status='active'`,
      [tableId, rowId],
    )
  ).rows[0]?.count;
  if ((active ?? 0) >= maxActiveRemindersPerTask) throw new TaskReminderError('reminder-limit');
  const timeZone = input.timeZone ?? (await workspaceTimeZone(tx));
  if (!(await tx.client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [timeZone])).rowCount)
    throw new TaskReminderError('unknown-time-zone');
  const { schedule } = input;
  if (schedule.kind === 'once' && Date.parse(schedule.at) <= Date.now())
    throw new TaskReminderError('reminder-in-past');
  const id = randomUUID();
  await tx.client.query(
    `INSERT INTO ${relation(tx, 'tf_task_reminders')}
       (id,table_id,row_id,membership_id,created_by_membership_id,schedule,time_of_day,weekday,time_zone,next_fire_at,once_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::time,$8,$9,$10::timestamptz,$11::timestamptz)`,
    [
      id,
      tableId,
      rowId,
      input.membershipId,
      actor.membershipId,
      schedule.kind,
      schedule.kind === 'once' ? null : schedule.time,
      schedule.kind === 'weekly' ? schedule.weekday : null,
      timeZone,
      schedule.kind === 'once' ? schedule.at : new Date().toISOString(),
      schedule.kind === 'once' ? schedule.at : null,
    ],
  );
  if (schedule.kind !== 'once')
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_task_reminders')} SET next_fire_at=${nextRepeatSql()} WHERE id=$1`,
      [id],
    );
  return reminderOf(
    (await tx.client.query(`SELECT ${reminderColumns} FROM ${relation(tx, 'tf_task_reminders')} WHERE id=$1`, [id]))
      .rows[0],
  );
}

/** Stops one active reminder. Anyone who can edit the task may, and so may the reminded person. */
export async function cancelReminder(
  tx: AgentTransaction,
  actor: HumanActor,
  tableId: string,
  rowId: string,
  reminderId: string,
): Promise<Reminder> {
  await requireReady(tx);
  await requireTask(tx, tableId);
  await requireTablePermission(tx, actor, tableId, 'table.row.read');
  const row = (
    await tx.client.query(
      `SELECT membership_id,status FROM ${relation(tx, 'tf_task_reminders')} WHERE id=$1 AND table_id=$2 AND row_id=$3 FOR UPDATE`,
      [z.uuid().parse(reminderId), tableId, rowId],
    )
  ).rows[0];
  if (!row) throw new AccessDenied();
  if (row.membership_id !== actor.membershipId && !(await canEdit(tx, actor, tableId))) throw new AccessDenied();
  if (row.status === 'active')
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_task_reminders')} SET status='stopped',stop_reason='cancelled',stopped_at=clock_timestamp(),
        next_fire_at=NULL,stopped_by_membership_id=$2 WHERE id=$1`,
      [reminderId, actor.membershipId],
    );
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_inbox_items')} SET resolved_at=clock_timestamp() WHERE kind='reminder' AND source_id=$1 AND resolved_at IS NULL`,
    [reminderId],
  );
  return reminderOf(
    (
      await tx.client.query(`SELECT ${reminderColumns} FROM ${relation(tx, 'tf_task_reminders')} WHERE id=$1`, [
        reminderId,
      ])
    ).rows[0],
  );
}

/** Stops a task's active reminders, or only one member's. Their open Inbox items stay until the member clears them. */
export async function stopReminders(
  tx: AgentTransaction,
  tableId: string,
  rowId: string,
  reason: ReminderStopReason,
  membershipId?: string,
) {
  if (!(await taskKeysReady(tx))) return;
  await tx.client.query(
    `UPDATE ${relation(tx, 'tf_task_reminders')} SET status='stopped',stop_reason=$3,stopped_at=clock_timestamp(),next_fire_at=NULL
     WHERE table_id=$1 AND row_id=$2 AND status='active' AND ($4::uuid IS NULL OR membership_id=$4)`,
    [tableId, rowId, reason, membershipId ?? null],
  );
}

/**
 * Fires due reminders: each gets a fresh Inbox item, which the Slack notifier sends as a direct message.
 * A one-off reminder then finishes; a repeating one moves to its next time. Reminders whose task is gone or done,
 * or whose member left or lost access, stop instead.
 */
export async function fireDueReminders(tx: AgentTransaction, limit = 50) {
  if (!(await taskKeysReady(tx))) return 0;
  const due = (
    await tx.client.query(
      `SELECT * FROM ${relation(tx, 'tf_task_reminders')} WHERE status='active' AND next_fire_at<=clock_timestamp()
       ORDER BY next_fire_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    )
  ).rows;
  let fired = 0;
  for (const reminder of due) {
    const stop = (reason: ReminderStopReason) =>
      tx.client.query(
        `UPDATE ${relation(tx, 'tf_task_reminders')} SET status='stopped',stop_reason=$2,stopped_at=clock_timestamp(),next_fire_at=NULL WHERE id=$1`,
        [reminder.id, reason],
      );
    const task = await readTask(tx, reminder.table_id, reminder.row_id);
    if (!task) {
      await stop('deleted');
      continue;
    }
    const state = task.values[taskFields.runState];
    if (state?.kind === 'single-select' && state.optionId === runStateOptions.done) {
      await stop('done');
      continue;
    }
    if (!(await canRead(tx, reminder.membership_id, reminder.table_id))) {
      await stop('access-lost');
      continue;
    }
    const number = await taskNumberOf(tx, reminder.table_id, reminder.row_id);
    const title = task.values[taskFields.title];
    const label = [number === null ? null : formatTaskKey(number), title?.kind === 'text' ? title.value : null]
      .filter(Boolean)
      .join(' ')
      .slice(0, 200);
    const summary = label ? `Reminder: ${label}` : 'Reminder';
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_inbox_items')}(id,membership_id,kind,table_id,row_id,source_id,summary)
       VALUES($1,$2,'reminder',$3,$4,$5,$6)
       ON CONFLICT (membership_id,kind,source_id) DO UPDATE SET created_at=clock_timestamp(),notified_at=NULL,done_at=NULL,
         resolved_at=NULL,summary=EXCLUDED.summary`,
      [randomUUID(), reminder.membership_id, reminder.table_id, reminder.row_id, reminder.id, summary],
    );
    if (reminder.schedule === 'once')
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_task_reminders')} SET status='stopped',stop_reason='finished',stopped_at=clock_timestamp(),
          last_fired_at=clock_timestamp(),fired_count=fired_count+1,next_fire_at=NULL WHERE id=$1`,
        [reminder.id],
      );
    else
      await tx.client.query(
        `UPDATE ${relation(tx, 'tf_task_reminders')} SET last_fired_at=clock_timestamp(),fired_count=fired_count+1,
          next_fire_at=${nextRepeatSql()} WHERE id=$1`,
        [reminder.id],
      );
    fired++;
  }
  return fired;
}

/** The worker's Tasks upgrade step for one workspace: create the welcome task once, then fire due reminders. */
export function createTaskUpkeep(runtime: AgentStorage) {
  return {
    async step(workspaceId: string) {
      return runtime.transaction(workspaceId, agentCompatibility, async tx => {
        if (!(await taskKeysReady(tx))) return 0;
        await ensureWelcomeTask(tx);
        return fireDueReminders(tx);
      });
    },
  };
}
