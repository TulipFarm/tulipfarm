import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import type { DraftOutcome } from '@tulipfarm/agents/draft-contracts';
import { workflowSchema } from '@tulipfarm/workflows/contracts';
import { workflowRequest, WorkflowRequestError } from '@/features/workflows/api';
import { useWorkflows, useWorkflowChanges } from '@/features/workflows/queries';
import { activationFailureMessage, workflowLiveMessage } from '@/features/workflows/activation-feedback';
import { workspaceRoute } from '@/router';

export function WorkflowSavedActions({
  outcome,
  activateOnSave,
  onActive,
}: {
  outcome: Extract<DraftOutcome, { kind: 'workflow' }>;
  activateOnSave: boolean;
  onActive: (active: boolean) => void;
}) {
  const { workspace } = workspaceRoute.useRouteContext();
  const read = useWorkflows(workspace.id);
  const changes = useWorkflowChanges();
  const workflow = read.state.kind === 'ready' ? read.state.data.find(item => item.id === outcome.workflowId) : null;
  const [busy, setBusy] = useState(false),
    [automatic, setAutomatic] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const attempted = useRef(false);
  const command = useRef<{ commandId: string; expectedGeneration: number; revision: string; enabled: true } | null>(
    null,
  );
  const active = !!workflow?.enabled && workflow.activeRevision === outcome.revision;
  const reason = !workflow
    ? read.state.kind === 'loading'
      ? 'Loading workflow...'
      : read.state.kind === 'unavailable' || read.state.kind === 'ready'
        ? 'Your access changed. Open the workflow to check your access.'
        : "TulipFarm couldn't confirm whether the workflow is active. Open the workflow to check."
    : workflow.revision !== outcome.revision
      ? 'A newer revision of this workflow was saved. Open the workflow to review it before activating.'
      : !workflow.capabilities.manage
        ? 'Workflow saved. Ask a workflow manager to activate it.'
        : null;

  async function activate(auto = false) {
    if (!workflow || reason || busy) return;
    setBusy(true);
    setAutomatic(auto);
    setError('');
    command.current ??= {
      commandId: crypto.randomUUID(),
      expectedGeneration: workflow.generation,
      revision: outcome.revision,
      enabled: true,
    };
    try {
      const result = workflowSchema.parse(
        await workflowRequest(
          `/workspaces/${workspace.id}/workflows/${workflow.id}/activation`,
          'POST',
          command.current,
        ),
      );
      await changes.saved(workflow.id);
      onActive(true);
      setMessage(workflowLiveMessage(result));
      command.current = null;
    } catch (failure) {
      setError(activationFailureMessage(failure, workflow, 'card'));
      if (failure instanceof WorkflowRequestError && failure.status < 500 && ![408, 429].includes(failure.status)) {
        command.current = null;
        await read.refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (workflow && outcome.activation !== 'activated') onActive(active);
    if (
      activateOnSave &&
      workflow &&
      !reason &&
      !attempted.current &&
      read.state.kind === 'ready' &&
      !read.state.error &&
      !read.state.refreshing
    ) {
      attempted.current = true;
      if (!active) void activate(true);
    }
  }, [workflow, activateOnSave, active, reason, onActive, read.state]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {!active && (
          <Button
            pendingLabel={automatic ? 'Saving and activating...' : 'Activating workflow...'}
            state={busy ? { kind: 'busy' } : reason ? { kind: 'blocked', reason } : { kind: 'ready' }}
            onClick={() => void activate()}
          >
            Activate workflow
          </Button>
        )}
        <Button
          variant="outline"
          nativeButton={false}
          render={
            <Link
              to="/$workspaceSlug/workflows/$workflowId"
              params={{ workspaceSlug: workspace.slug, workflowId: outcome.workflowId }}
            />
          }
        >
          Open workflow
        </Button>
        {active && workflow?.capabilities.invoke && (
          <Button
            variant="outline"
            nativeButton={false}
            render={
              <Link
                to="/$workspaceSlug/workflows/$workflowId"
                params={{ workspaceSlug: workspace.slug, workflowId: outcome.workflowId }}
                search={{ view: 'runs', start: true }}
              />
            }
          >
            Start a run
          </Button>
        )}
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {error && (
        <p role="status" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
