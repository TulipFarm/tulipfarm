import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { useFeatureRead } from '@/lib/query';
import { CommandFeedback } from './conversation-feedback';
import { useConversationCommand } from './conversation-state';
import { conversationKeys } from './queries';
import type { ConversationApi, MaintenanceView } from './conversation-api';

const embeddingPending = (status: string | null) =>
  status !== null && ['pending', 'queued', 'running'].includes(status);
const embeddingBlocked = (status: string | null) =>
  status !== null && ['credits-blocked', 'capacity-blocked', 'failed', 'unknown'].includes(status);

export function maintenanceCopy(maintenance: MaintenanceView['maintenance'], isClosed: boolean) {
  if (!isClosed)
    return 'This chat is active. Its earlier recap is kept here, but hidden from Knowledge until the next update.';
  if (!maintenance)
    return 'You can keep replying here. Since this chat has been quiet, TulipFarm will save a short recap of it to Knowledge automatically, so agents can reuse what was decided.';
  switch (maintenance.state) {
    case 'queued':
      return 'The recap is queued. It will run in the background using workspace credits.';
    case 'running':
      return 'Preparing a recap. Your original messages are unchanged.';
    case 'publishing':
      return 'The recap is saved. Adding it to Knowledge...';
    case 'ready':
      return 'The recap is ready in Knowledge, with the same chat and source access checks.';
    case 'blocked':
      return 'The Knowledge update is blocked. Your original messages are unchanged.';
    case 'failed':
      return 'The Knowledge update could not finish. It will retry in the background.';
    case 'stale':
      return 'This recap no longer covers the current chat. A fresh update is needed before it can be used in Knowledge.';
  }
}

export function ChatMaintenance({
  api,
  chatId,
  isClosed,
  disabled,
}: {
  api: ConversationApi;
  chatId: string;
  isClosed: boolean;
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
    maintenance &&
    (['blocked', 'failed'].includes(maintenance.state) || resumeEmbedding) &&
    maintenance.errorCode !== 'generation-unconfirmed' &&
    isClosed;
  return (
    <section aria-label="Chat Knowledge status" className="space-y-2 text-sm">
      {state.kind === 'loading' && (
        <p role="status" className="text-muted-foreground">
          Loading chat Knowledge status...
        </p>
      )}
      {state.kind === 'unavailable' && (
        <p className="text-muted-foreground">Chat Knowledge status is unavailable with your current access.</p>
      )}
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>
            Could not check the Knowledge update. This does not change your saved messages.
          </AlertDescription>
        </Alert>
      )}
      {state.kind === 'ready' && !failed && (
        <>
          <p role="status" className="text-muted-foreground">
            {maintenanceCopy(maintenance, isClosed)}
          </p>
          {isClosed && maintenance?.errorCode && (
            <Alert variant="destructive">
              <AlertDescription>{maintenanceReason(maintenance.errorCode)}</AlertDescription>
            </Alert>
          )}
          {isClosed &&
            maintenance?.state === 'ready' &&
            maintenance.embeddingStatus &&
            !['ready', 'completed'].includes(maintenance.embeddingStatus) && (
              <p className="text-muted-foreground">
                Keyword search is ready. Semantic search: {maintenance.embeddingStatus.replaceAll('-', ' ')}.
              </p>
            )}
          {isClosed && maintenance?.retryAt && ['blocked', 'failed'].includes(maintenance.state) && (
            <p className="text-xs text-muted-foreground">
              Next background check: {new Date(maintenance.retryAt).toLocaleString()}.
            </p>
          )}
        </>
      )}
      {read.delayed && (
        <p className="text-muted-foreground">
          Automatic status checks are paused. The job continues in the background.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(failed || read.delayed) && (
          <Button
            variant="outline"
            size="sm"
            disabled={state.kind === 'ready' && state.refreshing}
            onClick={() => void read.refresh()}
          >
            Check Knowledge status
          </Button>
        )}
        {resume && (
          <Button
            variant="outline"
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
      <CommandFeedback
        write={write}
        refresh={() => void read.refresh()}
        refreshed={state.kind === 'ready' && !state.error && !state.refreshing}
      />
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
