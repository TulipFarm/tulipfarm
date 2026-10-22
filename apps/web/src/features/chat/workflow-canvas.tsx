import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { BranchDown } from 'reicon-react/icons/BranchDown';
import { Button } from '@tulipfarm/sprout/button';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import {
  WorkflowDefinition,
  WorkflowRead,
  WorkflowRun,
  type WorkflowReference,
} from '@/features/workflows/workflow-detail';
import { NamedWorkflowViewer } from '@/features/workflows/named-viewer';
import { conversationApi } from './conversation-api';
import { useAuthoringDraft } from './queries';
import { useCanvas, type CanvasItem } from './canvas-state';
import { workspaceRoute } from '@/router';

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
          to="/$workspaceSlug/workflows"
          params={{ workspaceSlug: workspace.slug }}
          search={
            reference.kind === 'run'
              ? { workflow: reference.workflowId, run: reference.runId, view: 'runs' }
              : { workflow: reference.workflowId }
          }
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
        return (
          <NamedWorkflowViewer
            workspaceId={workspaceId}
            surface="canvas"
            view={{
              key: `draft:${chatId}:${draftId}:${draft.digest}`,
              definition: proposal.input.definition,
              source: 'Draft',
              revisionLabel: draft.status === 'pending' ? 'Awaiting your review' : `Draft ${draft.status}`,
              labels: {
                actor:
                  proposal.kind === 'workflow' && proposal.input.expectedRevision === null && proposal.input.activate
                    ? `${user.name} after approval`
                    : 'the person assigned when activated or started',
              },
              notice: notice ?? 'Review the diagram here. Saving and activation remain in the chat review card.',
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
}: {
  workspaceId: string;
  reference: WorkflowReference;
  name?: string;
}) {
  const { show } = useCanvas();
  const item = workflowCanvasItem(workspaceId, reference);
  return (
    <ResultCard
      title={name}
      kind="Workflow"
      apps={[]}
      icon={<BranchDown size={18} />}
      status={
        reference.kind === 'definition'
          ? 'Saved definition · Not a completed run'
          : reference.kind === 'draft'
            ? 'Draft · Not saved yet'
            : 'Run details available'
      }
      action={{ label: reference.kind === 'run' ? 'View run' : 'View workflow', onClick: () => show(item) }}
    />
  );
}
