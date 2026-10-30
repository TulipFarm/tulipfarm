import { CodeBlock } from '@tulipfarm/sprout/code-block';
import { ReviewRow, ReviewRows, ReviewSteps, ReviewValues, type ReviewStep } from '@tulipfarm/sprout/review-card';
import type { DraftView, WorkflowProposal } from '@tulipfarm/agents/draft-contracts';
import {
  comparisonWords,
  describeGitHubTrigger,
  describeValue,
  filterPhrase,
  recordScheduleDescription,
} from '@/features/workflows/definition-description';
import { AgentName } from '@/features/agents/reference-names';
import { WorkflowSlackDestinationLabel } from '@/features/workflows/slack-step';

type Definition = WorkflowProposal['input']['definition'];
type Trigger = Definition['trigger'];
type Step = Definition['steps'][number];
type Value = Extract<Step, { kind: 'transform' }>['fields'][string];
type RecordSource = DraftView['workflowRecordSource'];
type RowSource = DraftView['workflowRowSource'];
type FilterLabels = NonNullable<NonNullable<RecordSource>['filter']>;
type Filter = NonNullable<Extract<Trigger, { kind: 'record' | 'row' }>['filter']>;
type TableStepSources = DraftView['workflowTableStepSources'];

export function workflowSaveLabel(proposal: WorkflowProposal) {
  if (proposal.kind === 'workflow') return proposal.input.activate ? 'Save and activate' : 'Save workflow';
  return proposal.input.enabled ? 'Activate workflow' : 'Disable workflow';
}

export function WorkflowDraftDetails({
  workspaceId,
  proposal,
  nextRunAt,
  recordSource,
  rowSource,
  tableStepSources,
  onSlackReady,
}: {
  workspaceId: string;
  proposal: WorkflowProposal;
  nextRunAt: string | null;
  recordSource: RecordSource;
  rowSource: RowSource;
  tableStepSources: TableStepSources;
  onSlackReady: (id: string, ready: boolean) => void;
}) {
  const { trigger, steps } = proposal.input.definition;
  const runs = proposal.kind === 'workflow' ? proposal.input.activate : proposal.input.enabled;
  return (
    <>
      <ReviewRows>
        <ReviewRow label="Change">
          <span>{workflowChange(proposal)}</span>
        </ReviewRow>
        <ReviewRow label="Trigger">
          <span>{describeTrigger(trigger, recordSource, rowSource)}</span>
        </ReviewRow>
        {trigger.kind === 'row' && trigger.fieldIds && (
          <ReviewRow label="Watched fields">
            <span>
              {rowSource
                ? rowSource.fields.map(field => `“${field}”`).join(', ')
                : `${trigger.fieldIds.length} unavailable ${trigger.fieldIds.length === 1 ? 'field' : 'fields'}`}
            </span>
          </ReviewRow>
        )}
        {(trigger.kind === 'record' || trigger.kind === 'row') && trigger.filter && (
          <ReviewRow label="Only rows where">
            <span>
              {describeFilter(trigger.filter, (trigger.kind === 'record' ? recordSource : rowSource)?.filter ?? null)}
            </span>
          </ReviewRow>
        )}
        {trigger.kind === 'webhook' && (
          <>
            <ReviewRow label="Duplicate check">
              <span>{describeDedupe(trigger)}</span>
            </ReviewRow>
            <ReviewRow label="Copied headers">
              <span>{trigger.payload?.headers?.length ? trigger.payload.headers.join(', ') : 'None'}</span>
            </ReviewRow>
          </>
        )}
        <ReviewRow label="Next run">
          <span>
            {trigger.kind === 'record' && (runs || proposal.kind === 'workflow')
              ? `Each row’s own date${runs ? '. Upcoming dates appear on the Workflows page once it is active.' : ', once activated'}`
              : trigger.kind === 'row' && (runs || proposal.kind === 'workflow')
                ? `Within about a minute of each matching change${runs ? '' : ', once activated'}`
                : !nextRunAt
                  ? runs
                    ? 'No scheduled run'
                    : 'None while inactive'
                  : runs
                    ? formatRun(nextRunAt, trigger)
                    : `${formatRun(nextRunAt, trigger)} once activated`}
          </span>
        </ReviewRow>
      </ReviewRows>
      <ReviewSteps
        title={`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`}
        steps={steps.map(step => {
          const review = describeStep(step, tableStepSources, workspaceId);
          return step.kind === 'slack-message'
            ? {
                ...review,
                detail: (
                  <>
                    <WorkflowSlackDestinationLabel
                      workspaceId={workspaceId}
                      id={step.destinationId}
                      onReady={onSlackReady}
                    />
                    {review.detail}
                  </>
                ),
              }
            : review;
        })}
      />
    </>
  );
}

export function formatRun(iso: string, trigger: Trigger) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...((trigger.kind === 'cron' || trigger.kind === 'once') && trigger.timezone
      ? { timeZone: trigger.timezone }
      : trigger.kind === 'record' && trigger.field.kind === 'date'
        ? { timeZone: trigger.field.timezone }
        : {}),
  });
}

export function workflowChange(proposal: WorkflowProposal) {
  if (proposal.kind === 'workflow-activation')
    return proposal.input.enabled ? 'Activates the current revision' : 'Disables the workflow';
  const saved =
    proposal.input.expectedRevision === null
      ? 'Creates a new workflow'
      : 'Saves a new revision of an existing workflow';
  if (proposal.input.activate) return `${saved} and activates it`;
  return proposal.input.expectedRevision === null
    ? `${saved}. It stays inactive.`
    : `${saved}. The active revision does not change.`;
}

function describeTrigger(trigger: Trigger, recordSource: RecordSource, rowSource: RowSource) {
  switch (trigger.kind) {
    case 'cron':
      return `Schedule “${trigger.expression}” in ${trigger.timezone}`;
    case 'once':
      return `Once at ${formatRun(trigger.at, trigger)}`;
    case 'interval':
      return `Every ${trigger.minutes} ${trigger.minutes === 1 ? 'minute' : 'minutes'}`;
    case 'manual':
      return 'Started manually';
    case 'webhook':
      return `Webhook request. ${!trigger.payload ? 'Run input is the input field of a request ID envelope' : trigger.payload.headers?.length ? 'Run input is { body, headers } with the raw JSON body and copied headers' : 'Run input is the raw JSON body'}. Create its key on the Workflows page.`;
    case 'event':
      return `Workspace event “${trigger.name}”`;
    case 'provider':
      return `Connected provider records ${trigger.event}, checked every ${trigger.minutes} minutes`;
    case 'github':
      return `${describeGitHubTrigger(trigger)}, repository ID ${trigger.repositoryId}. Run input holds a short summary of the GitHub event`;
    case 'record':
      return recordSource
        ? `${recordScheduleDescription(trigger.field, `“${recordSource.field}”`)}, once for each row of “${recordSource.table}”. Run input holds the row ID and values`
        : `${recordScheduleDescription(trigger.field)}, once for each row of an unavailable table (${trigger.tableId.slice(0, 8)}). Run input holds the row ID and values`;
    case 'row':
      return `When a row of ${rowSource ? `“${rowSource.table}”` : `an unavailable table (${trigger.tableId.slice(0, 8)})`} is ${trigger.event}. Run input holds the row ID and ${trigger.event === 'updated' ? 'its values before and after the change' : trigger.event === 'deleted' ? 'its last values' : 'values'}`;
    default: {
      const exhaustive: never = trigger;
      return exhaustive;
    }
  }
}

function describeFilter(filter: Filter, labels: FilterLabels | null) {
  if (!labels) return 'A field or value that is unavailable';
  const quoted = filter.match === 'is' || filter.match === 'is-not' ? `“${labels.value}”` : labels.value;
  return `“${labels.field}” ${filterPhrase(filter, quoted)}${filter.match === 'is-not' ? `. Rows with no ${labels.field} also run.` : ''}`;
}

function describeDedupe(trigger: Extract<Trigger, { kind: 'webhook' }>) {
  const dedupe = trigger.payload?.dedupe;
  const repeat = 'A repeat returns the first run, and a changed body is rejected.';
  if (!dedupe) return 'Request ID. A repeat returns the first run, and a changed input is rejected.';
  switch (dedupe.source) {
    case 'header':
      return `Header “${dedupe.name}”. ${repeat}`;
    case 'body':
      return `Body field “${dedupe.path.join('.')}”. ${repeat}`;
    case 'hash':
      return 'Body hash. A repeat of the same body returns the first run.';
    default: {
      const exhaustive: never = dedupe;
      return exhaustive;
    }
  }
}

function fieldCount(fields: Record<string, Value>) {
  const count = Object.keys(fields).length;
  return `${count} ${count === 1 ? 'field' : 'fields'}`;
}

function branchAction(own: string[], other: string[]) {
  return `${own.length ? 'run' : 'skip'} ${(own.length ? own : other).map(id => id.replaceAll('_', ' ')).join(', ')}`;
}

function rowFields(fields: Record<string, Value>, labels: Record<string, string> | undefined) {
  return Object.entries(fields).map(([fieldId, value]) => ({
    name: labels?.[fieldId] ? `“${labels[fieldId]}”` : `unavailable field (${fieldId.slice(0, 8)})`,
    value: describeValue(value),
  }));
}

function describeStep(step: Step, sources: TableStepSources, workspaceId: string): ReviewStep {
  const name = step.id.replaceAll('_', ' ');
  const source = 'tableId' in step ? sources.find(item => item.id === step.id) : undefined;
  const table = source ? `“${source.table}”` : 'table unavailable';
  switch (step.kind) {
    case 'agent':
      return {
        summary: (
          <>
            {name}: ask <AgentName workspaceId={workspaceId} agentId={step.agentId} /> to {describeValue(step.prompt)}
          </>
        ),
        detail: (
          <p>
            Limits: {step.limits.toolCalls} tool calls, {step.limits.activeMilliseconds / 1000} seconds,{' '}
            {step.limits.credits} Credits.
          </p>
        ),
      };
    case 'slack-message':
      return {
        summary: `${name}: send a Slack message`,
        detail: (
          <>
            <ReviewValues
              values={[
                { name: 'Message', value: describeValue(step.text) },
                {
                  name: 'Posts as',
                  value: step.sender === 'app' ? 'TulipFarm app' : 'Slack account of the requester or sponsor',
                },
              ]}
            />
            <p>
              Saving this workflow does not approve a send. Each run asks its requester or sponsor to approve the exact
              message. Approval expires after 24 hours.
            </p>
          </>
        ),
      };
    case 'http':
      return {
        summary: `${name}: send ${step.method} to ${step.url}`,
        detail: (
          <ReviewValues
            values={[
              ...Object.entries(step.headers).map(([header, value]) => ({ name: header, value: describeValue(value) })),
              ...(step.body ? [{ name: 'Body', value: describeValue(step.body) }] : []),
            ]}
          />
        ),
      };
    case 'human':
      return { summary: `${name}: ask for a response. “${step.prompt}”` };
    case 'delay':
      return { summary: `${name}: wait ${step.seconds} seconds` };
    case 'transform':
      return {
        summary: `${name}: set ${Object.keys(step.fields).join(', ')}`,
        detail: (
          <ReviewValues
            values={Object.entries(step.fields).map(([field, value]) => ({ name: field, value: describeValue(value) }))}
          />
        ),
      };
    case 'code':
      return {
        summary: `${name}: run ${step.language === 'python' ? 'Python' : 'JavaScript'} code with ${describeValue(step.input)}`,
        detail: (
          <CodeBlock
            code={step.source}
            language={step.language}
            filename={`${step.id}.${step.language === 'python' ? 'py' : 'js'}`}
          />
        ),
      };
    case 'wait-until':
      return {
        summary: `${name}: wait until ${step.at.kind === 'literal' ? String(step.at.value) : `the time in ${describeValue(step.at)}`}`,
      };
    case 'find-rows':
      return {
        summary: `${name}: find up to ${step.limit} rows in ${table}${step.filters.length ? ` matching ${step.filters.length} ${step.filters.length === 1 ? 'condition' : 'conditions'}` : ''}`,
        ...(step.filters.length
          ? {
              detail: (
                <ReviewValues
                  values={step.filters.map(filter => ({
                    name: source?.fields[filter.fieldId]
                      ? `“${source.fields[filter.fieldId]}”`
                      : `unavailable field (${filter.fieldId.slice(0, 8)})`,
                    value: 'value' in filter ? `${filter.op} ${describeValue(filter.value)}` : filter.op,
                  }))}
                />
              ),
            }
          : {}),
      };
    case 'create-row':
      return {
        summary: `${name}: add a row to ${table}, writing ${fieldCount(step.fields)}`,
        detail: <ReviewValues values={rowFields(step.fields, source?.fields)} />,
      };
    case 'update-row':
      return {
        summary: `${name}: update the row in ${describeValue(step.row)} in ${table}, writing ${fieldCount(step.fields)}`,
        detail: <ReviewValues values={rowFields(step.fields, source?.fields)} />,
      };
    case 'condition':
      return {
        summary: `${name}: check whether ${describeValue(step.when.left)} ${comparisonWords[step.when.op]}${'right' in step.when ? ` ${describeValue(step.when.right)}` : ''}`,
        detail: (
          <ReviewValues
            values={[
              { name: 'If it holds', value: branchAction(step.ifMet, step.otherwise) },
              { name: 'Otherwise', value: branchAction(step.otherwise, step.ifMet) },
            ]}
          />
        ),
      };
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}
