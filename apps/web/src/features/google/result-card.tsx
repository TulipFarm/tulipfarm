import { toolPresentation } from '@tulipfarm/conversations/tool-activity';
import { ResultCard, type ResultCardProps } from '@tulipfarm/sprout/result-card';
import type { Brand } from '@tulipfarm/sprout/brand-icon';
import type { GoogleProposal, googleApi } from '@/lib/google-workspace';
import {
  googleActionState,
  googleActionTitle,
  googleDestination,
  googleReceiptFile,
  type GoogleMutation,
} from './action-state';
import { calendarActionStatus, calendarActionTitle, isCalendarAction } from './calendar-action';

const brands: Record<ReturnType<typeof googleDestination>, Brand> = {
  'Google Slides': 'google-slides',
  'Google Docs': 'google-docs',
  'Google Sheets': 'google-sheets',
  'Google Drive': 'google-drive',
  'Google Calendar': 'google-calendar',
  Gmail: 'gmail',
};

export function GoogleProposalSummaryCard({
  proposal,
  action,
}: {
  proposal: Awaited<ReturnType<typeof googleApi.proposals>>['proposals'][number];
  action: NonNullable<ResultCardProps['action']>;
}) {
  const operation = { kind: proposal.operationKind };
  const destination = googleDestination(operation);
  const title = googleActionTitle(operation);
  const status = proposal.receiptStatus;
  const expired = Date.parse(proposal.expiresAt) <= Date.now();
  return (
    <ResultCard
      id={`google-proposal:${proposal.id}`}
      title={title}
      kind="Action"
      status={
        status === 'succeeded'
          ? 'Confirmed by Google'
          : status === 'outcome-unknown'
            ? 'Outcome not confirmed'
            : status === 'failed'
              ? 'Action failed'
              : status === 'executing'
                ? 'Action in progress'
                : proposal.decision === 'reject'
                  ? 'Rejected'
                  : expired
                    ? 'Review expired'
                    : proposal.decision === 'approve'
                      ? 'Approved · Not executed yet'
                      : 'Waiting for review'
      }
      state={
        status === 'succeeded'
          ? 'success'
          : status === 'failed' || status === 'outcome-unknown'
            ? 'error'
            : status === 'executing'
              ? 'running'
              : 'default'
      }
      apps={[
        {
          brand: brands[destination],
          name: destination,
          actions: [
            {
              label: title,
              state:
                status === 'succeeded'
                  ? 'completed'
                  : status === 'failed'
                    ? 'failed'
                    : status === 'outcome-unknown'
                      ? 'unknown'
                      : status === 'executing'
                        ? 'running'
                        : expired || proposal.decision === 'reject'
                          ? 'cancelled'
                          : 'pending',
            },
          ],
        },
      ]}
      action={action}
    />
  );
}

export function GoogleResultCard({
  proposal,
  mutation,
  action,
}: {
  proposal: GoogleProposal;
  mutation?: GoogleMutation | undefined;
  action?: ResultCardProps['action'];
}) {
  const state = googleActionState(proposal, mutation);
  const calendar = isCalendarAction(proposal.operation) ? proposal.operation : null;
  const destination = googleDestination(proposal.operation);
  const title = calendar
    ? `${calendarActionTitle(calendar)}${calendar.kind !== 'calendar.events.delete' && calendar.event.summary ? ` · ${calendar.event.summary}` : ''}`
    : (googleReceiptFile(proposal)?.title ?? googleActionTitle(proposal.operation));
  const label = toolPresentation('google.propose', {
    tool: 'google.propose',
    operation: proposal.operation,
  }).label.replace(/^Preparing: /, '');
  return (
    <ResultCard
      title={title}
      kind={calendar ? 'Calendar' : 'Action'}
      status={calendar && (!mutation || mutation.kind === 'idle') ? calendarActionStatus(proposal) : state.label}
      state={
        state.kind === 'succeeded'
          ? 'success'
          : state.kind === 'unknown' || state.kind === 'failed'
            ? 'error'
            : state.kind === 'saving' || state.kind === 'pending'
              ? 'running'
              : 'default'
      }
      apps={[
        {
          brand: brands[destination],
          name: destination,
          actions: [
            {
              label,
              state:
                state.kind === 'succeeded'
                  ? 'completed'
                  : state.kind === 'unknown'
                    ? 'unknown'
                    : state.kind === 'failed'
                      ? 'failed'
                      : state.kind === 'saving' || state.kind === 'pending'
                        ? 'running'
                        : state.kind === 'rejected' || state.kind === 'expired'
                          ? 'cancelled'
                          : 'pending',
            },
          ],
        },
      ]}
      action={action}
    />
  );
}
