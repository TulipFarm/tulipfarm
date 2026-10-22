import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import type { CalendarHistoryResult } from '@tulipfarm/google-workspace/calendar-events';
import { Button } from '@tulipfarm/sprout/button';
import { CalendarEventList } from '@/components/calendar-event-list';
import { CanvasSection } from '@tulipfarm/sprout/canvas';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useGoogleProposal } from '@/features/integrations/queries';
import { GoogleProposalReview } from '@/features/google/proposals';
import { calendarActionTitle, isCalendarAction } from '@/features/google/calendar-action';
import { GoogleReadFeedback } from '@/features/google/read';
import { useFlag } from '@/lib/feature-flags';
import { useCanvas, useResultAttention } from './canvas-state';
import { workspaceRoute } from '@/router';
import { googleActionState, googleActionTitle } from '@/features/google/action-state';
import { GoogleResultCard } from '@/features/google/result-card';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { Skeleton } from '@tulipfarm/sprout/skeleton';

export function CalendarReadCanvas({ result }: { result: CalendarHistoryResult }) {
  const { workspace } = workspaceRoute.useRouteContext();
  return (
    <CanvasSection
      title="Google Calendar"
      meta={
        result.kind === 'events'
          ? `Read ${new Date(result.requestedAt).toLocaleString()} · Saved snapshot, not a live calendar`
          : 'Saved result unavailable'
      }
      actions={
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/$workspaceSlug/calendar" params={{ workspaceSlug: workspace.slug }} />}
        >
          Open live calendar
        </Button>
      }
    >
      {result.kind === 'unavailable' ? (
        <StatePanel
          kind="unavailable"
          heading="h3"
          title="Calendar result unavailable"
          description="Reconnect Google and ask for a new read in chat."
        />
      ) : (
        <>
          {result.events.length ? (
            <CalendarEventList events={result.events} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone} />
          ) : (
            <StatePanel
              kind="empty"
              heading="h3"
              title="No events in this read"
              description="This completed read returned no events. It does not describe any pending create, update, or delete. Ask in chat to read a different date range."
            />
          )}
          {result.continuation === 'more-available' && (
            <p className="text-sm text-muted-foreground">More events are available. Ask in chat for the next page.</p>
          )}
          <p className="text-sm text-muted-foreground">
            Events may have changed since this read. Ask in chat to read the calendar again.
          </p>
        </>
      )}
    </CanvasSection>
  );
}

export function CalendarReadCard({ result }: { result: CalendarHistoryResult }) {
  const canvas = useCanvas();
  const enabled = useFlag('google-calendar-canvas');
  const title =
    result.kind === 'events'
      ? `Calendar read · ${result.events.length} ${result.events.length === 1 ? 'event' : 'events'}`
      : 'Calendar result unavailable';
  const open = () =>
    canvas.show({
      id: `calendar:${result.callId}`,
      title: 'Calendar events',
      content: { kind: 'calendar-read', result },
    });
  useEffect(() => {
    canvas.update(`calendar:${result.callId}`, { content: { kind: 'calendar-read', result } });
  }, [result, canvas.update]);
  if (!enabled)
    return (
      <section aria-label="Google Calendar result" className="space-y-2">
        {result.kind === 'events' ? (
          <>
            <p className="text-xs text-muted-foreground">
              Google Calendar · Requested {new Date(result.requestedAt).toLocaleString()}
            </p>
            <CalendarEventList events={result.events} timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone} />
            {result.continuation === 'more-available' && (
              <p className="text-xs text-muted-foreground">More events are available. This result shows one page.</p>
            )}
          </>
        ) : (
          <p>Calendar result unavailable. Reconnect Google and ask again.</p>
        )}
      </section>
    );
  return (
    <section aria-label="Google Calendar result">
      <ResultCard
        title={title}
        kind="Calendar"
        status={result.kind === 'events' ? 'Saved read · Not a pending action' : 'Result unavailable'}
        state={result.kind === 'events' ? 'success' : 'error'}
        apps={[
          {
            brand: 'google-calendar',
            name: 'Google Calendar',
            actions: [
              {
                label: result.kind === 'events' ? `Read ${result.events.length} events` : 'Read calendar events',
                state: result.kind === 'events' ? 'completed' : 'unknown',
              },
            ],
          },
        ]}
        action={{ label: 'Open calendar', onClick: open }}
      />
    </section>
  );
}

export function ChatGoogleProposal({ workspaceId, proposalId }: { workspaceId: string; proposalId: string }) {
  const read = useGoogleProposal(workspaceId, proposalId);
  const enabled = useFlag('google-calendar-canvas');
  const canvas = useCanvas();
  const proposal = read.data;
  const mutation = canvas.googleMutations[proposalId];
  const state = proposal ? googleActionState(proposal, mutation) : null;
  const activeReview =
    canvas.open &&
    canvas.items.some(
      item =>
        item.id === canvas.activeId &&
        (item.content.kind === 'google-action' || item.content.kind === 'calendar-action') &&
        item.content.proposalId === proposalId,
    );
  useResultAttention(
    `google:${proposalId}`,
    state?.kind === 'review' && !activeReview,
    'A Google action needs your review',
  );
  const calendar = proposal && isCalendarAction(proposal.operation) ? proposal.operation : null;
  const title = calendar
    ? calendarActionTitle(calendar)
    : proposal
      ? googleActionTitle(proposal.operation)
      : 'Google action';
  const open = () =>
    canvas.show({
      id: `${calendar ? 'calendar' : 'google'}-action:${proposalId}`,
      title,
      content: { kind: calendar ? 'calendar-action' : 'google-action', workspaceId, proposalId },
    });
  if (calendar && !enabled)
    return <GoogleProposalReview workspaceId={workspaceId} proposalId={proposalId} available focusOnLoad={false} />;
  return (
    <section aria-label={calendar ? 'Calendar action card' : 'Google action card'} className="space-y-3">
      {!proposal && read.busy ? (
        <div role="status" aria-label="Loading Google action">
          <Skeleton shape="title" />
          <Skeleton />
        </div>
      ) : read.state.kind === 'unavailable' ? (
        <StatePanel
          kind="unavailable"
          title="Google action unavailable"
          description="This action is missing or you no longer have access."
        />
      ) : (
        <GoogleReadFeedback busy={read.busy} error={read.error} hasData={!!proposal} title="Google action" />
      )}
      {proposal && (
        <GoogleResultCard
          proposal={proposal}
          mutation={mutation}
          action={{
            label: calendar ? 'Open calendar action' : state?.kind === 'review' ? 'Review in Canvas' : 'Open in Canvas',
            onClick: open,
          }}
        />
      )}
      {read.error && (
        <Button variant="outline" disabled={read.busy} onClick={() => void read.refresh()}>
          Reload Google action
        </Button>
      )}
    </section>
  );
}
