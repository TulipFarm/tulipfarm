import { createHash } from 'node:crypto';
import { createWorkflows } from '@tulipfarm/workflows';
import { normalizeCronExpression, type Definition, type Trigger, type Work } from '@tulipfarm/workflows/contracts';
import type { GitHubSubscriptions } from '@tulipfarm/workflows/github-triggers';
import { afterCommit } from '@tulipfarm/workspace-storage/runtime';
import type { HumanActor } from '@tulipfarm/access';
import { AgentError } from './saved-contracts.ts';
import { previewAgentTaskSchedule } from './schedules.ts';
import { unattendedTrigger, type AgentSetupTrigger } from './setup-contracts.ts';
import type { AgentStorage, AgentTransaction } from './store.ts';

export type AgentWorkflowOptions = {
  workflowWake?: ((work: Work) => Promise<void>) | undefined;
  githubSubscriptions?: GitHubSubscriptions | undefined;
};

/** A UUID derived from its parts, so a retried setup or migration finds the workflow it already made. */
export function derivedId(...parts: string[]) {
  const hash = createHash('sha256').update(parts.join(':')).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export const agentSetupWorkflowId = (commandId: string, triggerId: string) => derivedId(commandId, triggerId);

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function cronLabel(expression: string, timezone: string) {
  const zone = timezone.replaceAll('_', ' ');
  const match = /^(\d+) (\d+) \* \* (\*|1-5|[0-6])$/.exec(normalizeCronExpression(expression));
  if (!match) return `Cron ${expression} (${zone})`;
  const [, minute = '0', hour = '0', days = '*'] = match;
  const when = days === '*' ? 'Every day' : days === '1-5' ? 'Every weekday' : `Every ${weekdays[Number(days)]}`;
  return `${when} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')} (${zone})`;
}

function intervalLabel(minutes: number) {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'Every day' : `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

export function agentTriggerLabel(trigger: Trigger) {
  switch (trigger.kind) {
    case 'cron':
      return cronLabel(trigger.expression, trigger.timezone);
    case 'interval':
      return intervalLabel(trigger.minutes);
    case 'once':
      return `Once at ${trigger.at}`;
    case 'manual':
      return 'Run by hand';
    case 'webhook':
      return 'Webhook';
    case 'event':
      return `Event ${trigger.name}`;
    case 'github':
      return `GitHub ${trigger.event.replaceAll('_', ' ')}${trigger.actions ? ` ${trigger.actions.join(' or ')}` : ''}`;
    case 'provider':
      return `Source row ${trigger.event}`;
    case 'record':
      return 'Record date';
    case 'row':
      return `Row ${trigger.event}`;
    default: {
      const exhaustive: never = trigger;
      return exhaustive;
    }
  }
}

/** Kinds whose runs start from data the trigger carries; the agent receives that data with its prompt. */
const carriesData = (trigger: Trigger) => !['manual', 'once', 'interval', 'cron'].includes(trigger.kind);

/** An agent task runs at most hourly from a schedule, as it did when agents kept their own schedules. */
export function requireAgentTriggerCadence(trigger: Trigger) {
  if (trigger.kind === 'interval' || trigger.kind === 'cron') previewAgentTaskSchedule(trigger);
}

export function agentTriggerDefinition(
  agent: { id: string; name: string },
  selected: Pick<AgentSetupTrigger, 'trigger' | 'prompt' | 'limits'>,
  activationId?: string,
): Definition {
  const name = `${agent.name}: ${agentTriggerLabel(selected.trigger)}`;
  return {
    version: 1,
    name: name.length > 100 ? `${name.slice(0, 99)}…` : name,
    trigger: selected.trigger,
    steps: [
      {
        id: 'run_agent',
        kind: 'agent',
        agentId: agent.id,
        prompt: { kind: 'literal', value: selected.prompt },
        ...(carriesData(selected.trigger) ? { context: { kind: 'input' as const, path: [] } } : {}),
        ...(activationId ? { activationId } : {}),
        limits: selected.limits ?? { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
      },
    ],
  };
}

/**
 * Saves and activates one agent trigger workflow inside `tx`, so it commits or rolls back with the caller.
 * An unattended trigger runs as `actor`, who must have consented to sponsor it; only `actor` reads its history.
 */
export async function createAgentTriggerWorkflow(
  tx: AgentTransaction,
  storage: AgentStorage,
  workspaceId: string,
  actor: HumanActor,
  input: { id: string; agentId: string; definition: Definition; enabled: boolean },
  options: AgentWorkflowOptions,
) {
  if (input.definition.trigger.kind === 'github' && !options.githubSubscriptions)
    throw new AgentError('github-trigger-unavailable', 503);
  const wake = options.workflowWake;
  const workflows = createWorkflows(storage, {
    agentSteps: true,
    // A wake before commit could reach a run that rolls back, so it waits for the caller's commit.
    ...(wake
      ? { wake: (work: Work) => Promise.resolve(afterCommit(tx.client, () => void wake(work).catch(() => undefined))) }
      : {}),
    ...(options.githubSubscriptions ? { githubSubscriptions: options.githubSubscriptions } : {}),
  });
  let workflow = await workflows.save(
    workspaceId,
    actor.userId,
    input.id,
    { revision: derivedId(input.id, 'revision'), expectedRevision: null, definition: input.definition },
    { forAgentId: input.agentId },
  );
  if (!input.enabled) return workflow;
  if (unattendedTrigger(input.definition.trigger) && !workflow.sponsorshipAccepted)
    workflow = await workflows.sponsorship(workspaceId, actor.userId, input.id, {
      sponsorMembershipId: actor.membershipId,
      historyAudience: [actor.membershipId],
    });
  if (workflow.enabled && workflow.activeRevision === workflow.revision) return workflow;
  return workflows.activate(workspaceId, actor.userId, input.id, {
    commandId: derivedId(input.id, 'activate'),
    expectedGeneration: workflow.generation,
    revision: workflow.revision,
    enabled: true,
  });
}
