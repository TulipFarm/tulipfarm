import type { ReactNode, RefObject } from 'react';
import { Edit } from 'reicon-react/icons/Edit';
import { Folder } from 'reicon-react/icons/Folder';
import { Reply } from 'reicon-react/icons/Reply';
import { Trash } from 'reicon-react/icons/Trash';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import { Disclosure } from '@/components/disclosure';
import { UnsavedChanges } from '@/features/tables/feedback';
import type { DraftView, FilesProposal } from '@tulipfarm/agents/draft-contracts';
import { TechnicalDetail } from './row-draft-card';

const changes = {
  rename: { verb: 'Rename', done: 'renamed', doing: 'Renaming…', icon: <Edit size={16} /> },
  move: { verb: 'Move', done: 'moved', doing: 'Moving…', icon: <Folder size={16} /> },
  trash: { verb: 'Move to Trash', done: 'moved to Trash', doing: 'Moving to Trash…', icon: <Trash size={16} /> },
  restore: { verb: 'Restore', done: 'restored', doing: 'Restoring…', icon: <Reply size={16} /> },
} as const;

const place = (name: string | null, parentId: string | null) =>
  parentId === null ? 'Files' : (name ?? 'A folder you can’t open');

export function FileDraftCard({
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
  proposal: FilesProposal;
  locked: boolean;
  sending: boolean;
  dirty: boolean;
  decide: (decision: 'save' | 'dismiss') => void;
  result: RefObject<HTMLDivElement | null>;
  feedback: ReactNode;
  checkStatus: ReactNode;
}) {
  const { change, items } = proposal.input;
  const copy = changes[change.kind];
  const noun = items.length === 1 ? `“${items[0]!.name}”` : `${items.length} items`;
  const accessChanges = items.filter(item => item.accessChanges);
  const badge = {
    pending: { label: 'Needs approval', variant: 'warning' },
    preparing: { label: copy.doing.replace('…', ''), variant: 'secondary' },
    saved: { label: copy.done[0]!.toUpperCase() + copy.done.slice(1), variant: 'info' },
    dismissed: { label: 'Dismissed', variant: 'secondary' },
    stale: { label: 'Out of date', variant: 'warning' },
    failed: { label: `Not ${copy.done}`, variant: 'destructive' },
    continued: { label: 'Continued in builder', variant: 'secondary' },
  } as const;
  return (
    <ReviewCard
      label={`Review file ${copy.verb.toLowerCase()}`}
      icon={copy.icon}
      title={`${copy.verb} ${noun}`}
      badge={badge[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button
              variant={change.kind === 'trash' ? 'destructive' : 'default'}
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
                  {items.length === 1 ? 'This item' : 'One of these items'} changed after this draft. Nothing was{' '}
                  {copy.done}. Ask chat for a fresh draft.
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
                {items.length === 1 ? 'Item' : 'Items'} {copy.done}.
              </p>
            )}
            {draft.status === 'dismissed' && <p role="status">Draft dismissed. Nothing was {copy.done}.</p>}
          </div>
          {feedback}
        </>
      }
    >
      <ReviewRows>
        {change.kind === 'rename' ? (
          <>
            <ReviewRow label="Current name">
              <span className="break-words">{items[0]!.name}</span>
            </ReviewRow>
            <ReviewRow label="New name">
              <span className="break-words">{change.name}</span>
            </ReviewRow>
          </>
        ) : (
          <ReviewRow label={items.length === 1 ? 'Item' : 'Items'}>
            <ul className="space-y-1">
              {items.map(item => (
                <li key={item.id} className="break-words">
                  {item.name}
                  <span className="text-muted-foreground">
                    {' '}
                    · {item.kind === 'folder' ? 'Folder' : 'File'} in {place(item.parentName, item.parentId)}
                  </span>
                </li>
              ))}
            </ul>
          </ReviewRow>
        )}
        {change.kind === 'move' && (
          <ReviewRow label="Move to">
            <span className="break-words">{place(change.parentName, change.parentId)}</span>
          </ReviewRow>
        )}
      </ReviewRows>
      {accessChanges.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Moving changes who can open{' '}
          {accessChanges.length === 1 ? `“${accessChanges[0]!.name}”` : `${accessChanges.length} of these items`}, or
          something inside. People gain or lose access through the new folder’s sharing.
        </p>
      )}
      {change.kind === 'trash' && (
        <p className="text-xs text-muted-foreground">
          Items in Trash stay restorable. Folders take everything inside them to Trash too.
        </p>
      )}
      {change.kind === 'restore' && (
        <p className="text-xs text-muted-foreground">Items return to the folder they were in.</p>
      )}
      <Disclosure title="Technical details">
        <dl aria-label="Technical details" className="grid gap-2 text-xs text-muted-foreground">
          <TechnicalDetail term={items.length === 1 ? 'File ID' : 'File IDs'}>
            {items.map(item => item.id).join(', ')}
          </TechnicalDetail>
          <TechnicalDetail term="Draft ID">{id}</TechnicalDetail>
          <TechnicalDetail term="SHA-256">{draft.digest}</TechnicalDetail>
        </dl>
      </Disclosure>
      {checkStatus}
    </ReviewCard>
  );
}
