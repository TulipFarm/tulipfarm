import type { ReactNode, RefObject } from 'react';
import { MessageIcon } from '@tulipfarm/icons';
import { ReviewCard } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import { UnsavedChanges } from '@/features/tables/feedback';
import type { DraftView, TaskCommentProposal } from '@tulipfarm/agents/draft-contracts';

const badge = {
  pending: { label: 'Needs approval', variant: 'warning' },
  preparing: { label: 'Posting', variant: 'secondary' },
  saved: { label: 'Posted', variant: 'info' },
  dismissed: { label: 'Dismissed', variant: 'secondary' },
  stale: { label: 'Task gone', variant: 'warning' },
  failed: { label: 'Not posted', variant: 'destructive' },
  continued: { label: 'Continued in builder', variant: 'secondary' },
} as const;

export function TaskCommentDraftCard({
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
  draft: DraftView;
  proposal: TaskCommentProposal;
  locked: boolean;
  sending: boolean;
  dirty: boolean;
  decide: (decision: 'save' | 'dismiss') => void;
  result: RefObject<HTMLDivElement | null>;
  feedback: ReactNode;
  checkStatus: ReactNode;
}) {
  const { input } = proposal;
  const files = input.attachments.length;
  return (
    <ReviewCard
      label="Review comment"
      icon={<MessageIcon size="md" />}
      title={`Comment on ${input.key}`}
      badge={badge[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button disabled={locked} aria-busy={sending} onClick={() => decide('save')}>
              Post comment
            </Button>
            <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
              Not now
            </Button>
          </>
        ) : undefined
      }
      status={
        <>
          <UnsavedChanges dirty={dirty} />
          <div ref={result} tabIndex={-1} className="text-sm">
            {draft.status === 'stale' && <p role="status">The task no longer exists. Nothing was posted.</p>}
            {draft.status === 'failed' && <p role="status">Nothing was posted. Ask chat to retry.</p>}
            {draft.status === 'preparing' && <p role="status">Posting…</p>}
            {draft.status === 'saved' && <p role="status">Posted on {input.key}.</p>}
            {draft.status === 'dismissed' && <p role="status">Nothing was posted.</p>}
          </div>
          {feedback}
        </>
      }
    >
      <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 text-sm">
        {input.body}
      </div>
      {files > 0 && (
        <p className="text-xs text-muted-foreground">
          Adds {files === 1 ? 'the file' : `${files} files`} from this chat. Anyone who can see {input.key} can open{' '}
          {files === 1 ? 'it' : 'them'}.
        </p>
      )}
      {checkStatus}
    </ReviewCard>
  );
}
