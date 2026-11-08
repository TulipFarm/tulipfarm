import { useMemo, useState } from 'react';
import { Users } from 'reicon-react/icons/Users';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { CanvasSection } from '@tulipfarm/sprout/canvas';
import { workspaceRoute } from '@/router';
import { AgentBuilder } from '@/features/agents/builder';
import { useBuilderInitial } from '@/features/agents/builder-initial';
import { AgentRead } from '@/features/agents/feedback';
import { useAgentApi, useAgentPage } from '@/features/agents/queries';
import type { AgentContext } from '@/features/agents/api';
import { KeepsEditsContext, samePage } from '@/features/tables/feedback';
import { AuthoringDraftCard } from './authoring-draft-card';
import { conversationApi, type ConversationApi } from './conversation-api';
import { useCanvas, type CanvasItem } from './canvas-state';
import { useAuthoringDraft } from './queries';

export function agentDraftCanvasItem(workspaceId: string, chatId: string, draftId: string): CanvasItem {
  return {
    id: `agent:draft:${chatId}:${draftId}`,
    title: 'Agent draft',
    content: { kind: 'agent-draft', workspaceId, chatId, draftId },
  };
}

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
  const [builderId, setBuilderId] = useState<string | null>(null);
  const setup =
    draft &&
    !draft.replaced &&
    draft.status === 'pending' &&
    draft.proposal.kind === 'agent' &&
    draft.proposal.input.setup
      ? draft.proposal.targetId
      : null;
  // Once the builder opens it owns the edits; a later draft refresh must not swap it back to the review card.
  if (setup && builderId === null) setBuilderId(setup);
  const id = builderId ?? setup;
  return (
    <CanvasSection>
      {id ? (
        <AgentDraftBuilder workspaceId={workspaceId} chatId={chatId} draftId={draftId} id={id} />
      ) : (
        <AuthoringDraftCard api={api} chatId={chatId} id={draftId} inCanvas />
      )}
    </CanvasSection>
  );
}

/** The same builder as the New agent page, filled from the chat's setup draft. Saving here is the builder's own save, not a chat approval. */
function AgentDraftBuilder({
  workspaceId,
  chatId,
  draftId,
  id,
}: {
  workspaceId: string;
  chatId: string;
  draftId: string;
  id: string;
}) {
  const { workspace, membershipId } = workspaceRoute.useRouteContext();
  const api = useAgentApi(workspaceId);
  const read = useAgentPage(api, id, true);
  const [handoff] = useState({ chatId, draftId });
  const initial = useBuilderInitial(api, workspaceId, id, false, handoff);
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
            onPersisted={() => {}}
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
            : (statuses[draft?.status ?? ''] ?? 'Draft');
  return (
    <div className="w-full">
      <ResultCard
        title={name}
        kind="Agent"
        apps={[]}
        icon={<Users size={18} />}
        status={status}
        action={{
          label: draft?.status === 'pending' ? 'Review agent' : 'View agent',
          onClick: () => show(agentDraftCanvasItem(workspaceId, chatId, id)),
        }}
      />
    </div>
  );
}
