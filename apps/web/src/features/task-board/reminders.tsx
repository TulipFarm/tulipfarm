import { useState } from 'react';
import { CloseIcon } from '@tulipfarm/icons';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { actorLabel, useActorDirectory } from '@/features/tables/actors';
import { TableRequestError } from '@/features/tables/request-state';
import {
  browserTimeZone,
  reminderApi,
  scheduleText,
  weekdays,
  type ReminderSchedule,
  type Reminders,
} from './task-api';

export type ScheduleDraft = { kind: ReminderSchedule['kind']; at: string; time: string; weekday: number };

const kindLabels: Record<ScheduleDraft['kind'], string> = {
  once: 'Once',
  daily: 'Every day',
  weekdays: 'Every weekday',
  weekly: 'Every week',
};

const pad = (value: number) => String(value).padStart(2, '0');
/** A date as a `datetime-local` input value, in the browser's time zone. */
const localInput = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** Tomorrow at 9:00, every weekday at 9:00, or Mondays at 9:00, depending on the kind chosen. */
export function scheduleDraft(): ScheduleDraft {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return { kind: 'once', at: localInput(tomorrow), time: '09:00', weekday: 1 };
}

/** The schedule to send, or null when the date or time is incomplete. A one-off time is sent as an exact instant. */
export function draftSchedule(draft: ScheduleDraft): ReminderSchedule | null {
  if (draft.kind === 'once') {
    const at = new Date(draft.at);
    return draft.at && !Number.isNaN(at.getTime()) ? { kind: 'once', at: at.toISOString() } : null;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return null;
  return draft.kind === 'weekly'
    ? { kind: 'weekly', time: draft.time, weekday: draft.weekday }
    : { kind: draft.kind, time: draft.time };
}

export const draftText = (draft: ScheduleDraft) => {
  const schedule = draftSchedule(draft);
  return schedule ? scheduleText(schedule) : 'Choose a time';
};

export const reminderFailure = (failure: unknown) =>
  failure instanceof TableRequestError ? failure.message : 'The reminder could not be saved. Try again.';

/** How often a reminder fires, and when. Times are in the browser's time zone. */
export function ScheduleFields({
  draft,
  change,
  disabled,
}: {
  draft: ScheduleDraft;
  change: (draft: ScheduleDraft) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <Select
        value={draft.kind}
        disabled={disabled}
        onValueChange={kind => kind && change({ ...draft, kind: kind as ScheduleDraft['kind'] })}
      >
        <SelectTrigger width="full" size="sm" aria-label="Repeat">
          <SelectValue>{kindLabels[draft.kind]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {Object.entries(kindLabels).map(([kind, label]) => (
            <SelectItem key={kind} value={kind}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {draft.kind === 'once' ? (
        <Input
          type="datetime-local"
          scale="sm"
          aria-label="Date and time"
          value={draft.at}
          min={localInput(new Date())}
          disabled={disabled}
          onChange={event => change({ ...draft, at: event.target.value })}
        />
      ) : (
        <div className="flex gap-2">
          {draft.kind === 'weekly' && (
            <div className="min-w-0 flex-1">
              <Select
                value={String(draft.weekday)}
                disabled={disabled}
                onValueChange={day => day && change({ ...draft, weekday: Number(day) })}
              >
                <SelectTrigger width="full" size="sm" aria-label="Day">
                  <SelectValue>{weekdays[draft.weekday]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {weekdays.map((day, index) => (
                    <SelectItem key={day} value={String(index)}>
                      {day}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <Input
              type="time"
              scale="sm"
              aria-label="Time"
              value={draft.time}
              disabled={disabled}
              onChange={event => change({ ...draft, time: event.target.value })}
            />
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Times are in {browserTimeZone()}.</p>
    </div>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A task's active reminders, who they nudge and when, with a form to set another. */
export function TaskReminders({
  workspaceId,
  tableId,
  rowId,
  reminders,
  assignee,
  changed,
}: {
  workspaceId: string;
  tableId: string;
  rowId: string;
  reminders: Reminders;
  /** The assignee's membership ID when a person has the task; they are offered first. */
  assignee: string | null;
  changed: () => Promise<unknown>;
}) {
  const directory = useActorDirectory(workspaceId);
  const people = directory.state.kind === 'ready' ? directory.state.data : undefined;
  const name = (membershipId: string) => actorLabel(people, { type: 'member', id: membershipId });
  const active = reminders.reminders.filter(reminder => reminder.status === 'active');
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState(scheduleDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = reminderApi(workspaceId, tableId, rowId);
  const chosen =
    target && reminders.targets.includes(target)
      ? target
      : assignee && reminders.targets.includes(assignee)
        ? assignee
        : (reminders.targets[0] ?? null);
  const schedule = draftSchedule(draft);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await changed();
      return true;
    } catch (failure) {
      setError(reminderFailure(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!chosen || !schedule) return;
    const done = await act(() => api.create({ membershipId: chosen, schedule, timeZone: browserTimeZone() }));
    if (done) {
      setAdding(false);
      setDraft(scheduleDraft());
    }
  };
  return (
    <div className="space-y-2">
      {active.length === 0 && !adding && <p className="text-sm text-muted-foreground">No reminders.</p>}
      {active.length > 0 && (
        <ul className="space-y-2">
          {active.map(reminder => (
            <li key={reminder.id} className="flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="font-medium">{name(reminder.membershipId)}</p>
                <p>{scheduleText(reminder.schedule)}</p>
                <p className="text-xs text-muted-foreground">
                  {reminder.nextFireAt ? `Next ${when(reminder.nextFireAt)}` : 'No upcoming time'} · Set by{' '}
                  {name(reminder.createdByMembershipId)}
                </p>
              </div>
              {reminders.canEdit && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Cancel reminder for ${name(reminder.membershipId)}`}
                  disabled={busy}
                  onClick={() => void act(() => api.cancel(reminder.id))}
                >
                  <CloseIcon size="xs" aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {reminders.canEdit &&
        (adding ? (
          <div className="space-y-2 rounded-md border p-2.5">
            {reminders.targets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Assign this task to a person, or mention someone in a comment, to remind them.
              </p>
            ) : (
              <>
                <Select value={chosen ?? ''} disabled={busy} onValueChange={next => next && setTarget(next)}>
                  <SelectTrigger width="full" size="sm" aria-label="Remind">
                    <SelectValue>{chosen ? `Remind ${name(chosen)}` : 'Choose a person'}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {reminders.targets.map(membershipId => (
                      <SelectItem key={membershipId} value={membershipId}>
                        {name(membershipId)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ScheduleFields draft={draft} change={setDraft} disabled={busy} />
              </>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAdding(false)}>
                Cancel
              </Button>
              {reminders.targets.length > 0 && (
                <Button size="sm" disabled={busy || !chosen || !schedule} onClick={() => void save()}>
                  {busy ? 'Saving…' : 'Set reminder'}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
          >
            Add reminder
          </Button>
        ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
