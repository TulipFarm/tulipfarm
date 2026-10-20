import type { ReactNode } from 'react';
import { parseCalendarRead, type CalendarEvent } from '@tulipfarm/google-workspace/calendar-events';
import { ArrowRight } from 'reicon-react/icons/ArrowRight';
import { Bell } from 'reicon-react/icons/Bell';
import { BellOff } from 'reicon-react/icons/BellOff';
import { Calendar } from 'reicon-react/icons/Calendar';
import { Clock } from 'reicon-react/icons/Clock';
import { Eye } from 'reicon-react/icons/Eye';
import { Location } from 'reicon-react/icons/Location';
import { Repeat } from 'reicon-react/icons/Repeat';
import { TextalignLeft } from 'reicon-react/icons/TextalignLeft';
import { Trash } from 'reicon-react/icons/Trash';
import { Video } from 'reicon-react/icons/Video';
import { Badge } from '@tulipfarm/sprout/badge';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { eventDate } from '@/components/calendar-event-list';
import { useCalendarActionEvent } from '@/features/integrations/queries';
import type { GoogleProposal } from '@/lib/google-workspace';
import type { CalendarAction } from './calendar-action';
import { GoogleReadFeedback } from './read';

type Attendee = NonNullable<CalendarEvent['attendees']>[number];
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function proposedEvent(operation: CalendarAction) {
  if (operation.kind === 'calendar.events.delete') return null;
  return (
    parseCalendarRead(
      { kind: 'calendar.events.get', calendarId: operation.calendarId, eventId: 'proposed-event' },
      { ...operation.event, id: 'proposed-event' },
    ).events[0] ?? null
  );
}

function eventZone(operation: CalendarAction, current: CalendarEvent | null | undefined) {
  const start = operation.kind !== 'calendar.events.delete' ? operation.event.start : null;
  return (start && 'dateTime' in start ? start.timeZone : undefined) ?? current?.timeZone ?? localZone();
}

function startDate(event: CalendarEvent) {
  return event.time.kind === 'timed'
    ? { value: new Date(event.time.startsAt), zone: undefined }
    : { value: new Date(`${event.time.startsOn}T12:00:00Z`), zone: 'UTC' };
}

function timeLabel(event: CalendarEvent, zone: string) {
  if (event.time.kind === 'all-day') return eventDate(event, zone);
  const start = new Date(event.time.startsAt);
  const end = new Date(event.time.endsAt);
  const day = (value: Date) =>
    value.toLocaleDateString(undefined, { timeZone: zone, month: 'short', day: 'numeric', year: 'numeric' });
  if (day(start) !== day(end)) return eventDate(event, zone).replace(` · ${zone}`, '');
  const clock = (value: Date) =>
    value.toLocaleTimeString(undefined, { timeZone: zone, hour: 'numeric', minute: '2-digit' });
  return `${clock(start)} – ${clock(end)}`;
}

function DateTile({
  event,
  zone,
  tone,
}: {
  event: CalendarEvent | null;
  zone: string;
  tone: 'default' | 'destructive';
}) {
  const start = event ? startDate(event) : null;
  const timeZone = start?.zone ?? zone;
  return (
    <div
      aria-hidden="true"
      className={`flex w-14 shrink-0 flex-col overflow-hidden rounded-lg border text-center ${tone === 'destructive' ? 'border-destructive/40' : 'border-input'}`}
    >
      <span
        className={`py-0.5 text-xs font-semibold tracking-wide uppercase ${tone === 'destructive' ? 'bg-destructive-subtle text-destructive' : 'bg-primary-subtle text-primary-text'}`}
      >
        {start ? start.value.toLocaleDateString(undefined, { timeZone, month: 'short' }) : '—'}
      </span>
      <span className="pt-1 text-2xl leading-none font-semibold tabular-nums text-foreground">
        {start ? start.value.toLocaleDateString(undefined, { timeZone, day: 'numeric' }) : <Calendar size={20} />}
      </span>
      <span className="pb-1.5 text-xs text-muted-foreground">
        {start ? start.value.toLocaleDateString(undefined, { timeZone, weekday: 'short' }) : ''}
      </span>
    </div>
  );
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2 text-sm">
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground">
        {icon}
      </span>
      <span className="sr-only">{label}: </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">{children}</div>
    </div>
  );
}

function Change({ before, after }: { before: string | null; after: string }) {
  if (before === null || before === after) return <span className="break-words">{after}</span>;
  if (!before)
    return (
      <span className="break-words font-medium text-primary-text">
        <span className="sr-only">Adds </span>
        {after}
      </span>
    );
  return (
    <>
      <span className="break-words text-muted-foreground line-through">
        <span className="sr-only">Was </span>
        {before}
      </span>
      <ArrowRight size={14} aria-hidden="true" />
      <span className="break-words font-medium text-primary-text">
        <span className="sr-only">Now </span>
        {after}
      </span>
    </>
  );
}

function AttendeeChip({ attendee, change }: { attendee: Attendee; change: 'kept' | 'added' | 'removed' }) {
  const name = attendee.displayName ?? attendee.email.split('@')[0] ?? attendee.email;
  return (
    <li className="min-w-0 max-w-full">
      <Badge variant={change === 'added' ? 'success' : change === 'removed' ? 'destructive' : 'outline'} size="chip">
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground uppercase"
        >
          {name.slice(0, 1)}
        </span>
        <span className={change === 'removed' ? 'min-w-0 break-all line-through' : 'min-w-0 break-all'}>
          {change === 'added' && <span className="sr-only">Adds </span>}
          {change === 'removed' && <span className="sr-only">Removes </span>}
          {attendee.displayName ? `${attendee.displayName} · ` : ''}
          {attendee.email}
          {attendee.responseStatus ? ` · ${attendee.responseStatus}` : ''}
        </span>
      </Badge>
    </li>
  );
}

function attendeeChanges(proposed: Attendee[] | undefined, current: Attendee[] | undefined, compared: boolean) {
  if (!proposed) return (current ?? []).map(attendee => ({ attendee, change: 'kept' as const }));
  if (!compared) return proposed.map(attendee => ({ attendee, change: 'kept' as const }));
  const before = new Map((current ?? []).map(attendee => [attendee.email.toLowerCase(), attendee]));
  const after = new Set(proposed.map(attendee => attendee.email.toLowerCase()));
  return [
    ...proposed.map(attendee => {
      const kept = before.get(attendee.email.toLowerCase());
      return {
        attendee: kept ? { ...kept, ...attendee } : attendee,
        change: kept ? ('kept' as const) : ('added' as const),
      };
    }),
    ...(current ?? [])
      .filter(attendee => !after.has(attendee.email.toLowerCase()))
      .map(attendee => ({ attendee, change: 'removed' as const })),
  ];
}

function CalendarActionHero({
  operation,
  current,
  loading,
}: {
  operation: CalendarAction;
  current: CalendarEvent | null | undefined;
  loading: boolean;
}) {
  const proposed = proposedEvent(operation);
  const removing = operation.kind === 'calendar.events.delete';
  const event = proposed ?? current ?? null;
  const zone = eventZone(operation, current);
  const compared = operation.kind === 'calendar.events.update' && !!current;
  const input = !removing ? operation.event : null;
  const attendees = attendeeChanges(input?.attendees, current?.attendees, compared);
  if (!event)
    return (
      <div className="flex gap-4 rounded-xl border border-input bg-card p-4">
        <DateTile event={null} zone={zone} tone={removing ? 'destructive' : 'default'} />
        <div className="min-w-0 flex-1 space-y-2">
          {loading ? (
            <>
              <Skeleton />
              <Skeleton />
            </>
          ) : current === null ? (
            <p className="text-sm text-muted-foreground">Already cancelled in Google Calendar</p>
          ) : (
            <p className="text-sm text-muted-foreground">Event details unavailable</p>
          )}
        </div>
      </div>
    );
  return (
    <div className={`flex gap-4 rounded-xl border bg-card p-4 ${removing ? 'border-destructive/40' : 'border-input'}`}>
      <DateTile event={event} zone={zone} tone={removing ? 'destructive' : 'default'} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {compared && current.title !== event.title && (
            <p className="text-sm break-words text-muted-foreground line-through">
              <span className="sr-only">Was </span>
              {current.title ?? 'Untitled event'}
            </p>
          )}
          <p
            className={`text-lg font-medium break-words ${removing ? 'text-muted-foreground line-through' : 'text-foreground'}`}
          >
            {event.title ?? 'Untitled event'}
          </p>
          {removing && (
            <Badge variant="destructive">
              <Trash size={12} />
              Will be deleted
            </Badge>
          )}
        </div>
        <Row icon={<Clock size={14} />} label="Time">
          <Change before={compared ? timeLabel(current, zone) : null} after={timeLabel(event, zone)} />
          {event.time.kind === 'timed' && <span className="text-xs text-muted-foreground">{zone}</span>}
        </Row>
        {(event.location || (compared && current.location)) && (
          <Row icon={<Location size={14} />} label="Location">
            <Change
              before={compared && input?.location !== undefined ? (current.location ?? '') : null}
              after={event.location ?? current?.location ?? ''}
            />
          </Row>
        )}
        {input?.description ? (
          <Row icon={<TextalignLeft size={14} />} label="Description">
            <span className="line-clamp-2 break-words text-muted-foreground">{input.description}</span>
          </Row>
        ) : input?.description === '' ? (
          <Row icon={<TextalignLeft size={14} />} label="Description">
            <span className="text-muted-foreground line-through">Description cleared</span>
          </Row>
        ) : null}
        {attendees.length > 0 && (
          <ul aria-label="Attendees" className="flex min-w-0 flex-wrap gap-1.5 pt-1">
            {attendees.map(({ attendee, change }, index) => (
              <AttendeeChip key={`${attendee.email}:${index}`} attendee={attendee} change={change} />
            ))}
          </ul>
        )}
        {input?.attendees?.length === 0 && <p className="text-xs text-muted-foreground">Removes all attendees</p>}
      </div>
    </div>
  );
}

function ComparedHero({
  workspaceId,
  proposal,
  operation,
  eventId,
}: {
  workspaceId: string;
  proposal: GoogleProposal;
  operation: CalendarAction;
  eventId: string;
}) {
  const read = useCalendarActionEvent(workspaceId, proposal, eventId);
  return (
    <section aria-label="Current calendar event" className="space-y-3">
      <CalendarActionHero
        operation={operation}
        current={read.data ? (read.data.events[0] ?? null) : undefined}
        loading={read.busy && !read.data}
      />
      {(read.error || (read.busy && read.data)) && (
        <GoogleReadFeedback busy={read.busy} error={read.error} hasData={!!read.data} title="Calendar event" />
      )}
    </section>
  );
}

export function CalendarActionVisual({
  workspaceId,
  proposal,
  operation,
  compareEventId,
}: {
  workspaceId: string;
  proposal: GoogleProposal;
  operation: CalendarAction;
  compareEventId: string | null;
}) {
  const input = operation.kind !== 'calendar.events.delete' ? operation.event : null;
  const notify =
    operation.sendUpdates === 'all'
      ? 'Guests notified'
      : operation.sendUpdates === 'externalOnly'
        ? 'External guests notified'
        : 'Guests not notified';
  return (
    <div className="space-y-3">
      {compareEventId ? (
        <ComparedHero workspaceId={workspaceId} proposal={proposal} operation={operation} eventId={compareEventId} />
      ) : (
        <section aria-label="Proposed calendar action">
          <CalendarActionHero operation={operation} current={undefined} loading={false} />
        </section>
      )}
      <ul aria-label="Action settings" className="flex flex-wrap gap-1.5">
        {input?.conferenceData && (
          <li>
            <Badge variant="info">
              <Video size={12} />
              Adds Google Meet
            </Badge>
          </li>
        )}
        <li>
          <Badge variant="secondary">
            {operation.sendUpdates === 'all' || operation.sendUpdates === 'externalOnly' ? (
              <Bell size={12} />
            ) : (
              <BellOff size={12} />
            )}
            {notify}
          </Badge>
        </li>
        {input?.recurrence && (
          <li>
            <Badge variant="secondary">
              <Repeat size={12} />
              {input.recurrence.length ? 'Repeats' : 'Stops repeating'}
            </Badge>
          </li>
        )}
        {input?.visibility && (
          <li>
            <Badge variant="secondary">
              <Eye size={12} />
              {input.visibility[0]?.toUpperCase()}
              {input.visibility.slice(1)}
            </Badge>
          </li>
        )}
        <li className="min-w-0 max-w-full">
          <Badge variant="secondary" size="chip">
            <Calendar size={12} />
            <span className="min-w-0 break-all">{operation.calendarId}</span>
          </Badge>
        </li>
      </ul>
    </div>
  );
}
