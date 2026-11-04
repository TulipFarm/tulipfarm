import type { ReactNode, RefObject } from 'react';
import { Share } from 'reicon-react/icons/Share';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import { Disclosure } from '@/components/disclosure';
import { UnsavedChanges } from '@/features/tables/feedback';
import type { DraftView, FileShareProposal } from '@tulipfarm/agents/draft-contracts';
import { TechnicalDetail } from './row-draft-card';

const roles = { viewer: 'Can view', editor: 'Can edit', manager: 'Can manage' } as const;

function People({ names, count, empty }: { names: string[]; count: number; empty: string }) {
  if (count === 0) return <span className="text-muted-foreground">{empty}</span>;
  const more = count - names.length;
  return (
    <span className="break-words">
      {names.join(', ')}
      {more > 0 && <span className="text-muted-foreground"> and {more} more</span>}
    </span>
  );
}

export function FileShareDraftCard({
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
  proposal: FileShareProposal;
  locked: boolean;
  sending: boolean;
  dirty: boolean;
  decide: (decision: 'save' | 'dismiss') => void;
  result: RefObject<HTMLDivElement | null>;
  feedback: ReactNode;
  checkStatus: ReactNode;
}) {
  const { file, role, subjects, excluded, before, added } = proposal.input;
  const badge = {
    pending: { label: 'Needs approval', variant: 'warning' },
    preparing: { label: 'Sharing', variant: 'secondary' },
    saved: { label: 'Shared', variant: 'info' },
    dismissed: { label: 'Dismissed', variant: 'secondary' },
    stale: { label: 'Out of date', variant: 'warning' },
    failed: { label: 'Not shared', variant: 'destructive' },
  } as const;
  return (
    <ReviewCard
      label="Review file sharing"
      icon={<Share size={16} />}
      title={`Share “${file.name}”`}
      badge={badge[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button disabled={locked} aria-busy={sending} onClick={() => decide('save')}>
              Share
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
                  Who can open this {file.kind} changed after this draft. Nothing was shared. Ask chat for a fresh
                  draft.
                </p>
                {!draft.outcome && (
                  <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                    Dismiss draft
                  </Button>
                )}
              </div>
            )}
            {draft.status === 'failed' && <p role="status">Nothing was shared. Ask chat to retry.</p>}
            {draft.status === 'preparing' && <p role="status">Your approval is recorded. Sharing…</p>}
            {draft.status === 'saved' && <p role="status">Shared. To stop sharing, open the {file.kind} in Files.</p>}
            {draft.status === 'dismissed' && <p role="status">Draft dismissed. Nothing was shared.</p>}
          </div>
          {feedback}
        </>
      }
    >
      <ReviewRows>
        <ReviewRow label={file.kind === 'folder' ? 'Folder' : 'File'}>
          <span className="break-words">{file.name}</span>
        </ReviewRow>
        <ReviewRow label="Share with">
          <ul className="space-y-1">
            {subjects.map(subject => (
              <li key={subject.id} className="break-words">
                {subject.name}
                <span className="text-muted-foreground">
                  {' '}
                  · {subject.kind === 'team' ? 'Team' : 'Person'}
                  {subject.current && `, now ${roles[subject.current].toLowerCase()}`}
                </span>
              </li>
            ))}
          </ul>
        </ReviewRow>
        <ReviewRow label="Role">{roles[role]}</ReviewRow>
        <ReviewRow label="Can open it now">
          <People names={before.names} count={before.count} empty="No one else" />
        </ReviewRow>
        <ReviewRow label="Can open it after">
          <People names={added.names} count={added.count} empty="No one new" />
        </ReviewRow>
        {excluded.length > 0 && (
          <ReviewRow label="Left off">
            <ul className="space-y-1">
              {excluded.map(subject => (
                <li key={subject.id} className="break-words">
                  {subject.name}
                  <span className="text-muted-foreground"> · Can’t see some of the information in this plan</span>
                </li>
              ))}
            </ul>
          </ReviewRow>
        )}
      </ReviewRows>
      <p className="text-xs text-muted-foreground">
        This shares only this {file.kind}, not the chat or the folder it’s in.
      </p>
      <Disclosure title="Technical details">
        <dl aria-label="Technical details" className="grid gap-2 text-xs text-muted-foreground">
          <TechnicalDetail term="File ID">{file.id}</TechnicalDetail>
          {proposal.input.planId && <TechnicalDetail term="Plan ID">{proposal.input.planId}</TechnicalDetail>}
          <TechnicalDetail term="Draft ID">{id}</TechnicalDetail>
          <TechnicalDetail term="SHA-256">{draft.digest}</TechnicalDetail>
        </dl>
      </Disclosure>
      {checkStatus}
    </ReviewCard>
  );
}
