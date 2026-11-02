import type { ReactNode, RefObject } from 'react';
import { Add } from 'reicon-react/icons/Add';
import { Edit } from 'reicon-react/icons/Edit';
import { Trash } from 'reicon-react/icons/Trash';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import { Disclosure } from '@/components/disclosure';
import { UnsavedChanges } from '@/features/tables/feedback';
import type { DraftView, KnowledgeProposal } from '@tulipfarm/agents/draft-contracts';
import { TechnicalDetail } from './row-draft-card';

const operations = {
  add: { verb: 'Add', title: 'Add to Knowledge', done: 'added', doing: 'Adding…', icon: <Add size={16} /> },
  update: { verb: 'Update', title: 'Update', done: 'updated', doing: 'Updating…', icon: <Edit size={16} /> },
  remove: {
    verb: 'Remove',
    title: 'Remove from Knowledge',
    done: 'removed',
    doing: 'Removing…',
    icon: <Trash size={16} />,
  },
} as const;

export function KnowledgeDraftCard({
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
  proposal: KnowledgeProposal;
  locked: boolean;
  sending: boolean;
  dirty: boolean;
  decide: (decision: 'save' | 'dismiss') => void;
  result: RefObject<HTMLDivElement | null>;
  feedback: ReactNode;
  checkStatus: ReactNode;
}) {
  const { input } = proposal;
  const copy = operations[input.operation];
  const name = input.operation === 'update' ? input.previousTitle : input.title;
  const badge = {
    pending: { label: 'Needs approval', variant: 'warning' },
    preparing: { label: copy.doing.replace('…', ''), variant: 'secondary' },
    saved: { label: copy.done[0]!.toUpperCase() + copy.done.slice(1), variant: 'info' },
    dismissed: { label: 'Dismissed', variant: 'secondary' },
    stale: { label: 'Out of date', variant: 'warning' },
    failed: { label: `Not ${copy.done}`, variant: 'destructive' },
  } as const;
  const content = input.operation === 'remove' ? null : input.content;
  return (
    <ReviewCard
      label={`Review Knowledge ${copy.verb.toLowerCase()}`}
      icon={copy.icon}
      title={input.operation === 'update' ? `Update “${name}”` : `${copy.title}: “${name}”`}
      badge={badge[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button
              variant={input.operation === 'remove' ? 'destructive' : 'default'}
              disabled={locked}
              aria-busy={sending}
              onClick={() => decide('save')}
            >
              {copy.verb}
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
            {draft.status === 'stale' && (
              <div className="space-y-2">
                <p role="status">
                  This entry or its file changed after this draft. Nothing was {copy.done}. Ask chat for a fresh draft.
                </p>
                {!draft.outcome && (
                  <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                    Dismiss draft
                  </Button>
                )}
              </div>
            )}
            {draft.status === 'failed' && <p role="status">Nothing was {copy.done}. Ask chat to retry.</p>}
            {draft.status === 'preparing' && <p role="status">Your approval is recorded. {copy.doing}</p>}
            {draft.status === 'saved' && (
              <p role="status">
                {input.operation === 'remove'
                  ? 'Removed from Knowledge.'
                  : `${copy.done[0]!.toUpperCase()}${copy.done.slice(1)}. Agents can search it once Knowledge has read it.`}
              </p>
            )}
            {draft.status === 'dismissed' && <p role="status">Draft dismissed. Nothing was {copy.done}.</p>}
          </div>
          {feedback}
        </>
      }
    >
      <ReviewRows>
        {input.operation === 'update' && input.title !== input.previousTitle ? (
          <>
            <ReviewRow label="Current title">
              <span className="break-words">{input.previousTitle}</span>
            </ReviewRow>
            <ReviewRow label="New title">
              <span className="break-words">{input.title}</span>
            </ReviewRow>
          </>
        ) : (
          <ReviewRow label="Title">
            <span className="break-words">{input.title}</span>
          </ReviewRow>
        )}
        {content?.kind === 'file' && (
          <ReviewRow label="File">
            <span className="break-words">{content.fileName}</span>
          </ReviewRow>
        )}
        {content?.kind === 'note' && (
          <ReviewRow label={input.operation === 'update' ? 'New note' : 'Note'}>
            <span className="block max-h-64 overflow-y-auto whitespace-pre-wrap break-words">{content.text}</span>
          </ReviewRow>
        )}
        {input.operation === 'remove' && (
          <ReviewRow label="Kind">{input.entry === 'file' ? 'File from Files' : 'Note'}</ReviewRow>
        )}
      </ReviewRows>
      <p className="text-xs text-muted-foreground">
        {input.operation === 'remove'
          ? input.entry === 'file'
            ? 'Agents stop finding it. The file stays in Files.'
            : 'Agents stop finding this note.'
          : 'Only you and agents acting for you can search your Knowledge.'}
      </p>
      <Disclosure title="Technical details">
        <dl aria-label="Technical details" className="grid gap-2 text-xs text-muted-foreground">
          <TechnicalDetail term="Document ID">{proposal.targetId}</TechnicalDetail>
          {content?.kind === 'file' && <TechnicalDetail term="File ID">{content.fileId}</TechnicalDetail>}
          <TechnicalDetail term="Draft ID">{id}</TechnicalDetail>
          <TechnicalDetail term="SHA-256">{draft.digest}</TechnicalDetail>
        </dl>
      </Disclosure>
      {checkStatus}
    </ReviewCard>
  );
}
