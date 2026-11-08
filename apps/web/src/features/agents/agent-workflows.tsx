import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { FormSection } from '@tulipfarm/sprout/form';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { tableApi } from '@/features/tables/api';
import { useTableNames } from '@/features/tables/hooks';
import { useWorkflows } from '@/features/workflows/queries';
import { liveTrigger, WorkflowRow, workflowState } from '@/features/workflows/workflow-summary';

/** The workflows created for this agent, which are how it starts on a schedule or from an event. */
export function AgentTriggerWorkflows({
  agentId,
  workspaceId,
  slug,
}: {
  agentId: string;
  workspaceId: string;
  slug: string;
}) {
  const navigate = useNavigate();
  const read = useWorkflows(workspaceId);
  const state = read.state;
  const workflows = state.kind === 'ready' ? state.data.filter(workflow => workflow.agentId === agentId) : [];
  const tables = useMemo(() => tableApi(workspaceId), [workspaceId]);
  const tableNames = useTableNames(
    tables,
    workflows.some(workflow => liveTrigger(workflow).kind === 'row'),
  );
  const open = (workflowId: string) =>
    void navigate({ to: '/$workspaceSlug/workflows/$workflowId', params: { workspaceSlug: slug, workflowId } });
  return (
    <FormSection
      id="agent-trigger-workflows"
      title="Workflow triggers"
      label="Agent workflow triggers"
      description="Each workflow runs this agent on a schedule, from a webhook, or when a connected app changes."
    >
      {state.kind === 'loading' && (
        <StatePanel kind="loading" title="Loading workflow triggers" description="Finding this agent's workflows." />
      )}
      {(state.kind === 'error' || state.kind === 'unavailable' || (state.kind === 'ready' && state.error)) && (
        <StatePanel kind="error" title="Workflow triggers could not load" description="The agent is unaffected.">
          <Button variant="outline" onClick={() => void read.refresh()}>
            Retry loading workflow triggers
          </Button>
        </StatePanel>
      )}
      {state.kind === 'ready' && !state.error && workflows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No workflows run this agent yet. Ask in chat to add a trigger, such as a schedule or a new row.
        </p>
      )}
      {workflows.length > 0 && (
        <ul
          aria-label="Workflows that run this agent"
          className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
        >
          {workflows.map(workflow => (
            <li key={workflow.id}>
              <WorkflowRow
                workflow={workflow}
                state={workflowState(workflow)}
                href={`/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(workflow.id)}`}
                disabled={false}
                tableNames={tableNames}
                onOpen={() => open(workflow.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </FormSection>
  );
}
