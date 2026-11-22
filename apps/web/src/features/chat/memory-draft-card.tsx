import type { ReactNode, RefObject } from 'react';
import { DeleteIcon, EditIcon } from '@tulipfarm/icons';
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

export function MemoryDiff({ before, after }: { before: string; after: string }) {
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
  const operation = input.operation;
  const restore = operation === 'restore';
  const forget = operation === 'forget';
  const copy = {
    edit: {
      label: 'Review memory change',
      title: 'Update your memory',
      save: 'Save memory',
      dismiss: 'Not now',
      stale: 'Your memory changed after this draft. Nothing was saved. Ask chat for a fresh draft.',
      failed: 'Nothing was saved. Ask chat to retry.',
      preparing: 'Saving your memory…',
      saved: 'Saved. Chat follows it from your next message.',
      dismissed: 'Draft dismissed. Your memory didn’t change.',
    },
    restore: {
      label: 'Forgotten memory',
      title: 'Forgot part of your memory',
      save: 'Undo',
      dismiss: 'Keep it forgotten',
      stale: 'Your memory changed after this, so it can’t be undone here. You can edit it in Settings.',
      failed: 'Nothing was restored. Ask chat to retry.',
      preparing: 'Restoring your memory…',
      saved: 'Restored. Your memory is back as it was.',
      dismissed: 'Kept forgotten.',
    },
    forget: {
      label: 'Forget memory permanently',
      title: 'Forget part of your memory permanently?',
      save: 'Forget permanently',
      dismiss: 'Not now',
      stale: 'Your memory changed after this request. Nothing was forgotten. Ask chat again.',
      failed: 'Nothing was forgotten. Ask chat to retry.',
      preparing: 'Forgetting…',
      saved: 'Forgotten permanently, including from your memory’s history. This can’t be undone.',
      dismissed: 'Nothing was forgotten.',
    },
  }[operation];
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
    : forget
      ? ({
          pending: { label: 'Needs confirmation', variant: 'warning' },
          preparing: { label: 'Forgetting', variant: 'secondary' },
          saved: { label: 'Forgotten', variant: 'info' },
          dismissed: { label: 'Kept', variant: 'secondary' },
          stale: { label: 'Out of date', variant: 'warning' },
          failed: { label: 'Not forgotten', variant: 'destructive' },
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
      label={copy.label}
      icon={restore || forget ? <DeleteIcon size="md" /> : <EditIcon size="md" />}
      title={copy.title}
      badge={badge[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button
              variant={restore ? 'outline' : forget ? 'destructive' : 'default'}
              disabled={locked}
              aria-busy={sending}
              onClick={() => decide('save')}
            >
              {copy.save}
            </Button>
            <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
              {copy.dismiss}
            </Button>
          </>
        ) : undefined
      }
      status={
        <>
          <UnsavedChanges dirty={dirty} />
          <div ref={result} tabIndex={-1} className="text-sm">
            {draft.status === 'stale' && (
              <div className="space-y-2">
                <p role="status">{copy.stale}</p>
                {!draft.outcome && (
                  <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                    Dismiss
                  </Button>
                )}
              </div>
            )}
            {draft.status === 'failed' && <p role="status">{copy.failed}</p>}
            {draft.status === 'preparing' && <p role="status">{copy.preparing}</p>}
            {draft.status === 'saved' && <p role="status">{copy.saved}</p>}
            {draft.status === 'dismissed' && <p role="status">{copy.dismissed}</p>}
          </div>
          {feedback}
        </>
      }
    >
      {input.operation === 'forget' ? (
        input.forgotten ? (
          <>
            <div
              role="group"
              aria-label="Text to forget"
              className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-destructive/10 p-2 font-mono text-xs"
            >
              {input.forgotten}
            </div>
            <p className="text-sm">This erases the text from your memory and its history. You can’t undo it.</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">The text from this request is no longer stored.</p>
        )
      ) : input.operation === 'restore' ? (
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
