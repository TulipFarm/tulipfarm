import type { ReactNode, RefObject } from 'react';
import { Edit } from 'reicon-react/icons/Edit';
import { Trash } from 'reicon-react/icons/Trash';
import { ReviewCard } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import { Disclosure } from '@/components/disclosure';
import { UnsavedChanges } from '@/features/tables/feedback';
import type { DraftView, MemoryProposal } from '@tulipfarm/agents/draft-contracts';
import { TechnicalDetail } from './row-draft-card';

type DiffLine = { change: 'kept' | 'added' | 'removed'; text: string };

/** A line diff by longest common subsequence; memory is at most 10,000 characters, so this stays small. */
export function memoryLineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  const common = Array.from({ length: a.length + 1 }, () => Array.from<number>({ length: b.length + 1 }).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ change: 'kept', text: a[i]! });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || common[i]![j + 1]! >= common[i + 1]![j]!))
      lines.push({ change: 'added', text: b[j++]! });
    else lines.push({ change: 'removed', text: a[i++]! });
  }
  return lines;
}

function MemoryDiff({ before, after }: { before: string; after: string }) {
  const lines = memoryLineDiff(before, after);
  return (
    <div
      role="group"
      aria-label="Memory changes"
      className="max-h-72 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs"
    >
      {lines.length === 0 ? (
        <p className="text-muted-foreground">Memory is empty.</p>
      ) : (
        lines.map((line, index) => (
          <div
            key={index}
            className={
              line.change === 'added'
                ? 'whitespace-pre-wrap break-words bg-success/10'
                : line.change === 'removed'
                  ? 'whitespace-pre-wrap break-words bg-destructive/10 text-muted-foreground line-through'
                  : 'whitespace-pre-wrap break-words text-muted-foreground'
            }
          >
            <span aria-hidden="true" className="inline-block w-4 select-none">
              {line.change === 'added' ? '+' : line.change === 'removed' ? '−' : ' '}
            </span>
            {line.change === 'added' && <span className="sr-only">Adds </span>}
            {line.change === 'removed' && <span className="sr-only">Removes </span>}
            {line.text || '\u00a0'}
          </div>
        ))
      )}
    </div>
  );
}

export function MemoryDraftCard({
  id,
  draft,
  proposal,
  locked,
  sending,
  dirty,
  decide,
  result,
  feedback,
  checkStatus,
}: {
  id: string;
  draft: DraftView;
  proposal: MemoryProposal;
  locked: boolean;
  sending: boolean;
  dirty: boolean;
  decide: (decision: 'save' | 'dismiss') => void;
  result: RefObject<HTMLDivElement | null>;
  feedback: ReactNode;
  checkStatus: ReactNode;
}) {
  const { input } = proposal;
  const restore = input.operation === 'restore';
  const badge = restore
    ? ({
        pending: { label: 'Forgotten', variant: 'info' },
        preparing: { label: 'Restoring', variant: 'secondary' },
        saved: { label: 'Restored', variant: 'info' },
        dismissed: { label: 'Forgotten', variant: 'secondary' },
        stale: { label: 'Can’t undo', variant: 'warning' },
        failed: { label: 'Not restored', variant: 'destructive' },
        continued: { label: 'Continued in builder', variant: 'secondary' },
      } as const)
    : ({
        pending: { label: 'Needs approval', variant: 'warning' },
        preparing: { label: 'Saving', variant: 'secondary' },
        saved: { label: 'Saved', variant: 'info' },
        dismissed: { label: 'Dismissed', variant: 'secondary' },
        stale: { label: 'Out of date', variant: 'warning' },
        failed: { label: 'Not saved', variant: 'destructive' },
        continued: { label: 'Continued in builder', variant: 'secondary' },
      } as const);
  return (
    <ReviewCard
      label={restore ? 'Forgotten memory' : 'Review memory change'}
      icon={restore ? <Trash size={16} /> : <Edit size={16} />}
      title={restore ? 'Forgot part of your memory' : 'Update your memory'}
      badge={badge[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          restore ? (
            <>
              <Button variant="outline" disabled={locked} aria-busy={sending} onClick={() => decide('save')}>
                Undo
              </Button>
              <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                Keep it forgotten
              </Button>
            </>
          ) : (
            <>
              <Button disabled={locked} aria-busy={sending} onClick={() => decide('save')}>
                Save memory
              </Button>
              <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                Not now
              </Button>
            </>
          )
        ) : undefined
      }
      status={
        <>
          <UnsavedChanges dirty={dirty} />
          <div ref={result} tabIndex={-1} className="text-sm">
            {draft.status === 'stale' && (
              <div className="space-y-2">
                <p role="status">
                  {restore
                    ? 'Your memory changed after this, so it can’t be undone here. You can edit it in Settings.'
                    : 'Your memory changed after this draft. Nothing was saved. Ask chat for a fresh draft.'}
                </p>
                {!draft.outcome && (
                  <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                    Dismiss
                  </Button>
                )}
              </div>
            )}
            {draft.status === 'failed' && (
              <p role="status">Nothing was {restore ? 'restored' : 'saved'}. Ask chat to retry.</p>
            )}
            {draft.status === 'preparing' && (
              <p role="status">{restore ? 'Restoring your memory…' : 'Saving your memory…'}</p>
            )}
            {draft.status === 'saved' && (
              <p role="status">
                {restore
                  ? 'Restored. Your memory is back as it was.'
                  : 'Saved. Chat follows it from your next message.'}
              </p>
            )}
            {draft.status === 'dismissed' && (
              <p role="status">{restore ? 'Kept forgotten.' : 'Draft dismissed. Your memory didn’t change.'}</p>
            )}
          </div>
          {feedback}
        </>
      }
    >
      {restore ? (
        <MemoryDiff before={input.content} after={input.previousContent} />
      ) : (
        <MemoryDiff before={input.previousContent} after={input.content} />
      )}
      <p className="text-xs text-muted-foreground">
        Only you can see your memory. Chat uses it in your private chats outside projects.
      </p>
      <Disclosure title="Technical details">
        <dl aria-label="Technical details" className="grid gap-2 text-xs text-muted-foreground">
          <TechnicalDetail term="Revision">{String(input.expectedRevision)}</TechnicalDetail>
          <TechnicalDetail term="Draft ID">{id}</TechnicalDetail>
          <TechnicalDetail term="SHA-256">{draft.digest}</TechnicalDetail>
        </dl>
      </Disclosure>
      {checkStatus}
    </ReviewCard>
  );
}
