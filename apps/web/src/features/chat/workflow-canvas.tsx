import { useEffect, useMemo, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { Button } from '@tulipfarm/sprout/button';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { WorkflowReference } from '@/features/workflows/workflow-detail';
import { conversationApi, type ConversationMessage } from './conversation-api';
import { succeeded } from './live-tools';
import { useAuthoringDraft } from './queries';
import { useCanvas, type CanvasItem } from './canvas-state';
import { agentDraftCanvasItem } from './agent-draft-canvas';
import { workspaceRoute } from '@/router';

import { lazyCard } from '@/components/lazy-card';

const WorkflowDefinition = lazyCard(() => import('@/features/workflows/workflow-detail').then(module => module.WorkflowDefinition));
const WorkflowRead = lazyCard(() => import('@/features/workflows/workflow-detail').then(module => module.WorkflowRead));
const WorkflowRun = lazyCard(() => import('@/features/workflows/workflow-detail').then(module => module.WorkflowRun));
const NamedWorkflowViewer = lazyCard(() => import('@/features/workflows/named-viewer').then(module => module.NamedWorkflowViewer));

// Opens a workflow or agent draft made while this chat is open; drafts already in the chat when it loads stay closed.
export function NewChatDrafts({
  workspaceId,
  chatId,
  tools,
  foreground,
}: {
  workspaceId: string;
  chatId: string;
  tools: ConversationMessage['tools'];
  foreground: boolean;
}) {
  const canvas = useCanvas();
  const observed = useRef<{ chatId: string; ids: Set<string> } | null>(null);
  const drafts = tools.filter(
    tool => (tool.tool === 'workflows.draft' || tool.tool === 'agents.draft') && succeeded(tool),
  );
  const ids = drafts.map(tool => tool.id);
  const key = ids.join(',');
  useEffect(() => {
    const previous = observed.current;
    if (!previous || previous.chatId !== chatId) {
      observed.current = { chatId, ids: new Set(ids) };
      return;
    }
    const added = drafts.filter(tool => !previous.ids.has(tool.id)).at(-1);
    for (const id of ids) previous.ids.add(id);
    if (
      added &&
      foreground &&
      (!canvas.activeId ||
        canvas.activeId.startsWith(`workflow:draft:${chatId}:`) ||
        canvas.activeId.startsWith(`agent:draft:${chatId}:`)) &&
      window.matchMedia('(min-width: 768px)').matches
    )
      canvas.show(
        added.tool === 'agents.draft'
          ? agentDraftCanvasItem(workspaceId, chatId, added.id)
          : workflowCanvasItem(workspaceId, { kind: 'draft', chatId, draftId: added.id }),
      );
  }, [key, chatId, workspaceId, foreground, canvas.activeId, canvas.show]);
  return null;
}

export function workflowCanvasItem(workspaceId: string, reference: WorkflowReference): CanvasItem {
  const key =
    reference.kind === 'draft'
      ? `${reference.chatId}:${reference.draftId}`
      : reference.kind === 'run'
        ? `${reference.workflowId}:${reference.runId}`
        : `${reference.workflowId}:${reference.revision}`;
  return {
    id: `workflow:${reference.kind}:${key}`,
    title: reference.kind === 'draft' ? 'Workflow draft' : reference.kind === 'run' ? 'Workflow run' : 'Workflow',
    content: { kind: 'workflow', workspaceId, reference },
  };
}
export function WorkflowCanvas({ workspaceId, reference }: { workspaceId: string; reference: WorkflowReference }) {
  const { workspace } = workspaceRoute.useRouteContext();
  if (reference.kind === 'draft')
    return <WorkflowDraftCanvas workspaceId={workspaceId} chatId={reference.chatId} draftId={reference.draftId} />;
  const navigation = (
    <Button
      variant="ghost"
      size="sm"
      nativeButton={false}
      render={
        <Link
          to="/$workspaceSlug/workflows/$workflowId"
          params={{ workspaceSlug: workspace.slug, workflowId: reference.workflowId }}
          search={reference.kind === 'run' ? { run: reference.runId, view: 'runs' } : {}}
        />
      }
    >
      {reference.kind === 'run' ? 'Open run in Workflows' : 'Open current workflow'}
    </Button>
  );
  return reference.kind === 'run' ? (
    <WorkflowRun
      workspaceId={workspaceId}
      workflowId={reference.workflowId}
      runId={reference.runId}
      surface="canvas"
      navigation={navigation}
    />
  ) : (
    <WorkflowDefinition
      workspaceId={workspaceId}
      workflowId={reference.workflowId}
      revision={reference.revision}
      surface="canvas"
      navigation={navigation}
    />
  );
}
function WorkflowDraftCanvas({
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
  const { requestComposer } = useCanvas();
  const { user } = workspaceRoute.useRouteContext();
  return (
    <WorkflowRead state={read.state} refresh={read.refresh}>
      {(draft, notice) => {
        if (draft.proposal.kind !== 'workflow' && draft.proposal.kind !== 'workflow-activation')
          return (
            <StatePanel
              kind="unavailable"
              title="Workflow draft unavailable"
              description="This draft does not contain a workflow."
            />
          );
        const proposal = draft.proposal;
        const active =
          draft.status === 'saved' && draft.outcome?.kind === 'workflow' && draft.outcome.activation === 'activated';
        const canvasNotice =
          notice ??
          (active
            ? 'This workflow is saved and active. It runs when its trigger fires.'
            : draft.status === 'pending'
              ? 'Review the diagram here. Saving and activation remain in the chat review card.'
              : null);
        return (
          <NamedWorkflowViewer
            workspaceId={workspaceId}
            surface="canvas"
            view={{
              key: `draft:${chatId}:${draftId}:${draft.digest}`,
              definition: proposal.input.definition,
              source: active ? 'Active' : draft.status === 'saved' ? 'Saved' : 'Draft',
              revisionLabel: active
                ? 'Saved and active'
                : draft.status === 'pending'
                  ? 'Awaiting your review'
                  : `Draft ${draft.status}`,
              labels: {
                actor:
                  proposal.kind === 'workflow' && proposal.input.expectedRevision === null && proposal.input.activate
                    ? `${user.name} after approval`
                    : 'the person assigned when activated or started',
              },
              ...(canvasNotice ? { notice: canvasNotice } : {}),
            }}
            onRefresh={() => void read.refresh()}
            onEdit={
              draft.status === 'pending'
                ? () =>
                    requestComposer(
                      `Help me revise workflow draft ${draftId} in this chat. Ask what I want to change, keep unrelated steps, and prepare a fresh draft for review.`,
                    )
                : undefined
            }
          />
        );
      }}
    </WorkflowRead>
  );
}
export function WorkflowCanvasButton({
  workspaceId,
  reference,
  name = 'View workflow',
  status,
  compact = false,
}: {
  workspaceId: string;
  reference: WorkflowReference;
  name?: string;
  status?: string;
  /** A plain button for cards that already show the steps. */
  compact?: boolean;
}) {
  const { show } = useCanvas();
  const item = workflowCanvasItem(workspaceId, reference);
  if (compact)
    return (
      <Button size="sm" variant="outline" onClick={() => show(item)}>
        <BranchDown size={16} aria-hidden="true" />
        {name}
      </Button>
    );
  return (
    <div className="w-full">
      <ResultCard
        title={name}
        kind="Workflow"
        apps={[]}
        icon={<BranchDown size={18} />}
        status={
          status ??
          (reference.kind === 'definition'
            ? 'Saved definition · Not a completed run'
            : reference.kind === 'draft'
              ? 'Draft · Not saved yet'
              : 'Run details available')
        }
        action={{ label: reference.kind === 'run' ? 'View run' : 'View workflow', onClick: () => show(item) }}
      />
    </div>
  );
}
