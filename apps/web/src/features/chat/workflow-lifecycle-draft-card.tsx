import type { ReactNode, RefObject } from 'react';
import { Archive } from 'reicon-react/icons/Archive';
import { ArchiveUp } from 'reicon-react/icons/ArchiveUp';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import { Disclosure } from '@/components/disclosure';
import { UnsavedChanges } from '@/features/tables/feedback';
import type { DraftView, WorkflowLifecycleProposal } from '@tulipfarm/agents/draft-contracts';
import { TechnicalDetail } from './row-draft-card';

const copy = {
  'workflow-archive': {
    label: 'Review workflow archive',
    verb: 'Archive',
    done: 'archived',
    doing: 'Archiving…',
    explanation:
      "Archiving stops each workflow's triggers and blocks its unfinished runs. Run history stays readable, and you can restore it later from Archived.",
    saved: 'Their run history stays on the Workflows page under Archived.',
  },
  'workflow-restore': {
    label: 'Review workflow restore',
    verb: 'Restore',
    done: 'restored',
    doing: 'Restoring…',
    explanation:
      'Restored workflows come back disabled, with their definition and run history. Activate one when it should run again; webhooks need a new key.',
    saved: 'They are disabled until you activate them.',
  },
} as const;

export function WorkflowLifecycleDraftCard({
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
  proposal: WorkflowLifecycleProposal;
  locked: boolean;
  sending: boolean;
  dirty: boolean;
  decide: (decision: 'save' | 'dismiss') => void;
  result: RefObject<HTMLDivElement | null>;
  feedback: ReactNode;
  checkStatus: ReactNode;
}) {
  const { workflows } = proposal.input;
  const text = copy[proposal.kind];
  const count = workflows.length === 1 ? '1 workflow' : `${workflows.length} workflows`;
  const badge = {
    pending: { label: 'Needs approval', variant: 'warning' },
    preparing: { label: text.doing.replace('…', ''), variant: 'secondary' },
    saved: { label: text.done[0]!.toUpperCase() + text.done.slice(1), variant: 'info' },
    dismissed: { label: 'Dismissed', variant: 'secondary' },
    stale: { label: 'Out of date', variant: 'warning' },
    failed: { label: `Not ${text.done}`, variant: 'destructive' },
  } as const;
  return (
    <ReviewCard
      label={text.label}
      icon={proposal.kind === 'workflow-archive' ? <Archive size={16} /> : <ArchiveUp size={16} />}
      title={workflows.length === 1 ? `${text.verb} “${workflows[0]!.name}”` : `${text.verb} ${count}`}
      badge={badge[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button
              variant={proposal.kind === 'workflow-archive' ? 'destructive' : 'default'}
              disabled={locked}
              aria-busy={sending}
              onClick={() => decide('save')}
            >
              {workflows.length === 1 ? `${text.verb} workflow` : `${text.verb} ${count}`}
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
                  A workflow changed after this draft. Nothing was {text.done}. Ask chat for a fresh draft.
                </p>
                {!draft.outcome && (
                  <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                    Dismiss draft
                  </Button>
                )}
              </div>
            )}
            {draft.status === 'failed' && (
              <p role="status">The workflows could not be {text.done}. Ask chat to retry.</p>
            )}
            {draft.status === 'preparing' && <p role="status">Your approval is recorded. {text.doing}</p>}
            {draft.status === 'saved' && (
              <p role="status">
                {workflows.length === 1 ? `Workflow ${text.done}.` : `${count} ${text.done}.`} {text.saved}
              </p>
            )}
            {draft.status === 'dismissed' && <p role="status">Draft dismissed. Nothing was {text.done}.</p>}
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
      <p className="text-xs text-muted-foreground">{text.explanation}</p>
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
