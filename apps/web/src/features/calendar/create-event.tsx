import { useCallback, useRef, useState } from 'react';
import { z } from 'zod';
import { format, addDays } from 'date-fns';
import { Field, CheckboxField } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Button } from '@tulipfarm/sprout/button';
import { Alert } from '@tulipfarm/sprout/alert';
import { UnsavedChanges, samePage } from '@/features/tables/feedback';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import { googleApi, googleError, type GoogleProposal } from '@/lib/google-workspace';
import { GoogleProposalReview } from '@/features/google/proposals';
import type { ProviderCalendar } from './api';
import { ambiguousTime, localDate } from './model';

export type EventDraft = {
  title: string;
  date: string;
  time: string;
  endTime: string;
  calendarId: string;
  zone: string;
  allDay: boolean;
  guests: string;
  notes: string;
  repeat: string;
};
export function validateEvent(draft: EventDraft) {
  const errors: Partial<Record<keyof EventDraft, string>> = {};
  if (!draft.title.trim()) errors.title = 'Enter an event name.';
  if (!draft.calendarId) errors.calendarId = 'Choose a writable calendar.';
  if (!z.iso.date().safeParse(draft.date).success) errors.date = 'Choose a valid date.';
  if (!draft.allDay && !errors.date) {
    try {
      const start = localDate(draft.date, draft.time, draft.zone),
        end = localDate(draft.date, draft.endTime, draft.zone);
      if (end <= start) errors.endTime = 'Choose an end time after the start.';
      if (ambiguousTime(start, draft.zone) || ambiguousTime(end, draft.zone))
        errors.time = 'This time occurs twice during daylight saving. Choose a time outside the repeated hour.';
    } catch {
      errors.time = 'Choose a valid time in this time zone. Daylight saving can skip an hour.';
    }
  }
  const emails = draft.guests
    .split(/[,;\n]/)
    .map(value => value.trim())
    .filter(Boolean);
  if (emails.length > 100 || emails.some(email => !z.email().safeParse(email).success))
    errors.guests = 'Enter valid email addresses, separated by commas (up to 100).';
  return errors;
}
export type InitialEvent = { date: string; time: string; title?: string; endTime?: string };
export function CreateCalendarEvent({
  workspaceId,
  calendars,
  initial,
  zone,
  available,
  onNew,
}: {
  workspaceId: string;
  calendars: ProviderCalendar[];
  initial: InitialEvent;
  zone: string;
  available: boolean;
  onNew: () => void;
}) {
  const writable = calendars.filter(calendar => ['writer', 'owner'].includes(calendar.accessRole));
  const hour = Math.min(23, Number(initial.time.slice(0, 2)) + 1);
  const [draft, setDraft] = useState<EventDraft>({
    title: initial.title ?? '',
    date: initial.date,
    time: initial.time,
    endTime: initial.endTime ?? `${String(hour).padStart(2, '0')}:${hour === 23 ? '59' : initial.time.slice(3)}`,
    calendarId: writable.find(calendar => calendar.primary)?.id ?? writable[0]?.id ?? '',
    zone,
    allDay: false,
    guests: '',
    notes: '',
    repeat: 'none',
  });
  const [settled, setSettled] = useState(false);
  const onSettled = useCallback(() => setSettled(true), []);
  const [errors, setErrors] = useState<ReturnType<typeof validateEvent>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [proposal, setProposal] = useState<GoogleProposal | null>(null);
  const command = useRef<{ id: string; draft: EventDraft } | null>(null),
    lock = useRef(false);
  const update = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (Object.keys(errors).length) setErrors(validateEvent(next));
  };
  const submit = () => {
    if (!available) return;
    const invalid = validateEvent(draft);
    setErrors(invalid);
    if (Object.keys(invalid).length) return 'invalid' as const;
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    command.current ??= { id: crypto.randomUUID(), draft: { ...draft } };
    const exact = command.current.draft,
      commandId = command.current.id;
    const start = exact.allDay
      ? { date: exact.date }
      : { dateTime: localDate(exact.date, exact.time, exact.zone).toISOString(), timeZone: exact.zone };
    const end = exact.allDay
      ? { date: format(addDays(localDate(exact.date, '12:00', exact.zone), 1), 'yyyy-MM-dd') }
      : { dateTime: localDate(exact.date, exact.endTime, exact.zone).toISOString(), timeZone: exact.zone };
    void googleApi
      .propose(workspaceId, {
        commandId,
        operation: {
          kind: 'calendar.events.create',
          calendarId: exact.calendarId,
          sendUpdates: exact.guests.trim() ? 'all' : 'none',
          event: {
            summary: exact.title.trim(),
            start,
            end,
            ...(exact.notes.trim() ? { description: exact.notes.trim() } : {}),
            ...(exact.guests.trim()
              ? {
                  attendees: [
                    ...new Set(
                      exact.guests
                        .split(/[,;\n]/)
                        .map(value => value.trim())
                        .filter(Boolean),
                    ),
                  ].map(email => ({ email })),
                }
              : {}),
            ...(exact.repeat !== 'none' ? { recurrence: [`RRULE:FREQ=${exact.repeat}`] } : {}),
          },
        },
      })
      .then(setProposal)
      .catch((failure: unknown) =>
        setError(`${googleError(failure)} Retry uses the same event draft; no duplicate proposal is created.`),
      )
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  };
  if (proposal)
    return (
      <div className="space-y-5">
        <UnsavedChanges dirty={!settled} keepsEdits={samePage} />
        <GoogleProposalReview
          workspaceId={workspaceId}
          proposalId={proposal.id}
          available={available}
          focusOnLoad={false}
          variant="canvas"
          onSettled={onSettled}
        />
        {settled && (
          <Button variant="outline" onClick={onNew}>
            Create another event
          </Button>
        )}
      </div>
    );
  return (
    <>
      <UnsavedChanges dirty={!!draft.title || command.current !== null} keepsEdits={samePage} />
      <Form label="New calendar event" disabled={!available || busy || command.current !== null} onSubmit={submit}>
        <div className="grid gap-5">
          {!available && (
            <Alert>
              The original calendar integration is unavailable. Your draft is kept. Restore that integration before
              sending.
            </Alert>
          )}
          <Field label="Event name" required error={errors.title}>
            <Input
              maxLength={500}
              value={draft.title}
              onChange={event => update('title', event.target.value)}
              autoFocus
            />
          </Field>
          <Field label="Calendar" required error={errors.calendarId}>
            <Select
              value={draft.calendarId}
              onValueChange={value => {
                if (value) update('calendarId', value);
              }}
              items={writable.map(calendar => ({ value: calendar.id, label: calendar.summary }))}
            >
              <SelectTrigger width="full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {writable.map(calendar => (
                  <SelectItem key={calendar.id} value={calendar.id}>
                    {calendar.summary}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Date" required error={errors.date}>
            <Input type="date" value={draft.date} onChange={event => update('date', event.target.value)} />
          </Field>
          <CheckboxField label="All day" checked={draft.allDay} onCheckedChange={value => update('allDay', value)} />
          {!draft.allDay && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start" required error={errors.time}>
                <Input type="time" value={draft.time} onChange={event => update('time', event.target.value)} />
              </Field>
              <Field label="End" required error={errors.endTime}>
                <Input type="time" value={draft.endTime} onChange={event => update('endTime', event.target.value)} />
              </Field>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {draft.zone.replaceAll('_', ' ')} · Guests receive an invitation only after approval.
          </p>
          <Field label="Repeat" optional>
            <Select
              value={draft.repeat}
              onValueChange={value => {
                if (value) update('repeat', value);
              }}
              items={[
                { value: 'none', label: 'Does not repeat' },
                { value: 'DAILY', label: 'Daily' },
                { value: 'WEEKLY', label: 'Weekly' },
                { value: 'MONTHLY', label: 'Monthly' },
              ]}
            >
              <SelectTrigger width="full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Does not repeat</SelectItem>
                <SelectItem value="DAILY">Daily</SelectItem>
                <SelectItem value="WEEKLY">Weekly</SelectItem>
                <SelectItem value="MONTHLY">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Guests" optional error={errors.guests}>
            <Input
              value={draft.guests}
              placeholder="name@example.com"
              onChange={event => update('guests', event.target.value)}
            />
          </Field>
          <Field label="Notes" optional>
            <Textarea maxLength={10000} value={draft.notes} onChange={event => update('notes', event.target.value)} />
          </Field>
          <FormFooter
            dirty={!proposal && !command.current}
            submit={{
              label: command.current ? 'Retry event review' : 'Review event',
              pendingLabel: 'Preparing event…',
              state: busy
                ? { kind: 'busy' }
                : !available
                  ? { kind: 'blocked', reason: 'Restore the original Google integration.' }
                  : { kind: 'ready' },
            }}
            error={error ?? (Object.keys(errors).length ? 'Fix the marked fields.' : undefined)}
            note="Review the exact event before it is sent to Google."
          />
        </div>
      </Form>
    </>
  );
}
