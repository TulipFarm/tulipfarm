import type { ReactNode, RefObject } from 'react';
import { Archive } from 'reicon-react/icons/Archive';
import { ArchiveUp } from 'reicon-react/icons/ArchiveUp';
import { Folder } from 'reicon-react/icons/Folder';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import { Disclosure } from '@/components/disclosure';
import { UnsavedChanges } from '@/features/tables/feedback';
import type { DraftView, ProjectProposal } from '@tulipfarm/agents/draft-contracts';
import { TechnicalDetail } from './row-draft-card';

function changeOf(proposal: ProjectProposal) {
  const { current, settings } = proposal.input;
  if (!current) return { verb: 'Create', done: 'created', doing: 'Creating…', icon: <Folder size={16} /> } as const;
  if (settings.archived && !current.archived)
    return { verb: 'Archive', done: 'archived', doing: 'Archiving…', icon: <Archive size={16} /> } as const;
  if (!settings.archived && current.archived)
    return { verb: 'Restore', done: 'restored', doing: 'Restoring…', icon: <ArchiveUp size={16} /> } as const;
  return { verb: 'Update', done: 'updated', doing: 'Updating…', icon: <Folder size={16} /> } as const;
}

function Instructions({ text }: { text: string }) {
  return text ? (
    <span className="whitespace-pre-wrap break-words">{text}</span>
  ) : (
    <span className="text-muted-foreground">None</span>
  );
}

export function ProjectDraftCard({
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
  proposal: ProjectProposal;
  locked: boolean;
  sending: boolean;
  dirty: boolean;
  decide: (decision: 'save' | 'dismiss') => void;
  result: RefObject<HTMLDivElement | null>;
  feedback: ReactNode;
  checkStatus: ReactNode;
}) {
  const { current, settings, expectedRevision } = proposal.input;
  const change = changeOf(proposal);
  const renamed = current !== null && current.name !== settings.name;
  const instructionsChanged = (current?.instructions ?? '') !== settings.instructions;
  const badge = {
    pending: { label: 'Needs approval', variant: 'warning' },
    preparing: { label: change.doing.replace('…', ''), variant: 'secondary' },
    saved: { label: change.done[0]!.toUpperCase() + change.done.slice(1), variant: 'info' },
    dismissed: { label: 'Dismissed', variant: 'secondary' },
    stale: { label: 'Out of date', variant: 'warning' },
    failed: { label: `Not ${change.done}`, variant: 'destructive' },
  } as const;
  return (
    <ReviewCard
      label={`Review project ${change.verb.toLowerCase()}`}
      icon={change.icon}
      title={`${change.verb} “${current?.name ?? settings.name}”`}
      badge={badge[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button
              variant={change.verb === 'Archive' ? 'destructive' : 'default'}
              disabled={locked}
              aria-busy={sending}
              onClick={() => decide('save')}
            >
              {`${change.verb} project`}
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
                  {current ? 'The project changed after this draft.' : 'A project with this draft’s ID already exists.'}{' '}
                  Nothing was {change.done}. Ask chat for a fresh draft.
                </p>
                {!draft.outcome && (
                  <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                    Dismiss draft
                  </Button>
                )}
              </div>
            )}
            {draft.status === 'failed' && (
              <p role="status">The project could not be {change.done}. Ask chat to retry.</p>
            )}
            {draft.status === 'preparing' && <p role="status">Your approval is recorded. {change.doing}</p>}
            {draft.status === 'saved' && <p role="status">Project {change.done}.</p>}
            {draft.status === 'dismissed' && <p role="status">Draft dismissed. Nothing was {change.done}.</p>}
          </div>
          {feedback}
        </>
      }
    >
      <ReviewRows>
        {renamed ? (
          <>
            <ReviewRow label="Current name">
              <span className="break-words">{current.name}</span>
            </ReviewRow>
            <ReviewRow label="New name">
              <span className="break-words">{settings.name}</span>
            </ReviewRow>
          </>
        ) : (
          <ReviewRow label="Name">
            <span className="break-words">{settings.name}</span>
          </ReviewRow>
        )}
        {instructionsChanged && current && (
          <ReviewRow label="Current instructions">
            <Instructions text={current.instructions} />
          </ReviewRow>
        )}
        {(instructionsChanged || !current) && (
          <ReviewRow label={current ? 'New instructions' : 'Instructions'}>
            <Instructions text={settings.instructions} />
          </ReviewRow>
        )}
      </ReviewRows>
      {change.verb === 'Archive' && (
        <p className="text-xs text-muted-foreground">
          Archiving hides the project from its members’ project lists. Its chats, knowledge and members stay, and a
          manager can restore it later.
        </p>
      )}
      {change.verb === 'Create' && (
        <p className="text-xs text-muted-foreground">You will manage the new project and can invite members later.</p>
      )}
      <Disclosure title="Technical details">
        <dl aria-label="Technical details" className="grid gap-2 text-xs text-muted-foreground">
          <TechnicalDetail term="Project ID">
            {expectedRevision === null ? proposal.targetId : `${proposal.targetId} · Revision ${expectedRevision}`}
          </TechnicalDetail>
          <TechnicalDetail term="Draft ID">{id}</TechnicalDetail>
          <TechnicalDetail term="SHA-256">{draft.digest}</TechnicalDetail>
        </dl>
      </Disclosure>
      {checkStatus}
    </ReviewCard>
  );
}
