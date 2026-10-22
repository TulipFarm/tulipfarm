import { Button } from '@tulipfarm/sprout/button';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { useWorkflowDefinition } from '@/features/workflows/queries';
import type { WorkflowReference } from '@/features/workflows/workflow-detail';

export type WorkflowHandoff =
  | null
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; retry: () => Promise<void> }
  | { kind: 'ready'; prompt: string; reference: Extract<WorkflowReference, { kind: 'definition' }> };
export function useWorkflowHandoff(
  workspaceId: string,
  requested: boolean,
  workflowId: string | null,
): WorkflowHandoff {
  const read = useWorkflowDefinition(workspaceId, requested ? workflowId : null);
  if (!requested) return null;
  if (!workflowId || read.state.kind === 'unavailable') return { kind: 'unavailable' };
  if (read.state.kind === 'loading') return { kind: 'loading' };
  if (read.state.kind === 'error' || read.state.error) return { kind: 'error', retry: read.refresh };
  const detail = read.state.data;
  if (!detail.canManage || detail.archived) return { kind: 'unavailable' };
  return {
    kind: 'ready',
    reference: { kind: 'definition', workflowId, revision: detail.revision },
    prompt: `Help me edit workflow "${detail.definition.name}" (workflow ID ${workflowId}, saved revision ${detail.revision}). Read its complete definition with workflows.read, ask what I want to change, and preserve all unrelated settings and steps. Prepare the change for my review; do not save or activate it without approval.`,
  };
}
export function WorkflowHandoffNotice({ handoff }: { handoff: WorkflowHandoff }) {
  if (!handoff || handoff.kind === 'ready') return null;
  if (handoff.kind === 'loading')
    return (
      <p role="status" className="text-sm">
        Checking workflow access before preparing your edit...
      </p>
    );
  return (
    <StatePanel
      kind={handoff.kind}
      title={handoff.kind === 'error' ? 'Workflow details did not load' : 'Workflow cannot be edited'}
      description={
        handoff.kind === 'error'
          ? 'Your edit request is kept in this link. Retry to load the exact saved revision.'
          : 'The workflow is archived, missing, or you no longer have permission to edit it. Your existing message is unchanged.'
      }
    >
      {handoff.kind === 'error' && (
        <Button variant="outline" onClick={() => void handoff.retry()}>
          Retry workflow details
        </Button>
      )}
    </StatePanel>
  );
}
