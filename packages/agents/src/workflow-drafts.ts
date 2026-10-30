import { CronExpressionParser } from 'cron-parser';
import { AccessDenied, type HumanActor } from '@tulipfarm/access';
import { createWorkflows, WorkflowConflict, workflowCodeStepsEnabled } from '@tulipfarm/workflows';
import type { z } from 'zod';
import type {
  Definition,
  DefinitionView,
  RecordFilter,
  Work,
  workflowSchema,
  providerIntegrationSchema,
} from '@tulipfarm/workflows/contracts';
import type { GitHubSubscriptions } from '@tulipfarm/workflows/github-triggers';
import type { AgentStorage } from './store.ts';
import type { DraftOutcome, WorkflowProposal } from './draft-contracts.ts';

type Trigger = Definition['trigger'];
type Workflow = z.infer<typeof workflowSchema>;
type DraftProblem = { error: string; instruction: string };
type FilterLabels = { field: string; match: RecordFilter['match']; value: string | null };
export type RecordSourceLabels = { table: string; field: string; filter: FilterLabels | null };
export type RowSourceLabels = { table: string; fields: string[]; filter: FilterLabels | null };
export type TableStepSourceLabels = { id: string; table: string; fields: Record<string, string> };
export type WorkflowDrafts = {
  list(actor: HumanActor): Promise<Workflow[]>;
  read(actor: HumanActor, id: string): Promise<DefinitionView>;
  providers(actor: HumanActor): Promise<z.infer<typeof providerIntegrationSchema>[]>;
  githubRepositories(actor: HumanActor): Promise<{ repositoryId: string; fullName: string }[]>;
  problem(actor: HumanActor, definition: Definition): Promise<DraftProblem | null>;
  sourceProblem(actor: HumanActor, trigger: Trigger): Promise<DraftProblem | null>;
  recordSource(
    actor: HumanActor,
    trigger: Extract<Trigger, { kind: 'record' }>,
  ): Promise<RecordSourceLabels | DraftProblem>;
  rowSource(actor: HumanActor, trigger: Extract<Trigger, { kind: 'row' }>): Promise<RowSourceLabels | DraftProblem>;
  tableStepSources(actor: HumanActor, definition: Definition): Promise<TableStepSourceLabels[] | DraftProblem>;
  find(actor: HumanActor, id: string): Promise<Workflow | null>;
  writable(actor: HumanActor, proposal: WorkflowProposal): Promise<void>;
  stale(actor: HumanActor, proposal: WorkflowProposal): Promise<boolean>;
  apply(actor: HumanActor, draftId: string, commandId: string, proposal: WorkflowProposal): Promise<DraftOutcome>;
};
const unattended = (trigger: Trigger) => !['manual', 'event'].includes(trigger.kind);
const githubProblems: Record<string, DraftProblem> = {
  'github-repository-not-connected': {
    error: 'github-repository-not-connected',
    instruction:
      'This GitHub repository is not connected to your GitHub Knowledge. Ask the human to connect it in the GitHub Knowledge picker, then draft again. Never ask for GitHub tokens or secrets in chat.',
  },
};
const recordProblems: Record<string, DraftProblem> = {
  'access-denied': {
    error: 'record-source-denied',
    instruction:
      'The human cannot read rows of that table, so a record trigger cannot use it. Ask which readable table holds the dates.',
  },
  'record-field-unavailable': {
    error: 'record-field-unavailable',
    instruction:
      'The table is not active, or the field is not a date or timestamp field matching field.kind. Call tables.definitions and use the exact table ID and the ID of a date or timestamp field.',
  },
  'record-trigger-unavailable': {
    error: 'record-trigger-unavailable',
    instruction:
      'This workspace has not been upgraded for record-date triggers yet. Tell the human to try again later.',
  },
  'invalid-schedule': {
    error: 'invalid-schedule',
    instruction: 'The record trigger timezone is not a known IANA zone. Correct it and draft again.',
  },
};
const rowProblems: Record<string, DraftProblem> = {
  'access-denied': {
    error: 'record-source-denied',
    instruction:
      'The human cannot read rows of that table, so a row trigger cannot use it. Ask which readable table to watch.',
  },
  'record-field-unavailable': {
    error: 'record-field-unavailable',
    instruction:
      'The table is not active, a fieldIds entry names a field the table lacks, or the filter names a missing field, a retired option, or a value whose kind differs from the field kind. Call tables.definitions and use the exact lowercase table and field IDs.',
  },
  'record-trigger-unavailable': {
    error: 'record-trigger-unavailable',
    instruction: 'This workspace has not been upgraded for row triggers yet. Tell the human to try again later.',
  },
};

const tableStepProblems: Record<string, DraftProblem> = {
  'access-denied': {
    error: 'table-step-access-denied',
    instruction: 'The human cannot read rows of a table a step uses. Ask which readable table to use.',
  },
  'table-step-field-unavailable': {
    error: 'table-step-field-unavailable',
    instruction:
      'A table step names a table that is not active, a field the table lacks, or a file field, or it filters a field that is not text, number, yes or no, date or timestamp. Call tables.definitions and use the exact lowercase table and field IDs.',
  },
  'table-step-access-denied': {
    error: 'table-step-access-denied',
    instruction:
      'Scheduled, record and webhook runs act as the human, who lacks create or update permission on a table a step writes. Tell the human which permission is missing, or offer a manual workflow.',
  },
};

/** Mirrors the workflow scheduler so the review card can show the next run before anything is saved. */
export function nextWorkflowRun(trigger: Trigger, now = new Date()): string | null {
  switch (trigger.kind) {
    case 'once':
      if (trigger.timezone) new Intl.DateTimeFormat('en', { timeZone: trigger.timezone }).format(now);
      return new Date(trigger.at).toISOString();
    case 'interval':
      return new Date(now.getTime() + trigger.minutes * 60000).toISOString();
    case 'cron':
      new Intl.DateTimeFormat('en', { timeZone: trigger.timezone }).format(now);
      return CronExpressionParser.parse(trigger.expression, { currentDate: now, tz: trigger.timezone })
        .next()
        .toDate()
        .toISOString();
    case 'manual':
    case 'webhook':
    case 'event':
    case 'provider':
    case 'github':
    case 'record':
    case 'row':
      return null;
    default: {
      const exhaustive: never = trigger;
      return exhaustive;
    }
  }
}

/** The next run the card can promise: a one-time run whose moment has passed will not happen. */
export function previewWorkflowRun(trigger: Trigger, now = new Date()) {
  const next = nextWorkflowRun(trigger, now);
  return trigger.kind === 'once' && next !== null && Date.parse(next) <= now.getTime() ? null : next;
}

export function workflowDefinitionProblem(
  definition: Definition,
  now = new Date(),
  codeSteps = workflowCodeStepsEnabled(),
) {
  const trigger = definition.trigger;
  if (!codeSteps && definition.steps.some(step => step.kind === 'code'))
    return {
      error: 'code-steps-unavailable',
      instruction:
        'No isolated code runner is configured, so JavaScript and Python steps cannot run. Draft the workflow without code steps, and tell the human why.',
    };
  try {
    nextWorkflowRun(trigger, now);
  } catch {
    return {
      error: 'invalid-schedule',
      instruction: 'The cron expression or IANA timezone is invalid. Correct it and draft again.',
    };
  }
  if (trigger.kind === 'once' && Date.parse(trigger.at) <= now.getTime())
    return {
      error: 'schedule-in-past',
      instruction: 'A one-time trigger must be in the future. Confirm the intended time with the human.',
    };
  return null;
}

export function summarizeWorkflow(workflow: Workflow) {
  return {
    id: workflow.id,
    name: workflow.definition.name,
    revision: workflow.revision,
    activeRevision: workflow.activeRevision,
    enabled: workflow.enabled,
    nextRunAt: workflow.nextRunAt,
    trigger: workflow.definition.trigger,
    steps: workflow.definition.steps.map(step => ({ id: step.id, kind: step.kind })),
    canManage: workflow.capabilities.manage,
    webhookConfigured: workflow.webhookConfigured,
  };
}

/** Reaches workflows only through the package service, which takes the authorization write lock. */
export function createWorkflowDrafts(
  storage: AgentStorage,
  workspaceId: string,
  options: { wake?: (work: Work) => Promise<void>; githubSubscriptions?: GitHubSubscriptions } = {},
): WorkflowDrafts {
  const codeSteps = workflowCodeStepsEnabled();
  const service = createWorkflows(storage, { codeSteps, agentSteps: true, ...options });
  const list = (actor: HumanActor) => service.list(workspaceId, actor.userId);
  const read = (actor: HumanActor, id: string) => service.definition(workspaceId, actor.userId, id);
  const providers = async (actor: HumanActor) =>
    (await service.providers.list(workspaceId, actor.userId)).filter(
      source => source.enabled && source.authorized && source.capabilities.use,
    );
  const githubRepositories = (actor: HumanActor) => service.githubRepositories(workspaceId, actor.userId);
  async function find(actor: HumanActor, id: string) {
    return (await list(actor)).find(workflow => workflow.id === id) ?? null;
  }
  async function writable(actor: HumanActor, proposal: WorkflowProposal) {
    const current = await find(actor, proposal.targetId);
    if (proposal.kind === 'workflow' && proposal.input.expectedRevision === null && !current) return;
    if (!current?.capabilities.manage) throw new AccessDenied();
  }
  async function labelled<T>(problems: Record<string, DraftProblem>, read: () => Promise<T>) {
    try {
      return await read();
    } catch (error) {
      const problem =
        error instanceof AccessDenied
          ? problems['access-denied']
          : error instanceof WorkflowConflict
            ? problems[error.message]
            : undefined;
      if (!problem) throw error;
      return problem;
    }
  }
  const recordSource = (actor: HumanActor, trigger: Extract<Trigger, { kind: 'record' }>) =>
    labelled(recordProblems, () => service.recordSourceLabels(workspaceId, actor.userId, trigger));
  const rowSource = (actor: HumanActor, trigger: Extract<Trigger, { kind: 'row' }>) =>
    labelled(rowProblems, () => service.rowSourceLabels(workspaceId, actor.userId, trigger));
  const tableStepSources = (actor: HumanActor, definition: Definition) =>
    labelled(tableStepProblems, () => service.checkTableSteps(workspaceId, actor.userId, definition));
  async function sourceProblem(actor: HumanActor, trigger: Trigger) {
    if (trigger.kind === 'provider') {
      try {
        await service.providers.check(workspaceId, actor.userId, trigger);
        return null;
      } catch (error) {
        if (!(error instanceof AccessDenied)) throw error;
        return {
          error: 'provider-source-denied',
          instruction:
            'This connected source is unavailable, disabled, not authorized for you, or does not support this event. Call workflows.providers for usable configured sources. New integrations and secrets must be set up on the Workflows page, never in chat.',
        };
      }
    }
    if (trigger.kind === 'github')
      return labelled(githubProblems, async () => {
        await service.checkGitHubRepository(workspaceId, actor.userId, trigger);
        return null;
      });
    const source =
      trigger.kind === 'record'
        ? await recordSource(actor, trigger)
        : trigger.kind === 'row'
          ? await rowSource(actor, trigger)
          : null;
    return source && 'error' in source ? source : null;
  }
  async function tableStepProblem(actor: HumanActor, definition: Definition) {
    try {
      await service.checkTableSteps(workspaceId, actor.userId, definition);
      return null;
    } catch (error) {
      const problem =
        error instanceof AccessDenied
          ? tableStepProblems['access-denied']
          : error instanceof WorkflowConflict
            ? tableStepProblems[error.message]
            : undefined;
      if (!problem) throw error;
      return problem;
    }
  }
  async function problem(actor: HumanActor, definition: Definition) {
    return (
      workflowDefinitionProblem(definition, new Date(), codeSteps) ??
      (await sourceProblem(actor, definition.trigger)) ??
      tableStepProblem(actor, definition)
    );
  }
  async function stale(actor: HumanActor, proposal: WorkflowProposal) {
    const current = await find(actor, proposal.targetId);
    const expected = proposal.kind === 'workflow' ? proposal.input.expectedRevision : proposal.input.revision;
    if ((current?.revision ?? null) !== expected) return true;
    if (proposal.kind === 'workflow') return (await problem(actor, proposal.input.definition)) !== null;
    return proposal.input.enabled && (await sourceProblem(actor, proposal.input.definition.trigger)) !== null;
  }
  async function activation(
    actor: HumanActor,
    workflow: Workflow,
    enabled: boolean,
    commandId: string,
  ): Promise<DraftOutcome> {
    let current = workflow;
    if (enabled && unattended(current.definition.trigger) && !current.sponsorshipAccepted) {
      if (
        (current.sponsorMembershipId && current.sponsorMembershipId !== actor.membershipId) ||
        !current.capabilities.invoke
      )
        return outcome(current, 'sponsor-required');
      try {
        current = await service.sponsorship(workspaceId, actor.userId, current.id, {
          sponsorMembershipId: actor.membershipId,
          historyAudience: current.historyAudience.length ? current.historyAudience : [actor.membershipId],
        });
      } catch (error) {
        // The drafter's own table access was checked with the draft, so a denial here names someone in the kept history audience.
        if (
          error instanceof WorkflowConflict &&
          (error.message === 'record-source-denied' || error.message === 'table-step-access-denied')
        )
          return outcome(current, 'audience-required');
        throw error;
      }
    }
    current = await service.activate(workspaceId, actor.userId, current.id, {
      commandId,
      expectedGeneration: current.generation,
      revision: current.revision,
      enabled,
    });
    return outcome(current, enabled ? 'activated' : 'disabled');
  }
  function outcome(
    workflow: Workflow,
    activation: Extract<DraftOutcome, { kind: 'workflow' }>['activation'],
  ): DraftOutcome {
    return {
      kind: 'workflow',
      workflowId: workflow.id,
      revision: workflow.revision,
      enabled: workflow.enabled,
      nextRunAt: workflow.enabled ? workflow.nextRunAt : null,
      activation,
    };
  }
  async function apply(
    actor: HumanActor,
    draftId: string,
    commandId: string,
    proposal: WorkflowProposal,
  ): Promise<DraftOutcome> {
    if (proposal.kind === 'workflow-activation') {
      const current = await find(actor, proposal.targetId);
      if (!current) throw new AccessDenied();
      return activation(actor, current, proposal.input.enabled, commandId);
    }
    const saved = await service.save(workspaceId, actor.userId, proposal.targetId, {
      revision: draftId,
      expectedRevision: proposal.input.expectedRevision,
      definition: proposal.input.definition,
    });
    return proposal.input.activate ? activation(actor, saved, true, commandId) : outcome(saved, 'not-requested');
  }
  return {
    list,
    read,
    providers,
    githubRepositories,
    problem,
    sourceProblem,
    recordSource,
    rowSource,
    tableStepSources,
    find,
    writable,
    stale,
    apply,
  };
}
