import type { ReactNode, RefObject } from 'react';
import { Archive } from 'reicon-react/icons/Archive';
import { ArchiveUp } from 'reicon-react/icons/ArchiveUp';
import { ReviewCard, ReviewRow, ReviewRows } from '@tulipfarm/sprout/review-card';
import { Button } from '@tulipfarm/sprout/button';
import { Disclosure } from '@/components/disclosure';
import { UnsavedChanges } from '@/features/tables/feedback';
import type {
  DefinitionLifecycleProposal,
  DraftView,
  WorkflowLifecycleProposal,
} from '@tulipfarm/agents/draft-contracts';
import { TechnicalDetail } from './row-draft-card';

const copy = {
  'workflow-archive': {
    noun: 'workflow',
    label: 'Review workflow archive',
    verb: 'Archive',
    done: 'archived',
    doing: 'Archiving…',
    explanation:
      "Archiving stops each workflow's triggers and blocks its unfinished runs. Run history stays readable, and you can restore it later from Archived.",
    saved: 'Their run history stays on the Workflows page under Archived.',
  },
  'workflow-restore': {
    noun: 'workflow',
    label: 'Review workflow restore',
    verb: 'Restore',
    done: 'restored',
    doing: 'Restoring…',
    explanation:
      'Restored workflows come back disabled, with their definition and run history. Activate one when it should run again; webhooks need a new key.',
    saved: 'They are disabled until you activate them.',
  },
  'agent-archive': {
    noun: 'agent',
    label: 'Review agent archive',
    verb: 'Archive',
    done: 'archived',
    doing: 'Archiving…',
    explanation:
      'Archiving hides each agent, turns it off and ends its activations and schedules. Its team, sharing and history stay, and you can restore it later from Archived.',
    saved: 'Find them on the Agents page under Archived.',
  },
  'agent-restore': {
    noun: 'agent',
    label: 'Review agent restore',
    verb: 'Restore',
    done: 'restored',
    doing: 'Restoring…',
    explanation:
      'Restored agents come back turned off, with their team, sharing and history. A manager turns one on and activates it when it should run again.',
    saved: 'They stay off until a manager turns them on and activates them.',
  },
  'skill-archive': {
    noun: 'skill',
    label: 'Review skill archive',
    verb: 'Archive',
    done: 'archived',
    doing: 'Archiving…',
    explanation:
      'Archived skills leave the skill list and cannot be added to more agents. Agents already using them keep working, and you can restore them later.',
    saved: 'Find them on the Skills page under Archived.',
  },
  'skill-restore': {
    noun: 'skill',
    label: 'Review skill restore',
    verb: 'Restore',
    done: 'restored',
    doing: 'Restoring…',
    explanation: 'Restored skills return to the skill list as they were when archived.',
    saved: 'They are back in the skill list.',
  },
} as const;

type LifecycleProposal = WorkflowLifecycleProposal | DefinitionLifecycleProposal;
function itemsOf(proposal: LifecycleProposal) {
  switch (proposal.kind) {
    case 'workflow-archive':
    case 'workflow-restore':
      return proposal.input.workflows.map(item => ({ ...item, detail: `Revision ${item.revision}` }));
    case 'agent-archive':
    case 'agent-restore':
      return proposal.input.agents.map(item => ({ ...item, detail: null }));
    case 'skill-archive':
    case 'skill-restore':
      return proposal.input.skills.map(item => ({ ...item, detail: `Version ${item.version}` }));
  }
}

export function LifecycleDraftCard({
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
  proposal: LifecycleProposal;
  locked: boolean;
  sending: boolean;
  dirty: boolean;
  decide: (decision: 'save' | 'dismiss') => void;
  result: RefObject<HTMLDivElement | null>;
  feedback: ReactNode;
  checkStatus: ReactNode;
}) {
  const items = itemsOf(proposal);
  const text = copy[proposal.kind];
  const archiving = text.verb === 'Archive';
  const noun = text.noun;
  const Noun = noun[0]!.toUpperCase() + noun.slice(1);
  const count = items.length === 1 ? `1 ${noun}` : `${items.length} ${noun}s`;
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
      icon={archiving ? <Archive size={16} /> : <ArchiveUp size={16} />}
      title={items.length === 1 ? `${text.verb} “${items[0]!.name}”` : `${text.verb} ${count}`}
      badge={badge[draft.status]}
      settled={draft.status === 'saved' || draft.status === 'dismissed' || draft.status === 'failed'}
      actions={
        draft.status === 'pending' ? (
          <>
            <Button
              variant={archiving ? 'destructive' : 'default'}
              disabled={locked}
              aria-busy={sending}
              onClick={() => decide('save')}
            >
              {items.length === 1 ? `${text.verb} ${noun}` : `${text.verb} ${count}`}
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
                  A {noun} changed after this draft. Nothing was {text.done}. Ask chat for a fresh draft.
                </p>
                {!draft.outcome && (
                  <Button variant="ghost" disabled={locked} onClick={() => decide('dismiss')}>
                    Dismiss draft
                  </Button>
                )}
              </div>
            )}
            {draft.status === 'failed' && (
              <p role="status">
                The {noun}s could not be {text.done}. Ask chat to retry.
              </p>
            )}
            {draft.status === 'preparing' && <p role="status">Your approval is recorded. {text.doing}</p>}
            {draft.status === 'saved' && (
              <p role="status">
                {items.length === 1 ? `${Noun} ${text.done}.` : `${count} ${text.done}.`} {text.saved}
              </p>
            )}
            {draft.status === 'dismissed' && <p role="status">Draft dismissed. Nothing was {text.done}.</p>}
          </div>
          {feedback}
        </>
      }
    >
      <ReviewRows>
        {items.map(item => (
          <ReviewRow key={item.id} label={Noun}>
            <span className="break-words">{item.name}</span>
          </ReviewRow>
        ))}
      </ReviewRows>
      <p className="text-xs text-muted-foreground">{text.explanation}</p>
      <Disclosure title="Technical details">
        <dl aria-label="Technical details" className="grid gap-2 text-xs text-muted-foreground">
          {items.map(item => (
            <TechnicalDetail key={item.id} term={item.name}>
              {item.detail ? `${item.id} · ${item.detail}` : item.id}
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
