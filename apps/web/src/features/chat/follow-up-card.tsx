import { useState } from 'react';
import { AlarmClock } from 'reicon-react/icons/AlarmClock';
import { Button } from '@tulipfarm/sprout/button';
import { ResultCard, type ResultCardProps } from '@tulipfarm/sprout/result-card';
import { Skeleton } from '@tulipfarm/sprout/skeleton';
import type { FollowUpView } from '@tulipfarm/agents/follow-up-contracts';
import { ReadError, ReadFeedback } from '@/components/read-feedback';
import { confirmedRejection } from '@/features/tables/request-state';
import { useFeatureRead } from '@/lib/query';
import type { ConversationApi } from './conversation-api';
import { conversationKeys } from './queries';

const statusLabels: Record<FollowUpView['status'], string> = {
  pending: 'Scheduled',
  claimed: 'Starting',
  fired: 'Ran in this chat',
  cancelled: 'Cancelled',
  failed: 'Did not run',
  skipped: 'Skipped',
};
const cardStates: Record<FollowUpView['status'], ResultCardProps['state']> = {
  pending: 'default',
  claimed: 'running',
  fired: 'success',
  cancelled: 'disabled',
  failed: 'error',
  skipped: 'disabled',
};

function dueText(value: FollowUpView) {
  const due = new Date(value.dueAt);
  const time = due.toLocaleString(undefined, {
    dateStyle: due.toDateString() === new Date().toDateString() ? undefined : 'medium',
    timeStyle: 'short',
    ...(value.timezone ? { timeZone: value.timezone } : {}),
  });
  return value.status === 'pending' || value.status === 'claimed' ? `Runs ${time}` : `Due ${time}`;
}

/** A follow-up the agent scheduled in this chat: what it will do, when, and a way to cancel it. */
export function FollowUpCard({ api, chatId, id }: { api: ConversationApi; chatId: string; id: string }) {
  const read = useFeatureRead({
    key: conversationKeys.followUp(chatId, id),
    load: signal => api.followUp(chatId, id, signal),
    pollWhile: value => value.status === 'pending' || value.status === 'claimed',
    interval: 15_000,
    maxChecks: 100,
  });
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function cancel() {
    setCancelling(true);
    setError(null);
    try {
      await api.cancelFollowUp(chatId, id, new AbortController().signal);
    } catch (failure) {
      setError(
        confirmedRejection(failure) ??
          'The follow-up may not be cancelled. Check its status below before trying again.',
      );
    } finally {
      setCancelling(false);
      await read.refresh();
    }
  }
  return (
    <section aria-label="Follow-up" className="space-y-2">
      <ReadFeedback
        state={read.state}
        errorTitle="Could not load follow-up"
        retry={<Button onClick={() => void read.refresh()}>Try again</Button>}
        loading={
          <section role="status" aria-label="Loading follow-up">
            <Skeleton />
            <span className="sr-only">Loading follow-up…</span>
          </section>
        }
        unavailable={() => (
          <p className="text-sm text-muted-foreground">This follow-up is not available. Check your access.</p>
        )}
        refreshError={message => <ReadError message={message} />}
        refreshing={null}
      >
        {value => (
          <ResultCard
            title="Follow-up"
            kind="Activity"
            icon={<AlarmClock aria-hidden />}
            apps={[]}
            status={
              cancelling
                ? 'Cancelling'
                : `${statusLabels[value.status]} · ${dueText(value)}${value.failureReason ? ` · ${value.failureReason}` : ''}`
            }
            state={cancelling ? 'running' : cardStates[value.status]}
            action={
              value.status === 'pending'
                ? { label: 'Cancel', onClick: () => void cancel(), disabled: cancelling }
                : undefined
            }
          >
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{value.instruction}</p>
          </ResultCard>
        )}
      </ReadFeedback>
      {error && <ReadError message={error} />}
    </section>
  );
}
