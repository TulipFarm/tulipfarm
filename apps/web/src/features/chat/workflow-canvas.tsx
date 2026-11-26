import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { BranchIcon } from '@tulipfarm/icons';
import { Button } from '@tulipfarm/sprout/button';
import { ResultCard } from '@tulipfarm/sprout/result-card';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import type { WorkflowReference } from '@/features/workflows/workflow-detail';
import { conversationApi } from './conversation-api';
import { useAuthoringDraft } from './queries';
import { useCanvas, type CanvasItem } from './canvas-state';
import { workspaceRoute } from '@/router';

import { lazyCard } from '@/components/lazy-card';

const WorkflowDefinition = lazyCard(() =>
  import('@/features/workflows/workflow-detail').then(module => module.WorkflowDefinition),
);
const WorkflowRead = lazyCard(() => import('@/features/workflows/workflow-detail').then(module => module.WorkflowRead));
const WorkflowRun = lazyCard(() => import('@/features/workflows/workflow-detail').then(module => module.WorkflowRun));
const NamedWorkflowViewer = lazyCard(() =>
  import('@/features/workflows/named-viewer').then(module => module.NamedWorkflowViewer),
);

export function agentDraftCanvasItem(workspaceId: string, chatId: string, draftId: string): CanvasItem {
  return {
    id: `agent:draft:${chatId}:${draftId}`,
    title: 'Agent draft',
    content: { kind: 'agent-draft', workspaceId, chatId, draftId },
  };
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
        const canvasNotice = notice ?? null;
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
                : draft.status === 'saved'
                  ? 'Saved · Off'
                  : draft.status === 'pending'
                    ? 'Awaiting review'
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
                      `Help me revise the "${proposal.input.definition.name}" workflow in this chat. Ask what I want to change and keep unrelated steps.`,
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
        <BranchIcon size="md" aria-hidden="true" />
        {name}
      </Button>
    );
  return (
    <div className="w-full">
      <ResultCard
        title={name}
        kind="Workflow"
        apps={[]}
        icon={<BranchIcon size="lg" />}
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
