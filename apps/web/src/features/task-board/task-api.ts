import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { useFeatureRead } from '@/lib/query';
import { TableRequestError } from '@/features/tables/request-state';
import { tableValuesSchema } from '@/features/tables/review-contracts';
import { rowThreadSchema } from '@/features/tables/row-thread';

const workspaceBase = (workspaceId: string) => `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}`;

/** TUL-000 … TUL-999, then TUL-1000 and up. */
export const formatTaskKey = (number: number) => `TUL-${String(number).padStart(3, '0')}`;

/** The canonical form of a key such as `tul-7` or `TUL-007`, or null when the text is not a key. */
export function canonicalTaskKey(text: string) {
  const match = /^tul-(\d{1,10})$/i.exec(text.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return number <= 2147483647 ? formatTaskKey(number) : null;
}

export const taskKeysSchema = z.object({
  tableId: z.uuid().nullable(),
  keys: z.array(z.object({ rowId: z.uuid(), key: z.string(), number: z.number().int().nonnegative() })),
});
export type TaskKeys = z.infer<typeof taskKeysSchema>;

const upgrading = 'Tasks are being upgraded. Try again in a few minutes.';

export async function readTaskKeys(workspaceId: string, signal: AbortSignal) {
  const response = await jsonResponse(`${workspaceBase(workspaceId)}/tasks/keys`, {
    method: 'GET',
    signal,
    cache: 'no-store',
  });
  const value = await readJson(response, true);
  if (!response.ok) {
    const code = responseError(value, 'tasks-unavailable');
    throw new TableRequestError(
      response.status,
      code,
      code === 'tasks-upgrading' ? upgrading : 'Task keys could not be loaded. Try again.',
    );
  }
  return taskKeysSchema.parse(value);
}

export const taskKeysKey = (workspaceId: string) => ['tasks', 'keys', workspaceId] as const;

/** Every task's key by row id. Keys never change, so the list is only reread when tasks change. */
export function useTaskKeys(workspaceId: string, enabled = true) {
  return useFeatureRead({ key: taskKeysKey(workspaceId), enabled, load: signal => readTaskKeys(workspaceId, signal) });
}

const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const reminderScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.string() }),
  z.object({ kind: z.literal('daily'), time: timeOfDaySchema }),
  z.object({ kind: z.literal('weekdays'), time: timeOfDaySchema }),
  z.object({ kind: z.literal('weekly'), time: timeOfDaySchema, weekday: z.number().int().min(0).max(6) }),
]);
export type ReminderSchedule = z.infer<typeof reminderScheduleSchema>;

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
  stopReason: z.string().nullable(),
  firedCount: z.number(),
  lastFiredAt: z.string().nullable(),
  createdAt: z.string(),
  stoppedAt: z.string().nullable(),
});
export type Reminder = z.infer<typeof reminderSchema>;
export const remindersSchema = z.object({
  reminders: z.array(reminderSchema),
  targets: z.array(z.uuid()),
  canEdit: z.boolean(),
});
export type Reminders = z.infer<typeof remindersSchema>;

export const reminderMessages: Readonly<Record<string, string>> = {
  'reminder-target': 'Only the person assigned to this task, or someone mentioned in its comments, can be reminded.',
  'reminder-limit': 'This task already has 5 active reminders. Cancel one first.',
  'reminder-in-past': 'Choose a time in the future.',
  'unknown-time-zone': 'Your browser’s time zone isn’t recognised. Check your device’s time zone settings.',
  'not-a-task': 'Reminders can only be set on tasks.',
  'tasks-upgrading': upgrading,
};

/** Sets, lists and cancels a task's reminders. */
export function reminderApi(workspaceId: string, tableId: string, rowId: string) {
  const base = `${workspaceBase(workspaceId)}/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}/reminders`;
  const send = async (path: string, method: string, signal: AbortSignal, body?: unknown) => {
    const response = await jsonResponse(`${base}${path}`, { method, body, signal, cache: 'no-store' });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'reminders-unavailable');
      throw new TableRequestError(
        response.status,
        code,
        reminderMessages[code] ??
          (response.status === 404
            ? 'This task is missing or you can no longer read it.'
            : 'The reminder could not be saved. Try again.'),
      );
    }
    return remindersSchema.parse(value);
  };
  return {
    read: (signal: AbortSignal) => send('', 'GET', signal),
    create: (input: { membershipId: string; schedule: ReminderSchedule; timeZone?: string }) =>
      send('', 'POST', AbortSignal.timeout(30_000), input),
    cancel: (reminderId: string) => send(`/${encodeURIComponent(reminderId)}`, 'DELETE', AbortSignal.timeout(30_000)),
  };
}

export const taskDetailSchema = z.object({
  key: z.string(),
  number: z.number().int().nonnegative(),
  tableId: z.uuid(),
  rowId: z.uuid(),
  record: z.object({ id: z.uuid(), token: z.uuid(), values: tableValuesSchema }),
  runState: z.enum(['queued', 'working', 'waiting', 'done', 'failed']).nullable(),
  canEdit: z.boolean(),
  thread: rowThreadSchema,
  reminders: remindersSchema,
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

/** One task by key. A missing, deleted or unreadable task is `'not-found'`, so a key never reveals a task. */
export async function readTask(workspaceId: string, key: string, signal: AbortSignal) {
  const response = await jsonResponse(`${workspaceBase(workspaceId)}/tasks/${encodeURIComponent(key)}`, {
    method: 'GET',
    signal,
    cache: 'no-store',
  });
  const value = await readJson(response, true);
  if (response.status === 404 || response.status === 400) return 'not-found' as const;
  if (!response.ok) {
    const code = responseError(value, 'tasks-unavailable');
    throw new TableRequestError(
      response.status,
      code,
      code === 'tasks-upgrading' ? upgrading : 'This task could not be loaded. Try again.',
    );
  }
  return taskDetailSchema.parse(value);
}

export const taskDetailKey = (workspaceId: string, key: string) => ['tasks', 'detail', workspaceId, key] as const;

export const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const clock = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

/** A reminder's schedule in words, such as "Every weekday at 9:00 AM". */
export function scheduleText(schedule: ReminderSchedule) {
  switch (schedule.kind) {
    case 'once':
      return `Once, ${new Date(schedule.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
    case 'daily':
      return `Every day at ${clock(schedule.time)}`;
    case 'weekdays':
      return `Every weekday at ${clock(schedule.time)}`;
    case 'weekly':
      return `Every ${weekdays[schedule.weekday]} at ${clock(schedule.time)}`;
  }
}

/** The browser's IANA time zone, which reminders set on the web use. */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
