import type { z } from 'zod';
import type { workflowSchema } from '@tulipfarm/workflows/contracts';
import { WorkflowRequestError } from './api';

type Workflow = z.infer<typeof workflowSchema>;

export function workflowLiveMessage(workflow: Workflow) {
  const triggers = workflow.activeTriggers ?? workflow.definition.triggers;
  const enabled = triggers.filter(
    trigger => workflow.triggers.find(state => state.id === trigger.id)?.enabled !== false,
  );
  if (
    enabled.some(
      trigger =>
        trigger.kind === 'webhook' && !workflow.triggers.find(state => state.id === trigger.id)?.webhook?.configured,
    )
  )
    return `${workflow.definition.name} is active. Set up a webhook key so the webhook can start runs.`;
  const count = enabled.filter(
    trigger =>
      !(trigger.kind === 'event' && trigger.name === 'manual') &&
      !(trigger.kind === 'once' && !workflow.triggers.find(state => state.id === trigger.id)?.nextRunAt),
  ).length;
  if (count)
    return new Intl.PluralRules().select(count) === 'one'
      ? `${workflow.definition.name} is active with 1 trigger.`
      : `${workflow.definition.name} is active with ${count} triggers.`;
  return `${workflow.definition.name} is active.${workflow.capabilities.invoke ? ' You can start a run now.' : ''}`;
}

export function activationFailureMessage(error: unknown, workflow: Workflow, surface: 'editor' | 'card') {
  const reasons: Record<string, string> = {
    'sponsorship-required': 'The sponsor must accept this revision before it can be activated.',
    'sponsor-required': 'Another member sponsors this workflow. Ask them to accept this revision before activating.',
    'sponsor-access-lost':
      'The sponsor can no longer run this workflow. Open Settings to choose another sponsor or restore their access.',
    'audience-required':
      'Someone who sees its run history cannot read the table. Change who sees run history, then activate it.',
    'stale-generation': 'This workflow changed. Open the workflow to review its current state before activating.',
    'stale-revision': 'A newer revision of this workflow was saved. Open the workflow to review it before activating.',
    'code-steps-unavailable': 'Code steps cannot run until an execution backend is configured.',
    'workflow-archived': 'This workflow is archived. Restore it before activating.',
  };
  const reason =
    error instanceof WorkflowRequestError && error.status < 500
      ? error.status === 401 || error.status === 403 || error.status === 404
        ? 'Your access changed. Open the workflow to check your access.'
        : reasons[error.code]
      : "TulipFarm couldn't confirm whether the workflow is active. Open the workflow to check.";
  const label = workflow.enabled ? 'Activate saved revision' : 'Activate workflow';
  return `${surface === 'editor' ? 'Revision' : 'Workflow'} saved, but not activated. ${reason ?? (surface === 'editor' ? `Try ${label} again.` : 'Try again, or open the workflow to check its status.')}${workflow.enabled && workflow.activeRevision ? ' Runs still use the active revision.' : ''}`;
}
