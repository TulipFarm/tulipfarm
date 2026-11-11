import type { WorkflowProposal } from '@tulipfarm/agents/draft-contracts';
import { WorkflowStepOutline } from '@/components/workflow-diagram';
import { workflowGraph } from '@/features/workflows/diagram-model';
import { useWorkflowLabels } from '@/features/workflows/named-viewer';

/** The draft's trigger and steps with their app and language logos, so the card shows what will run without opening Canvas. */
export function WorkflowDraftPreview({
  workspaceId,
  definition,
}: {
  workspaceId: string;
  definition: WorkflowProposal['input']['definition'];
}) {
  const { labels } = useWorkflowLabels(workspaceId, definition);
  return <WorkflowStepOutline nodes={workflowGraph(definition, { ...labels, actor: 'you' }).nodes} />;
}
