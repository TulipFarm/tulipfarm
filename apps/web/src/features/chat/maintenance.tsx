import { Button } from '@tulipfarm/sprout/button';
import { Separator } from '@tulipfarm/sprout/separator';
import { useFeatureRead } from '@/lib/query';
import { CommandFeedback } from './conversation-feedback';
import { useConversationCommand } from './conversation-state';
import { conversationKeys } from './queries';
import type { ConversationApi, MaintenanceView } from './conversation-api';

type Maintenance = NonNullable<MaintenanceView['maintenance']>;

const embeddingPending = (status: string | null) =>
  status !== null && ['pending', 'queued', 'running'].includes(status);
const embeddingBlocked = (status: string | null) =>
  status !== null && ['credits-blocked', 'capacity-blocked', 'failed', 'unknown'].includes(status);

/** The quiet line for a recap that needs attention, or null when the recap is routine. */
export function maintenanceProblem(maintenance: Maintenance) {
  if (maintenance.errorCode) return maintenanceReason(maintenance.errorCode);
  switch (maintenance.state) {
    case 'blocked':
      return 'Saving this chat to Knowledge is blocked. Your messages are unchanged.';
    case 'failed':
      return 'Could not save this chat to Knowledge yet. It will retry in the background.';
    case 'stale':
      return 'The Knowledge recap no longer covers this chat. It needs a fresh update.';
    case 'ready':
      return embeddingBlocked(maintenance.embeddingStatus)
        ? 'Saved to Knowledge. Semantic search is paused; keyword search works.'
        : null;
    default:
      return null;
  }
}

/**
 * Sits after the last message of a closed chat. It stays silent while the recap is pending, shows a
 * divider once the recap is saved to Knowledge, and a muted line with recovery actions if it is stuck.
 */
export function ChatMaintenance({
  api,
  chatId,
  disabled,
}: {
  api: ConversationApi;
  chatId: string;
  disabled: boolean;
}) {
  const read = useFeatureRead({
    key: conversationKeys.maintenance(chatId),
    load: signal => api.maintenance(chatId, signal),
    pollWhile: view =>
      !!view.maintenance &&
      (['queued', 'running', 'publishing'].includes(view.maintenance.state) ||
        (view.maintenance.state === 'ready' && embeddingPending(view.maintenance.embeddingStatus))),
  });
  const write = useConversationCommand(api, () => {
    void read.refresh();
  });
  const state = read.state;
  const maintenance = state.kind === 'ready' ? state.data.maintenance : null;
  const failed = state.kind === 'error' || (state.kind === 'ready' && !!state.error);
  const resumeEmbedding = maintenance?.state === 'ready' && embeddingBlocked(maintenance.embeddingStatus);
  const resume =
    !!maintenance &&
    (['blocked', 'failed'].includes(maintenance.state) || resumeEmbedding) &&
    maintenance.errorCode !== 'generation-unconfirmed';
  const problem = failed
    ? 'Could not check whether this chat was saved to Knowledge. Your messages are unchanged.'
    : maintenance
      ? maintenanceProblem(maintenance)
      : null;
  const feedback = (
    <CommandFeedback
      write={write}
      refresh={() => void read.refresh()}
      refreshed={state.kind === 'ready' && !state.error && !state.refreshing}
    />
  );
  if (!problem) {
    return (
      <>
        {maintenance?.state === 'ready' && <Separator variant="fade">Saved to Knowledge</Separator>}
        {feedback}
      </>
    );
  }
  return (
    <section aria-label="Chat Knowledge status" className="space-y-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-2">
        <p role="status">
          {problem}
          {maintenance?.retryAt && ['blocked', 'failed'].includes(maintenance.state) && (
            <> Next try {new Date(maintenance.retryAt).toLocaleString()}.</>
          )}
        </p>
        {(failed || read.delayed) && (
          <Button
            variant="link"
            size="sm"
            disabled={state.kind === 'ready' && state.refreshing}
            onClick={() => void read.refresh()}
          >
            Check Knowledge status
          </Button>
        )}
        {resume && (
          <Button
            variant="link"
            size="sm"
            disabled={disabled || write.locked || failed}
            aria-busy={write.state.kind === 'sending'}
            onClick={() => void write.submit({ kind: 'resume-maintenance', chatId, commandId: crypto.randomUUID() })}
          >
            {write.state.kind === 'sending'
              ? 'Resuming update...'
              : resumeEmbedding
                ? 'Resume semantic search'
                : 'Resume Knowledge update'}
          </Button>
        )}
      </div>
      {feedback}
    </section>
  );
}

function maintenanceReason(code: string) {
  if (code === 'generation-unconfirmed')
    return 'The previous model call could not be confirmed. Automatic retries are paused to avoid charging twice. A workspace operator must review that call before this update can continue.';
  if (code.includes('credit'))
    return 'Workspace credits are unavailable. Work will continue when credits are available.';
  if (code.includes('access') || code.includes('author') || code.includes('member') || code.includes('source'))
    return 'The job could not confirm access to this chat or one of its sources. Restore access, or let an eligible member resume it.';
  if (code.includes('model'))
    return 'The summary model is unavailable or could not finish. The job will retry with the approved model settings.';
  return 'The background job could not finish. It will retry; you can also resume it here.';
}
