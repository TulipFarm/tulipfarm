import { parseCalendarRead } from '@tulipfarm/google-workspace/calendar-events';
import { z } from 'zod';
import { CalendarEventDetails, CalendarEventList, eventDate } from '@/components/calendar-event-list';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import type { GoogleProposal } from '@/lib/google-workspace';
import { Button } from '@tulipfarm/sprout/button';
import { useCalendarActionEvent } from '@/features/integrations/queries';
import { GoogleReadFeedback } from './read';

type Operation = GoogleProposal['operation'];
export type CalendarAction = Extract<
  Operation,
  { kind: 'calendar.events.create' | 'calendar.events.update' | 'calendar.events.delete' }
>;
export function isCalendarAction(operation: Operation): operation is CalendarAction {
  return (
    operation.kind === 'calendar.events.create' ||
    operation.kind === 'calendar.events.update' ||
    operation.kind === 'calendar.events.delete'
  );
}
export function calendarActionTitle(operation: CalendarAction) {
  return `${operation.kind === 'calendar.events.create' ? 'Create' : operation.kind === 'calendar.events.update' ? 'Update' : 'Delete'} calendar event`;
}
export function calendarActionStatus(proposal: GoogleProposal) {
  if (proposal.receipt)
    return { succeeded: 'Completed', failed: 'Failed', executing: 'In progress', 'outcome-unknown': 'Outcome unknown' }[
      proposal.receipt.status
    ];
  if (proposal.decision === 'reject') return 'Rejected';
  if (Date.parse(proposal.expiresAt) <= Date.now()) return 'Expired';
  return proposal.decision === 'approve' ? 'Approved · Not yet executed' : 'Needs your approval · Nothing changed';
}
export function CalendarActionSummary({ operation }: { operation: CalendarAction }) {
  const event = operation.kind !== 'calendar.events.delete' ? operation.event : null;
  const zone = event?.start && 'dateTime' in event.start ? event.start.timeZone : undefined;
  const parsed = event
    ? parseCalendarRead(
        { kind: 'calendar.events.get', calendarId: operation.calendarId, eventId: 'proposed-event' },
        { ...event, id: 'proposed-event' },
      ).events[0]
    : undefined;
  const date = parsed ? eventDate(parsed, zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) : undefined;
  return (
    <section aria-label="Proposed calendar action" className="space-y-4">
      <h3 className="text-lg font-medium">{calendarActionTitle(operation)}</h3>
      {event && (
        <div className="rounded-xl border border-input bg-card p-4">
          <CalendarEventDetails
            title={event.summary}
            date={date}
            attendees={event.attendees}
            location={event.location}
          />
        </div>
      )}
      <dl className="grid min-w-0 gap-2 text-sm">
        <div>
          <dt className="text-muted-foreground">Calendar</dt>
          <dd className="break-all">{operation.calendarId}</dd>
        </div>
        {'eventId' in operation && (
          <div>
            <dt className="text-muted-foreground">Exact event</dt>
            <dd className="break-all">{operation.eventId}</dd>
          </div>
        )}
        {event?.description !== undefined && (
          <div>
            <dt className="text-muted-foreground">Description</dt>
            <dd className="whitespace-pre-wrap break-words">{event.description || 'Clear description'}</dd>
          </div>
        )}
        {event?.attendees?.length === 0 && (
          <div>
            <dt className="text-muted-foreground">Attendees</dt>
            <dd>Remove all attendees</dd>
          </div>
        )}
        {event?.recurrence && (
          <div>
            <dt className="text-muted-foreground">Recurrence</dt>
            <dd className="break-all">{event.recurrence.length ? event.recurrence.join('; ') : 'Remove recurrence'}</dd>
          </div>
        )}
        {event?.visibility && (
          <div>
            <dt className="text-muted-foreground">Visibility</dt>
            <dd>{event.visibility}</dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground">Guest notifications</dt>
          <dd>
            {operation.sendUpdates === 'all'
              ? 'Send to all guests'
              : operation.sendUpdates === 'externalOnly'
                ? 'Send only to guests outside Google Calendar'
                : 'Do not send notifications'}
          </dd>
        </div>
      </dl>
      {event?.conferenceData && (
        <p className="text-sm">
          Request a new Google Meet link. A Join action appears only when Google returns a link.
        </p>
      )}
      {operation.kind === 'calendar.events.update' && (
        <p className="text-sm text-muted-foreground">
          Only the fields shown change. Other fields stay as they are. A supplied attendee list replaces the current
          list.
        </p>
      )}
      {operation.kind === 'calendar.events.delete' && (
        <Alert variant="destructive">
          <AlertDescription>
            Delete this exact event from this calendar. This cannot be undone here. Check the event ID before approving.
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}

export function CalendarActionOutcome({ proposal }: { proposal: GoogleProposal }) {
  if (!isCalendarAction(proposal.operation) || proposal.receipt?.status !== 'succeeded') return null;
  if (proposal.operation.kind === 'calendar.events.delete')
    return <p role="status">Google confirmed the event was deleted.</p>;
  try {
    const data = proposal.receipt.result.data;
    const { id } = z.object({ id: z.string() }).parse(data);
    if ('eventId' in proposal.operation && id !== proposal.operation.eventId)
      return (
        <Alert variant="destructive">
          <AlertDescription>
            Google returned a different event ID. Check the exact response before making another change.
          </AlertDescription>
        </Alert>
      );
    const page = parseCalendarRead(
      { kind: 'calendar.events.get', calendarId: proposal.operation.calendarId, eventId: id },
      data,
    );
    return <CalendarEventList events={page.events} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone} />;
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return (
      <Alert>
        <AlertDescription>
          Google confirmed the action, but returned no complete event card. Read the event again to check its details
          and Meet link.
        </AlertDescription>
      </Alert>
    );
  }
}

export function CalendarCurrentEvent({
  workspaceId,
  proposal,
  eventId,
  compact = false,
}: {
  workspaceId: string;
  proposal: GoogleProposal;
  eventId: string;
  compact?: boolean;
}) {
  const read = useCalendarActionEvent(workspaceId, proposal, eventId);
  return (
    <section aria-label="Current calendar event" className="space-y-3">
      {!compact && <p className="text-sm font-medium">Current event in Google Calendar</p>}
      <GoogleReadFeedback busy={read.busy} error={read.error} hasData={!!read.data} title="Calendar event" />
      {read.data &&
        (read.data.events.length ? (
          <CalendarEventList events={read.data.events} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone} />
        ) : (
          <p>This event was cancelled in Google Calendar.</p>
        ))}
      <Button
        variant="outline"
        size="sm"
        disabled={read.busy}
        aria-busy={read.busy}
        onClick={() => void read.refresh()}
      >
        Check event and Meet link
      </Button>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          Read-only check. It never creates or resends an event. This view does not change the approved action.
        </p>
      )}
    </section>
  );
}
