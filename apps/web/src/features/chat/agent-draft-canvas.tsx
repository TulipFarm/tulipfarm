import { useCallback, useMemo, useState } from 'react';
import { Users } from 'reicon-react/icons/Users';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { CanvasSection } from '@tulipfarm/sprout/canvas';
import { workspaceRoute } from '@/router';
import { AgentBuilder } from '@/features/agents/builder';
import { continueChatDraft, useBuilderInitial } from '@/features/agents/builder-initial';
import { AgentRead } from '@/features/agents/feedback';
import { useAgentApi, useAgentPage } from '@/features/agents/queries';
import type { AgentContext } from '@/features/agents/api';
import { KeepsEditsContext, samePage } from '@/features/tables/feedback';
import { AuthoringDraftCard } from './authoring-draft-card';
import { conversationApi, type ConversationApi } from './conversation-api';
import { useCanvas } from './canvas-state';
import { agentDraftCanvasItem } from './workflow-canvas';
import { useAuthoringDraft, useConversationChanges } from './queries';

export function AgentDraftCanvas({
  workspaceId,
  chatId,
  draftId,
}: {
  workspaceId: string;
  chatId: string;
  draftId: string;
}) {
  const api = useMemo(() => conversationApi(workspaceId, () => {}), [workspaceId]);
  const read = useAuthoringDraft(api, chatId, draftId);
  const draft = read.state.kind === 'ready' ? read.state.data : null;
  const [builder, setBuilder] = useState<{ id: string; resume: boolean } | null>(null);
  const setup =
    draft &&
    !draft.replaced &&
    draft.status === 'pending' &&
    draft.proposal.kind === 'agent' &&
    draft.proposal.input.setup
      ? draft.proposal.targetId
      : null;
  const continued = draft?.outcome?.kind === 'builder' ? draft.outcome.agentId : null;
  // Once the builder opens it owns the edits; a later draft refresh must not swap it back to the review card.
  const opened = setup ? { id: setup, resume: false } : continued ? { id: continued, resume: true } : null;
  if (builder === null && opened) setBuilder(opened);
  return (
    <CanvasSection>
      {builder ? (
        <AgentDraftBuilder
          workspaceId={workspaceId}
          chatId={chatId}
          draftId={draftId}
          id={builder.id}
          resume={builder.resume}
        />
      ) : (
        <AuthoringDraftCard api={api} chatId={chatId} id={draftId} inCanvas />
      )}
    </CanvasSection>
  );
}

/**
 * The same builder as the New agent page. A pending chat setup draft fills it; its first save there records the chat
 * draft as continued, and later visits resume the builder's own saved setup. Saving here is never a chat approval.
 */
function AgentDraftBuilder({
  workspaceId,
  chatId,
  draftId,
  id,
  resume,
}: {
  workspaceId: string;
  chatId: string;
  draftId: string;
  id: string;
  resume: boolean;
}) {
  const { workspace, membershipId } = workspaceRoute.useRouteContext();
  const api = useAgentApi(workspaceId);
  const read = useAgentPage(api, id, true);
  const [handoff] = useState(resume ? null : { chatId, draftId });
  const initial = useBuilderInitial(api, workspaceId, id, resume, handoff);
  const changes = useConversationChanges();
  const refreshDraft = useCallback(() => changes.draft(chatId, draftId), [changes, chatId, draftId]);
  const [context, setContext] = useState<AgentContext | null>(null);
  if (read.state.kind === 'ready' && context !== read.state.data.context) setContext(read.state.data.context);
  return (
    <KeepsEditsContext value={samePage}>
      <div className="grid min-w-0 gap-4">
        <AgentRead state={read.state} refresh={read.refresh}>
          {() => null}
        </AgentRead>
        <AgentRead state={initial.state} refresh={initial.refresh}>
          {() => null}
        </AgentRead>
        {context && membershipId && initial.state.kind === 'ready' && (
          <AgentBuilder
            api={api}
            workspaceId={workspaceId}
            slug={workspace.slug}
            id={id}
            membershipId={membershipId}
            context={context}
            initial={initial.state.data}
            concealed={read.state.kind !== 'ready'}
            refresh={read.refresh}
            onPersisted={() => {
              if (handoff)
                void continueChatDraft(workspaceId, handoff)
                  .then(refreshDraft)
                  .catch(() => {});
            }}
            onSettled={refreshDraft}
            compact
          />
        )}
      </div>
    </KeepsEditsContext>
  );
}

const statuses: Record<string, string> = {
  pending: 'Draft · Waiting for your review',
  preparing: 'Saving…',
  saved: 'Saved',
  dismissed: 'Dismissed',
  stale: 'Out of date',
  failed: 'Not saved',
  continued: 'Continued in the agent builder',
};

/** The chat's pointer to an agent draft; the full review and its buttons live in the canvas. */
export function AgentDraftLink({
  api,
  workspaceId,
  chatId,
  id,
}: {
  api: ConversationApi;
  workspaceId: string;
  chatId: string;
  id: string;
}) {
  const { show } = useCanvas();
  const read = useAuthoringDraft(api, chatId, id);
  const draft = read.state.kind === 'ready' ? read.state.data : null;
  const name =
    draft && !draft.replaced && draft.proposal.kind === 'agent' ? draft.proposal.input.definition.name : 'Agent draft';
  const status =
    read.state.kind === 'loading'
      ? 'Loading draft…'
      : read.state.kind === 'error'
        ? 'Could not load draft'
        : read.state.kind === 'unavailable'
          ? 'Draft unavailable'
          : draft?.replaced
            ? 'Replaced by a newer draft'
            : draft?.outcome?.kind === 'builder' && draft.outcome.setupReceipt?.status === 'active'
              ? 'Active'
              : draft?.outcome?.kind === 'builder' && draft.status === 'saved'
                ? 'Saved in the agent builder · Not active yet'
                : draft?.outcome?.kind === 'agent' && draft.outcome.setupReceipt?.status === 'blocked'
                  ? 'Saved · Setup incomplete'
                  : (statuses[draft?.status ?? ''] ?? 'Draft');
  // A new agent exists only once its definition is saved, so a failed first save has no agent to view.
  const outcome = draft?.outcome?.kind === 'agent' ? draft.outcome : null;
  const noAgent =
    !!outcome &&
    (outcome.setupReceipt?.status ?? outcome.receipt.status) === 'failed' &&
    draft?.proposal.kind === 'agent' &&
    draft.proposal.input.expectedSavedRevision === null;
  return (
    <div className="w-full">
      <ResultCard
        title={name}
        kind="Agent"
        apps={[]}
        icon={<Users size={18} />}
        status={status}
        action={
          noAgent
            ? undefined
            : {
                label:
                  draft?.status === 'pending'
                    ? 'Review agent'
                    : draft?.outcome?.kind === 'builder'
                      ? 'Edit agent'
                      : 'View agent',
                onClick: () => show(agentDraftCanvasItem(workspaceId, chatId, id)),
              }
        }
      />
    </div>
  );
}
