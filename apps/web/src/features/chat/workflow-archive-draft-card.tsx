import type { ReactNode, RefObject } from 'react';
import { Archive } from 'reicon-react/icons/Archive';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import { Disclosure } from '@/components/disclosure';
import { UnsavedChanges } from '@/features/tables/feedback';
import type { DraftView, WorkflowArchiveProposal } from '@tulipfarm/agents/draft-contracts';
import { TechnicalDetail } from './row-draft-card';

export function WorkflowArchiveDraftCard({
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
  proposal: WorkflowArchiveProposal;
  locked: boolean;
  sending: boolean;
  dirty: boolean;
  decide: (decision: 'save' | 'dismiss') => void;
  result: RefObject<HTMLDivElement | null>;
  feedback: ReactNode;
  checkStatus: ReactNode;
}) {
  const { workflows } = proposal.input;
  const count = workflows.length === 1 ? '1 workflow' : `${workflows.length} workflows`;
  return (
    <ReviewCard
      label="Review workflow archive"
      icon={<Archive size={16} />}
      title={workflows.length === 1 ? `Archive “${workflows[0]!.name}”` : `Archive ${count}`}
      badge={badges[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button variant="destructive" disabled={locked} aria-busy={sending} onClick={() => decide('save')}>
              {workflows.length === 1 ? 'Archive workflow' : `Archive ${count}`}
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
                  A workflow changed or was archived after this draft. Nothing was archived. Ask chat for a fresh draft.
                </p>
                {!draft.outcome && (
                  <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                    Dismiss draft
                  </Button>
                )}
              </div>
            )}
            {draft.status === 'failed' && <p role="status">The workflows could not be archived. Ask chat to retry.</p>}
            {draft.status === 'preparing' && <p role="status">Your approval is recorded. Archiving…</p>}
            {draft.status === 'saved' && (
              <p role="status">
                {workflows.length === 1 ? 'Workflow archived.' : `${count} archived.`} Their run history stays on the
                Workflows page under Archived.
              </p>
            )}
            {draft.status === 'dismissed' && <p role="status">Draft dismissed. Nothing was archived.</p>}
          </div>
          {feedback}
        </>
      }
    >
      <ReviewRows>
        {workflows.map(workflow => (
          <ReviewRow key={workflow.id} label="Workflow">
            <span className="break-words">{workflow.name}</span>
          </ReviewRow>
        ))}
      </ReviewRows>
      <p className="text-xs text-muted-foreground">
        Archiving stops each workflow&apos;s triggers and blocks its unfinished runs. Run history stays readable.
        Archived workflows cannot be restored yet.
      </p>
      <Disclosure title="Technical details">
        <dl aria-label="Technical details" className="grid gap-2 text-xs text-muted-foreground">
          {workflows.map(workflow => (
            <TechnicalDetail key={workflow.id} term={workflow.name}>
              {workflow.id} · Revision {workflow.revision}
            </TechnicalDetail>
          ))}
          <TechnicalDetail term="Draft ID">{id}</TechnicalDetail>
          <TechnicalDetail term="SHA-256">{draft.digest}</TechnicalDetail>
        </dl>
      </Disclosure>
      {checkStatus}
    </ReviewCard>
  );
}

const badges = {
  pending: { label: 'Needs approval', variant: 'warning' },
  preparing: { label: 'Archiving', variant: 'secondary' },
  saved: { label: 'Archived', variant: 'info' },
  dismissed: { label: 'Dismissed', variant: 'secondary' },
  stale: { label: 'Out of date', variant: 'warning' },
  failed: { label: 'Not archived', variant: 'destructive' },
} as const;
