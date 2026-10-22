import { Button } from '@tulipfarm/sprout/button';
import { CalendarEventList } from '@/components/calendar-event-list';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useUpcomingMeetings } from '@/features/integrations/queries';

export const showAllMeetingsPrompt =
  'Show all events on my primary Google Calendar happening now or starting in the next 12 hours, ordered by start time. Include ongoing events and read further pages if available.';

export function UpcomingMeetings({
  workspaceId,
  onShowAll,
  disabled,
}: {
  workspaceId: string;
  onShowAll: () => void;
  disabled: boolean;
}) {
  const meetings = useUpcomingMeetings(workspaceId);
  if (meetings.kind === 'hidden') return null;
  return (
    <section
      aria-label="Upcoming meetings"
      aria-busy={meetings.kind === 'loading' || (meetings.kind === 'ready' && meetings.refreshing)}
      className="space-y-3"
    >
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Upcoming meetings</h2>
        {meetings.kind === 'ready' && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onShowAll}>
            Show all
          </Button>
        )}
      </header>
      {meetings.kind === 'loading' ? (
        <div role="status" aria-label="Loading upcoming meetings" className="space-y-3 rounded-xl border p-4">
          <div aria-hidden="true" className="space-y-3">
            <Skeleton shape="line" />
            <Skeleton shape="line" />
            <Skeleton shape="line" />
          </div>
        </div>
      ) : meetings.kind === 'error' ? (
        <StatePanel
          kind="error"
          title="Could not load meetings"
          description="Your calendar could not be read. Try loading it again."
        >
          <Button variant="outline" onClick={meetings.retry}>
            Retry meetings
          </Button>
        </StatePanel>
      ) : (
        <>
          <CalendarEventList
            compact
            events={meetings.events}
            timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
          />
          {meetings.failed && (
            <div className="flex items-center justify-between gap-3">
              <p role="alert" className="text-sm text-muted-foreground">
                Could not refresh meetings.
              </p>
              <Button variant="outline" size="sm" onClick={meetings.retry}>
                Retry meetings
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
