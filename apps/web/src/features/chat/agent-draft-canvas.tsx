import { useMemo } from 'react';
import { Users } from 'reicon-react/icons/Users';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { CanvasSection } from '@tulipfarm/sprout/canvas';
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
  return (
    <CanvasSection>
      <AuthoringDraftCard api={api} chatId={chatId} id={draftId} inCanvas />
    </CanvasSection>
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
