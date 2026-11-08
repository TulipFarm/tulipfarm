import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { z } from 'zod';
import { workflowSchema, type Trigger } from '@tulipfarm/workflows/contracts';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { Button } from '@tulipfarm/sprout/button';
import { FormSection } from '@tulipfarm/sprout/form';
import { StatePanel } from '@tulipfarm/sprout/state-panel';
import { Switch } from '@tulipfarm/sprout/switch';
import { useFeatureRead } from '@/lib/query';
import { workflowRequest, WorkflowRequestError } from '@/features/workflows/api';
import { describeGitHubTrigger, type GitHubNames } from '@/features/workflows/definition-description';
import { useGitHubNames, useRowTableNames, useWorkflowChanges, useWorkflows } from '@/features/workflows/queries';
import { liveTriggers, triggerLine } from '@/features/workflows/triggers';
import { TriggerIcon, WorkflowRow, workflowState } from '@/features/workflows/workflow-summary';
import { useAgentApi } from './queries';

type Workflow = z.infer<typeof workflowSchema>;

function triggerText(trigger: Trigger, names: GitHubNames, tableNames: ReadonlyMap<string, string>) {
  return trigger.kind === 'github' ? describeGitHubTrigger(trigger, names) : triggerLine(trigger, tableNames);
}

/** The agent's own workflow with a switch per trigger, and any older workflows still to be combined into it. */
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
  const api = useAgentApi(workspaceId);
  const linked = useFeatureRead({
    key: ['agents', 'linked-workflow', agentId],
    load: (signal: AbortSignal) => api.linkedWorkflow(agentId, signal),
  });
  const read = useWorkflows(workspaceId);
  const state = read.state;
  const workflows = state.kind === 'ready' ? state.data.filter(workflow => workflow.agentId === agentId) : [];
  const linkedId = linked.state.kind === 'ready' ? linked.state.data.workflowId : null;
  const own = workflows.find(workflow => workflow.id === linkedId && !workflow.archivedAt);
  const separate = workflows.filter(workflow => workflow.id !== linkedId && !workflow.archivedAt);
  const tableNames = useRowTableNames(workspaceId, workflows.flatMap(liveTriggers));
  const href = (workflowId: string) => `/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(workflowId)}`;
  const open = (workflowId: string) =>
    void navigate({ to: '/$workspaceSlug/workflows/$workflowId', params: { workspaceSlug: slug, workflowId } });
  const loading = state.kind === 'loading' || linked.state.kind === 'loading';
  const failed =
    state.kind === 'error' ||
    state.kind === 'unavailable' ||
    (state.kind === 'ready' && !!state.error) ||
    linked.state.kind === 'error' ||
    linked.state.kind === 'unavailable';
  const ready = !loading && !failed && state.kind === 'ready' && linked.state.kind === 'ready';
  return (
    <FormSection
      id="agent-trigger-workflows"
      title="Triggers"
      label="Agent triggers"
      description="Triggers start this agent on a schedule, from a webhook, or when a connected app changes."
    >
      {loading && <StatePanel kind="loading" title="Loading triggers" description="Finding this agent's workflow." />}
      {failed && (
        <StatePanel kind="error" title="Triggers could not load" description="The agent is unaffected.">
          <Button
            variant="outline"
            onClick={() => {
              void read.refresh();
              void linked.refresh();
            }}
          >
            Retry
          </Button>
        </StatePanel>
      )}
      {ready && !own && !separate.length && (
        <p className="text-sm text-muted-foreground">No triggers yet. Ask in chat to add one, such as a schedule.</p>
      )}
      {ready && own && (
        <div className="grid gap-3">
          <ul
            aria-label="This agent's workflow"
            className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
          >
            <li>
              <WorkflowRow
                workflow={own}
                state={workflowState(own)}
                href={href(own.id)}
                disabled={false}
                tableNames={tableNames}
                onOpen={() => open(own.id)}
              />
            </li>
          </ul>
          <LinkedTriggers workspaceId={workspaceId} workflow={own} />
        </div>
      )}
      {ready && separate.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium text-foreground">Combine on next setup</h3>
          <p className="text-sm text-muted-foreground">
            These workflows run this agent with different settings. The next setup you activate combines them into this
            agent&apos;s workflow.
          </p>
          <ul
            aria-label="Workflows to combine"
            className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
          >
            {separate.map(workflow => (
              <li key={workflow.id}>
                <WorkflowRow
                  workflow={workflow}
                  state={workflowState(workflow)}
                  href={href(workflow.id)}
                  disabled={false}
                  tableNames={tableNames}
                  onOpen={() => open(workflow.id)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </FormSection>
  );
}

function LinkedTriggers({ workspaceId, workflow }: { workspaceId: string; workflow: Workflow }) {
  const changes = useWorkflowChanges();
  const triggers = workflow.definition.triggers;
  const names = useGitHubNames(workspaceId, triggers);
  const tableNames = useRowTableNames(workspaceId, triggers);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const manage = workflow.capabilities.manage;
  if (!triggers.length) return <p className="text-sm text-muted-foreground">This workflow has no triggers.</p>;
  async function change(trigger: Trigger, enabled: boolean) {
    setPending(trigger.id);
    setMessage(null);
    const name = trigger.label ?? triggerText(trigger, names, tableNames);
    try {
      workflowSchema.parse(
        await workflowRequest(
          `/workspaces/${workspaceId}/workflows/${workflow.id}/triggers/${encodeURIComponent(trigger.id)}/switch`,
          'POST',
          { commandId: crypto.randomUUID(), expectedGeneration: workflow.generation, enabled },
        ),
      );
      setMessage({ kind: 'success', text: `${name} is ${enabled ? 'on' : 'off'}.` });
    } catch (error) {
      setMessage({
        kind: 'error',
        text:
          error instanceof WorkflowRequestError && error.status === 409
            ? 'This workflow changed. Check the triggers and try again.'
            : `${name} could not be switched ${enabled ? 'on' : 'off'}. Try again.`,
      });
    } finally {
      setPending(null);
      void changes.saved(workflow.id);
    }
  }
  return (
    <div className="grid gap-3">
      <ul aria-label="Triggers" className="divide-y divide-border rounded-xl border border-border bg-card">
        {triggers.map(trigger => {
          const view = workflow.triggers.find(item => item.id === trigger.id);
          const text = triggerText(trigger, names, tableNames);
          const name = trigger.label ?? text;
          const enabled = view?.enabled ?? false;
          return (
            <li key={trigger.id} className="flex items-center gap-3 px-4 py-3">
              <TriggerIcon trigger={trigger} />
              <div className="grid min-w-0 flex-1 gap-0.5 text-sm">
                <span className="truncate font-medium text-foreground">{name}</span>
                {trigger.label && <span className="truncate text-muted-foreground">{text}</span>}
                {!view && <span className="text-muted-foreground">Starts after the workflow is activated.</span>}
              </div>
              <Switch
                aria-label={`${name} on`}
                checked={enabled}
                disabled={!manage || !view || pending !== null}
                aria-busy={pending === trigger.id}
                onCheckedChange={checked => void change(trigger, checked)}
              />
            </li>
          );
        })}
      </ul>
      {!manage && (
        <p className="text-sm text-muted-foreground">Only people who manage this workflow can switch triggers.</p>
      )}
      {message && (
        <Alert
          variant={message.kind === 'error' ? 'destructive' : 'default'}
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
