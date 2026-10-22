import { useCallback, useEffect, useState } from 'react';
import { Compress } from 'reicon-react/icons/Compress';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';
import { Separator } from '@tulipfarm/sprout/separator';
import { MessageActions } from '@tulipfarm/sprout/message-actions';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
import { useFeatureRead, useFeatureScope } from '@/lib/query';
import { useModelCatalog } from '@/features/models/use-model-catalog';
import { compactionFailure, compactionNote, compactionTitle, compactionUsage } from './compaction-copy';
import { conversationKeys } from './queries';
import type { CompactionDetail, CompactionPart, ConversationApi } from './conversation-api';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; detail: CompactionDetail };
type FamilyName = (id: string | null) => string | null;

/** The human side of a `/compact` command: the command and any handoff instructions, or a handoff retry. */
export function SentCompact({ prompt, compactionId }: { prompt: string | null; compactionId: string | null }) {
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Compress size={14} aria-hidden="true" />
        {compactionId ? 'Retry handoff' : '/compact'}
      </p>
      {prompt && <p className="max-w-prose whitespace-pre-wrap text-sm break-words text-muted-foreground">{prompt}</p>}
    </div>
  );
}

/** The durable status entry for one compaction attempt. It never replaces the messages it covers. */
export function CompactionStatus({
  api,
  chatId,
  part,
  disabled,
  onRetryHandoff,
}: {
  api: Pick<ConversationApi, 'compaction'>;
  chatId: string;
  part: CompactionPart;
  disabled: boolean;
  onRetryHandoff: (compactionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const usage = compactionUsage(part);
  const failed = part.state === 'failed';
  if (part.state === 'compacted' && part.handoffStatus !== 'pending' && part.handoffStatus !== 'failed') {
    return <Separator variant="fade">{part.trigger === 'manual' ? 'Compacted' : 'Auto compacted'}</Separator>;
  }
  if (part.trigger === 'inactivity') return <AutomaticRecap api={api} chatId={chatId} part={part} />;
  return (
    <section
      aria-label={compactionTitle(part)}
      className="flex flex-wrap items-start gap-3 rounded-xl border border-border bg-card px-4 py-3"
    >
      <span aria-hidden="true" className={failed ? 'mt-0.5 text-destructive' : 'mt-0.5 text-muted-foreground'}>
        <Compress size={16} />
      </span>
      <div className="min-w-0 flex-1 basis-56 space-y-1">
        <p className={failed ? 'text-sm font-medium text-destructive' : 'text-sm font-medium'}>
          {compactionTitle(part)}
        </p>
        <p className="text-sm text-muted-foreground">{compactionNote(part)}</p>
        {usage && <p className="text-xs tabular-nums text-muted-foreground">{usage}</p>}
        {part.handoffStatus === 'failed' && (
          <p className="text-sm text-destructive">The handoff could not be written. Open it to retry.</p>
        )}
      </div>
      {part.state !== 'unchanged' && (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          {part.handoffStatus ? 'View handoff' : 'View details'}
        </Button>
      )}
      {open && (
        <CompactionDialog
          api={api}
          chatId={chatId}
          compactionId={part.compactionId}
          disabled={disabled}
          onClose={() => setOpen(false)}
          onRetryHandoff={id => {
            setOpen(false);
            onRetryHandoff(id);
          }}
        />
      )}
    </section>
  );
}

function AutomaticRecap({
  api,
  chatId,
  part,
}: {
  api: Pick<ConversationApi, 'compaction'>;
  chatId: string;
  part: CompactionPart;
}) {
  const read = useFeatureRead({
    key: conversationKeys.compaction(chatId, part.compactionId),
    load: signal => api.compaction(chatId, part.compactionId, signal),
    pollWhile: detail => detail.handoff?.status === 'pending',
  });
  const state = read.state;
  const detail = state.kind === 'ready' && !state.error ? state.data : null;
  if (detail?.state === 'compacted' && detail.handoff?.status === 'completed')
    return <Separator variant="fade">Auto compacted</Separator>;
  return (
    <section aria-label="Automatic chat recap" className="space-y-3 rounded-xl border border-border bg-card px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <Compress size={16} aria-hidden="true" />
        Automatic chat recap
      </p>
      <p className="text-sm text-muted-foreground">
        Saved after this chat became inactive. Your original messages stay here.
      </p>
      {state.kind === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading recap...
        </p>
      )}
      {state.kind === 'unavailable' && (
        <p className="text-sm text-muted-foreground">This recap is no longer available with your current access.</p>
      )}
      {(state.kind === 'error' || (state.kind === 'ready' && state.error)) && (
        <div className="space-y-2">
          <Alert variant="destructive">
            <AlertDescription>Could not load this recap. Your original messages are unchanged.</AlertDescription>
          </Alert>
          <Button
            variant="outline"
            size="sm"
            disabled={state.kind === 'ready' && state.refreshing}
            onClick={() => void read.refresh()}
          >
            Retry loading recap
          </Button>
        </div>
      )}
      {detail && (
        <>
          {detail.coveredThrough !== null && (
            <p className="text-xs text-muted-foreground">Covers chat turns through {detail.coveredThrough}.</p>
          )}
          {detail.handoff?.status === 'pending' && (
            <p role="status" className="text-sm text-muted-foreground">
              {read.delayed
                ? 'The recap is still being prepared. It continues when you leave this page.'
                : 'Preparing recap...'}
            </p>
          )}
          {(detail.handoff?.status === 'failed' || detail.state === 'failed') && (
            <Alert variant="destructive">
              <AlertDescription>
                The recap could not be completed. Check the chat Knowledge status to resume it.
              </AlertDescription>
            </Alert>
          )}
          {!detail.handoff && detail.state !== 'failed' && (
            <p className="text-sm text-muted-foreground">
              No readable recap was saved for this attempt. Your original messages are unchanged.
            </p>
          )}
        </>
      )}
      {read.delayed && (
        <Button variant="outline" size="sm" onClick={() => void read.refresh()}>
          Check recap status
        </Button>
      )}
    </section>
  );
}

function CompactionDialog({
  api,
  chatId,
  compactionId,
  disabled,
  onClose,
  onRetryHandoff,
}: {
  api: Pick<ConversationApi, 'compaction'>;
  chatId: string;
  compactionId: string;
  disabled: boolean;
  onClose: () => void;
  onRetryHandoff: (compactionId: string) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setLoad({ kind: 'loading' });
    setAttempt(value => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api.compaction(chatId, compactionId, controller.signal).then(
      detail => setLoad({ kind: 'ready', detail }),
      () => {
        if (!controller.signal.aborted) setLoad({ kind: 'error' });
      },
    );
    return () => controller.abort();
  }, [api, chatId, compactionId, attempt]);
  const scope = useFeatureScope();
  const catalog = useModelCatalog(scope.kind === 'workspace' ? scope.workspaceId : '').state;
  const familyName: FamilyName = id =>
    id === null
      ? null
      : ((catalog.kind === 'ready' ? catalog.data.families.find(family => family.id === id)?.displayName : undefined) ??
        'An approved summary model');
  const detail = load.kind === 'ready' ? load.detail : null;
  const handoff = detail?.handoff ?? null;
  return (
    <Dialog
      open
      onOpenChange={next => {
        if (!next) onClose();
      }}
    >
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>{handoff ? 'Conversation handoff' : 'Compaction details'}</DialogTitle>
          <DialogDescription>
            {handoff
              ? 'A summary to continue this work elsewhere. The model keeps its own working summary.'
              : 'What changed in the model context. Your full conversation stays in this chat.'}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 min-h-0 space-y-4 overflow-y-auto px-4 pb-1">
          {load.kind === 'loading' && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading compaction details…
            </p>
          )}
          {load.kind === 'error' && (
            <Alert variant="destructive">
              <AlertDescription>Couldn’t load this compaction. Check your connection, then retry.</AlertDescription>
            </Alert>
          )}
          {detail && (
            <>
              {handoff && (
                <section aria-label="Handoff" className="space-y-2">
                  {handoff.status === 'pending' && (
                    <p role="status" className="text-sm text-muted-foreground">
                      Writing handoff…
                    </p>
                  )}
                  {handoff.status === 'failed' && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        The handoff could not be written. {compactionFailure(handoff.errorCode)} Retrying writes only
                        the handoff; the working summary is kept.
                      </AlertDescription>
                    </Alert>
                  )}
                  {handoff.status === 'completed' &&
                    (handoff.text === null ? (
                      <p className="text-sm text-muted-foreground">
                        This handoff is hidden because you can no longer read some of the sources it was written from.
                      </p>
                    ) : (
                      <>
                        <div className="rounded-lg border bg-background p-3">
                          <MessageResponse>{handoff.text}</MessageResponse>
                        </div>
                        <MessageActions text={handoff.text} />
                      </>
                    ))}
                  {handoff.prompt && <p className="text-xs text-muted-foreground">Instructions: {handoff.prompt}</p>}
                </section>
              )}
              <dl className="divide-y rounded-lg border">
                {details(detail, familyName).map(([label, value]) => (
                  <div key={label} className="grid gap-1 px-3 py-2 sm:grid-cols-3 sm:gap-3">
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 break-words text-sm text-foreground sm:col-span-2">{value}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
        <DialogFooter>
          {load.kind === 'error' && (
            <Button variant="outline" onClick={retry}>
              Retry
            </Button>
          )}
          {handoff?.status === 'failed' && (
            <Button variant="outline" disabled={disabled} onClick={() => onRetryHandoff(compactionId)}>
              Retry handoff
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function details(detail: CompactionDetail, familyName: FamilyName): [string, string][] {
  const usage = compactionUsage(detail);
  const model = familyName(detail.modelFamilyId);
  const fallback = familyName(detail.fallbackFromFamilyId);
  return [
    ['Result', compactionTitle(detail)],
    [
      'Started by',
      detail.trigger === 'inactivity'
        ? 'Automatic, after one hour of inactivity'
        : detail.trigger === 'automatic'
          ? `Automatic, at ${detail.triggerPercent}% of the model context`
          : 'A /compact request',
    ],
    ...(usage ? [['Context', usage] as [string, string]] : []),
    ...(model
      ? [['Summary model', fallback ? `${model}, because ${fallback} was unavailable` : model] as [string, string]]
      : []),
    ...(detail.cleanedMessages
      ? [
          [
            'File contents unloaded',
            `From ${detail.cleanedMessages} earlier ${detail.cleanedMessages === 1 ? 'message' : 'messages'}`,
          ] as [string, string],
        ]
      : []),
    ...(detail.state === 'failed' ? [['Reason', compactionFailure(detail.errorCode)] as [string, string]] : []),
    ['When', new Date(detail.createdAt).toLocaleString()],
  ];
}
