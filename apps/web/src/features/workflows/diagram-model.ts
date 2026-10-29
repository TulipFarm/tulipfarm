import { stepGates, stepValues, type Definition, type Step, type Trigger } from '@tulipfarm/workflows/contracts';
import type {
  WorkflowDiagramEdge,
  WorkflowDiagramNode,
  WorkflowStepState,
} from '../../components/workflow-diagram.tsx';
import type { Brand } from '@tulipfarm/sprout/brand-icon';
import { runTime } from './calendar-schedule.ts';
import { workflowLayout } from './diagram-layout.ts';
import {
  comparisonWords,
  describeValue,
  filterPhrase,
  recordScheduleDescription,
  type WorkflowValue,
} from './definition-description.ts';

export type WorkflowLabels = {
  actor: string;
  trigger?: { title: string; summary: string; brand?: Brand };
  steps?: Record<string, { title: string; summary: string; brand?: Brand }>;
  agents?: Record<string, string>;
  tables?: Record<string, string>;
  fields?: Record<string, string>;
  options?: Record<string, string>;
  destinations?: Record<string, string>;
  provider?: string;
  providerBrand?: Brand;
};
export type WorkflowStepDetails = {
  facts: { label: string; value: string }[];
  gates: { stepId: string; label: string; choice: 'Yes' | 'No' }[];
  references: { stepId: string; label: string }[];
  configuration: Trigger | Step;
};
export type WorkflowGraph = {
  nodes: WorkflowDiagramNode[];
  edges: WorkflowDiagramEdge[];
  details: Record<string, WorkflowStepDetails>;
};

const stepTitles: Record<Step['kind'], string> = {
  condition: 'Check a condition',
  transform: 'Prepare data',
  delay: 'Wait before continuing',
  'wait-until': 'Wait until a date',
  human: 'Ask for a decision',
  code: 'Run code',
  agent: 'Run an agent task',
  http: 'Make a request',
  'slack-message': 'Send a Slack message',
  'find-rows': 'Find matching rows',
  'create-row': 'Create a row',
  'update-row': 'Update a row',
};
export const triggerTitles: Record<Trigger['kind'], string> = {
  manual: 'Started by a person',
  webhook: 'Webhook received',
  event: 'Event received',
  provider: 'Connected app event',
  once: 'At a scheduled time',
  interval: 'On a repeating schedule',
  cron: 'On a calendar schedule',
  record: 'When a row date is due',
  row: 'When a row changes',
};

export function workflowDuration(seconds: number) {
  const parts: string[] = [];
  for (const [unit, size] of [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as const) {
    const amount = Math.floor(seconds / size);
    if (amount) parts.push(`${amount} ${unit}${amount === 1 ? '' : 's'}`);
    seconds %= size;
  }
  return parts.join(' ') || '0 seconds';
}

function sourceText(step: Step, labels: WorkflowLabels, timezone: string): string {
  switch (step.kind) {
    case 'condition':
      return 'Only the selected steps continue';
    case 'transform':
      return `${Object.keys(step.fields).length} output ${Object.keys(step.fields).length === 1 ? 'field' : 'fields'}`;
    case 'delay':
      return workflowDuration(step.seconds);
    case 'wait-until':
      return step.at.kind !== 'literal'
        ? 'Date from an earlier input'
        : typeof step.at.value === 'string' && Number.isFinite(Date.parse(step.at.value))
          ? runTime(step.at.value, timezone)
          : 'Invalid date. Update this step in chat.';
    case 'human':
      return step.prompt;
    case 'code':
      return step.language === 'javascript' ? 'JavaScript' : 'Python';
    case 'agent':
      return labels.agents?.[step.agentId] ?? 'Agent name unavailable';
    case 'http':
      return `${step.method} ${new URL(step.url).hostname}`;
    case 'slack-message':
      return labels.destinations?.[step.destinationId] ?? 'Destination unavailable';
    case 'find-rows':
    case 'create-row':
    case 'update-row':
      return labels.tables?.[step.tableId] ?? 'Table name unavailable';
  }
}

function triggerText(trigger: Trigger, labels: WorkflowLabels) {
  switch (trigger.kind) {
    case 'manual':
      return 'A person with run access starts it';
    case 'webhook':
      return 'An authenticated incoming event';
    case 'event':
      return trigger.name;
    case 'provider':
      return `${labels.provider ?? 'Connected source'} / every ${workflowDuration(trigger.minutes * 60)}`;
    case 'once':
      return runTime(trigger.at, trigger.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    case 'interval':
      return `Every ${workflowDuration(trigger.minutes * 60)}`;
    case 'cron':
      return `${trigger.expression} / ${trigger.timezone}`;
    case 'record':
      return labels.tables?.[trigger.tableId] ?? 'Table name unavailable';
    case 'row':
      return `${labels.tables?.[trigger.tableId] ?? 'Table name unavailable'} / ${trigger.event}`;
  }
}

function triggerFacts(trigger: Trigger, labels: WorkflowLabels): WorkflowStepDetails['facts'] {
  const field = (id: string) => labels.fields?.[id] ?? 'Unavailable field';
  if (trigger.kind === 'webhook') {
    const dedupe = trigger.payload?.dedupe;
    return [
      {
        label: 'Input',
        value: !trigger.payload
          ? 'The input field of a request ID envelope'
          : trigger.payload.headers?.length
            ? 'Raw JSON body and copied headers'
            : 'Raw JSON body',
      },
      {
        label: 'Duplicate check',
        value: !dedupe
          ? 'Request ID'
          : dedupe.source === 'body'
            ? `Body field ${dedupe.path.join('.')}`
            : dedupe.source === 'header'
              ? `Header ${dedupe.name}`
              : 'Body hash',
      },
      { label: 'Copied headers', value: trigger.payload?.headers?.join(', ') || 'None' },
    ];
  }
  if (trigger.kind === 'provider')
    return [{ label: 'Starts for', value: trigger.event === 'updated' ? 'Updated rows' : 'New items' }];
  if (trigger.kind !== 'row' && trigger.kind !== 'record') return [];
  const facts =
    trigger.kind === 'record'
      ? [{ label: 'Schedule', value: recordScheduleDescription(trigger.field, field(trigger.field.fieldId)) }]
      : [{ label: 'Watched fields', value: trigger.fieldIds?.map(field).join(', ') || 'All fields' }];
  const filter = trigger.filter;
  if (filter) {
    const shown = !('value' in filter)
      ? null
      : filter.value.kind === 'single-select'
        ? (labels.options?.[filter.value.optionId] ?? 'Unavailable option')
        : String(filter.value.value);
    facts.push({
      label: 'Only rows where',
      value: `${field(filter.fieldId)} ${filterPhrase(filter, shown)}${filter.match === 'is-not' ? '. Rows with no value also run.' : ''}`,
    });
  }
  return facts;
}
function stepFacts(step: Step, labels: WorkflowLabels): WorkflowStepDetails['facts'] {
  const fields = (values: Record<string, WorkflowValue>, table = false) =>
    Object.entries(values).map(([id, value]) => ({
      label: table ? (labels.fields?.[id] ?? 'Unavailable field') : id,
      value: describeValue(value),
    }));
  switch (step.kind) {
    case 'transform':
      return fields(step.fields);
    case 'condition':
      return [
        {
          label: 'Checks',
          value: `${describeValue(step.when.left)} ${comparisonWords[step.when.op]}${'right' in step.when ? ` ${describeValue(step.when.right)}` : ''}`,
        },
      ];
    case 'agent':
      return [{ label: 'Task', value: describeValue(step.prompt) }];
    case 'slack-message':
      return [
        { label: 'Message', value: describeValue(step.text) },
        {
          label: 'Posts as',
          value: step.sender === 'app' ? 'TulipFarm app' : 'Slack account of the person running this workflow',
        },
      ];
    case 'http':
      return [
        { label: 'URL', value: step.url },
        ...fields(step.headers),
        ...(step.body ? [{ label: 'Body', value: describeValue(step.body) }] : []),
      ];
    case 'code':
      return [{ label: 'Input', value: describeValue(step.input) }];
    case 'wait-until':
      return step.at.kind === 'literal' ? [] : [{ label: 'Date input', value: describeValue(step.at) }];
    case 'find-rows':
      return [
        { label: 'Maximum rows', value: String(step.limit) },
        ...step.filters.map(filter => ({
          label: labels.fields?.[filter.fieldId] ?? 'Unavailable field',
          value: `${filter.op}${'value' in filter ? ` ${describeValue(filter.value)}` : ''}`,
        })),
      ];
    case 'create-row':
      return fields(step.fields, true);
    case 'update-row':
      return [{ label: 'Row', value: describeValue(step.row) }, ...fields(step.fields, true)];
    case 'delay':
    case 'human':
      return [];
  }
}

export function workflowGraph(
  definition: Definition,
  labels: WorkflowLabels,
  states?: Readonly<Record<string, WorkflowStepState>>,
): WorkflowGraph {
  const state = (id: string): WorkflowStepState => (states ? (states[id] ?? 'unknown') : 'definition');
  const title = (step: Step) => labels.steps?.[step.id]?.title ?? stepTitles[step.kind];
  const gates = stepGates(definition.steps);
  const trigger = definition.trigger;
  const timezone =
    ('timezone' in trigger
      ? trigger.timezone
      : trigger.kind === 'record' && 'timezone' in trigger.field
        ? trigger.field.timezone
        : undefined) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const triggerBrand = labels.trigger?.brand ?? (trigger.kind === 'provider' ? labels.providerBrand : undefined);
  const nodes: WorkflowDiagramNode[] = [
    {
      id: '$trigger',
      kind: 'trigger',
      title: labels.trigger?.title ?? triggerTitles[definition.trigger.kind],
      summary: labels.trigger?.summary ?? triggerText(definition.trigger, labels),
      actor: `Runs as ${labels.actor}`,
      ordinal: 0,
      state: state('$trigger'),
      position: { x: 0, y: 0 },
      ...(triggerBrand ? { identity: { kind: 'app', brand: triggerBrand } as const } : {}),
    },
  ];
  const edges: WorkflowDiagramEdge[] = [];
  const details: WorkflowGraph['details'] = {
    $trigger: {
      facts: [
        { label: 'Starts', value: triggerText(definition.trigger, labels) },
        { label: 'Runs as', value: labels.actor },
        ...triggerFacts(trigger, labels),
      ],
      gates: [],
      references: [],
      configuration: definition.trigger,
    },
  };
  for (const [index, step] of definition.steps.entries()) {
    const required = [...(gates.get(step.id) ?? [])].map(gate => {
      const [conditionId, branch] = gate.split(':');
      const condition = definition.steps.find(candidate => candidate.id === conditionId);
      if (!condition) throw new Error(`Missing workflow condition: ${conditionId}`);
      return {
        stepId: condition.id,
        label: title(condition),
        choice: branch === 'ifMet' ? ('Yes' as const) : ('No' as const),
      };
    });
    const summary = labels.steps?.[step.id]?.summary ?? sourceText(step, labels, timezone);
    const actor = step.kind === 'agent' ? (labels.agents?.[step.agentId] ?? 'Agent unavailable') : labels.actor;
    const brand = step.kind === 'slack-message' ? 'slack' : labels.steps?.[step.id]?.brand;
    nodes.push({
      id: step.id,
      kind: step.kind,
      title: title(step),
      summary,
      actor: step.kind === 'agent' ? actor : step.kind === 'human' ? `Response from ${actor}` : `Runs as ${actor}`,
      ordinal: index + 1,
      state: state(step.id),
      position: { x: 0, y: 0 },
      ...(brand
        ? { identity: { kind: 'app', brand } as const }
        : step.kind === 'agent' && labels.agents?.[step.agentId]
          ? { identity: { kind: 'agent', agentId: step.agentId, name: actor } as const }
          : {}),
    });
    details[step.id] = {
      facts: [
        { label: 'Action', value: sourceText(step, labels, timezone) },
        { label: 'Acts as', value: actor },
        ...(step.kind === 'slack-message'
          ? [{ label: 'Approval', value: 'The requester or sponsor approves each exact message before it is sent.' }]
          : []),
        ...(step.kind === 'agent'
          ? [{ label: 'Limits', value: `${step.limits.toolCalls} tool calls / ${step.limits.credits} credits` }]
          : []),
        ...(step.kind === 'human' ? [{ label: 'Respond within', value: workflowDuration(step.timeoutSeconds) }] : []),
        ...stepFacts(step, labels),
      ],
      gates: required,
      references: [...new Set(stepValues(step).flatMap(value => (value.kind === 'step' ? [value.step] : [])))].map(
        id => {
          const source = definition.steps.find(candidate => candidate.id === id);
          if (!source) throw new Error(`Missing workflow input step: ${id}`);
          return { stepId: id, label: title(source) };
        },
      ),
      configuration: step,
    };
  }
  const predecessors = workflowLayout(nodes, gates);
  const pathState = (source: WorkflowDiagramNode, target: WorkflowDiagramNode): WorkflowDiagramEdge['state'] => {
    if (source.state === 'skipped' || target.state === 'skipped') return 'muted';
    const confirmed =
      source.state === 'completed' &&
      nodes.slice(source.ordinal + 1, target.ordinal).every(node => node.state === 'skipped');
    return confirmed && target.state === 'active'
      ? 'active'
      : confirmed && ['completed', 'waiting'].includes(target.state)
        ? 'completed'
        : 'default';
  };
  for (const node of nodes.slice(1)) {
    const previous = predecessors.get(node.id)!;
    for (const source of previous) {
      const gate = details[node.id]!.gates.find(gate => gate.stepId === source.id);
      edges.push({
        id: `flow:${source.id}:${node.id}`,
        source: source.id,
        target: node.id,
        kind: gate ? 'gate' : 'order',
        ...(gate ? { label: gate.choice } : {}),
        state: pathState(source, node),
      });
    }
    for (const gate of details[node.id]!.gates) {
      if (
        previous.some(
          source =>
            source.id === gate.stepId ||
            details[source.id]!.gates.some(
              inherited => inherited.stepId === gate.stepId && inherited.choice === gate.choice,
            ),
        )
      )
        continue;
      edges.push({
        id: `requirement:${gate.stepId}:${node.id}`,
        source: gate.stepId,
        target: node.id,
        kind: 'requirement',
        label: gate.choice,
        state: node.state === 'skipped' ? 'muted' : 'default',
      });
    }
  }
  for (const condition of definition.steps.filter(step => step.kind === 'condition')) {
    for (const [branch, choice] of [
      ['ifMet', 'Yes'],
      ['otherwise', 'No'],
    ] as const) {
      if (condition[branch].length || (!condition.ifMet.length && !condition.otherwise.length)) continue;
      const source = nodes.find(node => node.id === condition.id)!;
      const next = nodes.find(
        node =>
          node.ordinal > source.ordinal &&
          details[node.id]!.gates.every(gate =>
            details[source.id]!.gates.some(parent => parent.stepId === gate.stepId && parent.choice === gate.choice),
          ),
      );
      if (next && !edges.some(edge => edge.source === source.id && edge.target === next.id)) {
        edges.push({
          id: `bypass:${source.id}:${next.id}`,
          source: source.id,
          target: next.id,
          kind: 'gate',
          label: choice,
          state: pathState(source, next),
        });
      }
    }
  }
  let previous: WorkflowDiagramNode | undefined;
  for (const node of nodes) {
    if (node.state === 'skipped') continue;
    if (
      previous?.state === 'completed' &&
      node.ordinal - previous.ordinal > 1 &&
      ['completed', 'active', 'waiting'].includes(node.state)
    ) {
      if (!edges.some(edge => edge.kind !== 'requirement' && edge.source === previous!.id && edge.target === node.id)) {
        edges.push({
          id: `route:${previous.id}:${node.id}`,
          source: previous.id,
          target: node.id,
          kind: 'route',
          label: 'Taken path',
          state: node.state === 'active' ? 'active' : 'completed',
        });
      }
    }
    previous = node;
  }
  return { nodes, edges, details };
}
