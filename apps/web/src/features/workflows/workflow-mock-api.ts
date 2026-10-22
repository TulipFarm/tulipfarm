import { definitionSchema, stepGates, type Definition, type Step, type Trigger } from '@tulipfarm/workflows/contracts';
import type { WorkflowLabels } from './diagram-model';
import type { WorkflowView } from './workflow-viewer';
import type { WorkflowStepState } from '../../components/workflow-diagram';

export const mockId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const destinationId = '33333333-3333-4333-8333-333333333333';
const tableId = '44444444-4444-4444-8444-444444444444';
const fieldId = '55555555-5555-4555-8555-555555555555';
const literal = (value: string) => ({ kind: 'literal' as const, value });
const transform = (id: string): Step => ({
  id,
  kind: 'transform',
  fields: { message: literal('A pull request is ready for review.') },
});
const slack = (id: string): Step => ({
  id,
  kind: 'slack-message',
  destinationId,
  text: literal('The request is ready for the team.'),
  sender: 'app',
});
const condition = (id: string, yes: string[], no: string[]): Step => ({
  id,
  kind: 'condition',
  when: { left: { kind: 'input', path: ['amount'] }, op: 'gt', right: { kind: 'literal', value: 5000 } },
  ifMet: yes,
  otherwise: no,
});

export const mockScenarios = {
  pr: 'Pull request updates',
  approval: 'Conditional approval',
  'branch-no': 'Other branch',
  agent: 'Agent handoff',
  nested: 'Nested conditions',
  waiting: 'Scheduled follow-up',
  provider: 'Connected app',
  catalog: 'Every step type',
  long: '32 steps / long names',
};
export type MockScenario = keyof typeof mockScenarios;
export const mockPhases = {
  draft: 'Draft',
  saved: 'Saved, not active',
  active: 'Active definition',
  queued: 'Queued run',
  running: 'Working run',
  waiting: 'Waiting run',
  completed: 'Completed run',
  failed: 'Failed run',
  blocked: 'Blocked run',
  cancelled: 'Cancelled run',
  skipped: 'Skipped run',
  historical: 'Older run',
  withheld: 'Withheld result',
  loading: 'Loading',
  empty: 'Empty',
  error: 'Read error',
  denied: 'Access lost',
  stale: 'Refresh error',
  dismissed: 'Dismissed draft',
};
export type MockPhase = keyof typeof mockPhases;
export const isMockScenario = (value: unknown): value is MockScenario =>
  typeof value === 'string' && Object.hasOwn(mockScenarios, value);
export const isMockPhase = (value: unknown): value is MockPhase =>
  typeof value === 'string' && Object.hasOwn(mockPhases, value);

export const mockTriggers: Record<Trigger['kind'], Trigger> = {
  manual: { kind: 'manual' },
  webhook: { kind: 'webhook' },
  event: { kind: 'event', name: 'review_requested' },
  provider: { kind: 'provider', integrationId: destinationId, event: 'created', minutes: 5 },
  once: { kind: 'once', at: '2027-01-12T03:30:00Z', timezone: 'Asia/Kolkata' },
  interval: { kind: 'interval', minutes: 60 },
  cron: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Kolkata' },
  record: {
    kind: 'record',
    tableId,
    field: {
      kind: 'date',
      fieldId,
      offset: { direction: 'before', amount: 1, unit: 'days' },
      time: '09:00',
      timezone: 'Asia/Kolkata',
    },
  },
  row: { kind: 'row', tableId, event: 'deleted' },
};

const defaults: WorkflowLabels = {
  actor: 'Mira Patel',
  agents: { [agentId]: 'Operations assistant' },
  tables: { [tableId]: 'Purchase requests' },
  destinations: { [destinationId]: '#engineering' },
  provider: 'Purchase requests / Google Sheets',
  providerBrand: 'google-sheets',
};
const approvalSteps: Step[] = [
  condition('check_amount', ['review'], ['record']),
  {
    id: 'review',
    kind: 'human',
    prompt: 'Approve this purchase request before it is sent to the team.',
    timeoutSeconds: 86400,
  },
  transform('record'),
  slack('notify'),
];
const agentSteps: Step[] = [
  {
    id: 'research',
    kind: 'agent',
    agentId,
    prompt: literal('Read the purchase request and prepare a short recommendation.'),
    limits: { toolCalls: 20, activeMilliseconds: 300000, credits: 30 },
  },
  {
    id: 'decision',
    kind: 'human',
    prompt: 'Review the recommendation and approve the request.',
    timeoutSeconds: 86400,
  },
  slack('notify'),
];
const allSteps: Step[] = [
  condition('check', ['prepare'], ['not_selected']),
  transform('prepare'),
  transform('not_selected'),
  { id: 'pause', kind: 'delay', seconds: 300 },
  { id: 'due', kind: 'wait-until', at: literal('2027-01-12T03:30:00Z') },
  { id: 'review', kind: 'human', prompt: 'Review the prepared request.', timeoutSeconds: 86400 },
  {
    id: 'calculate',
    kind: 'code',
    language: 'javascript',
    source: 'return { total: input.amount };',
    input: { kind: 'input', path: [] },
  },
  agentSteps[0]!,
  { id: 'request', kind: 'http', method: 'GET', url: 'https://example.test/request', headers: {} },
  slack('notify'),
  { id: 'find', kind: 'find-rows', tableId, filters: [], limit: 10 },
  { id: 'create', kind: 'create-row', tableId, fields: { [fieldId]: literal('Reviewed') } },
  {
    id: 'update',
    kind: 'update-row',
    tableId,
    row: { kind: 'step', step: 'create', path: [] },
    fields: { [fieldId]: literal('Approved') },
  },
];
const definitions: Record<MockScenario, Definition> = {
  pr: {
    version: 1,
    name: 'Pull request updates',
    trigger: mockTriggers.webhook,
    steps: [
      transform('prepare'),
      {
        id: 'notify',
        kind: 'slack-message',
        destinationId,
        text: { kind: 'step', step: 'prepare', path: ['message'] },
        sender: 'app',
      },
    ],
  },
  approval: { version: 1, name: 'Approve purchase requests', trigger: mockTriggers.manual, steps: approvalSteps },
  'branch-no': { version: 1, name: 'Approve purchase requests', trigger: mockTriggers.manual, steps: approvalSteps },
  agent: { version: 1, name: 'Review with an operations assistant', trigger: mockTriggers.manual, steps: agentSteps },
  nested: {
    version: 1,
    name: 'Regional purchase approvals',
    trigger: mockTriggers.manual,
    steps: [
      condition('budget', ['region', 'review'], ['record']),
      condition('region', ['review'], ['notify']),
      transform('record'),
      { id: 'review', kind: 'human', prompt: 'Approve the regional request.', timeoutSeconds: 86400 },
      slack('notify'),
    ],
  },
  waiting: {
    version: 1,
    name: 'Follow up on open requests',
    trigger: mockTriggers.cron,
    steps: [
      { id: 'find', kind: 'find-rows', tableId, filters: [], limit: 10 },
      { id: 'pause', kind: 'delay', seconds: 1800 },
      { id: 'due', kind: 'wait-until', at: literal('2027-01-12T03:30:00Z') },
      slack('notify'),
    ],
  },
  provider: { version: 1, name: 'Review new sheet requests', trigger: mockTriggers.provider, steps: agentSteps },
  catalog: { version: 1, name: 'Workflow step library', trigger: mockTriggers.record, steps: allSteps },
  long: {
    version: 1,
    name: 'Review regional purchase requests across operations, finance, and delivery',
    trigger: mockTriggers.row,
    steps: Array.from({ length: 32 }, (_, index) => transform(`prepare_${index + 1}`)),
  },
};
const labels: Partial<Record<MockScenario, WorkflowLabels['steps']>> = {
  pr: {
    prepare: { title: 'Prepare PR summary', summary: 'Title, author, and pull request link' },
    notify: { title: 'Notify engineering', summary: '#engineering / TulipFarm app' },
  },
  approval: {
    check_amount: { title: 'Over the approval limit?', summary: 'Request amount is greater than 5,000' },
    review: { title: 'Review the purchase', summary: 'Ask the requester for a decision' },
    record: { title: 'Record the small purchase', summary: 'No additional review needed' },
    notify: { title: 'Notify the team', summary: 'Continue after the selected steps' },
  },
  agent: {
    research: { title: 'Prepare a recommendation', summary: 'Read the request and compare options' },
    decision: { title: 'Review the recommendation', summary: 'A person makes the final decision' },
    notify: { title: 'Share the decision', summary: '#engineering / approval required' },
  },
};

export function mockWorkflowView(scenario: MockScenario, phase: MockPhase, trigger?: Trigger): WorkflowView {
  const original = definitions[scenario];
  const definition = definitionSchema.parse({
    ...original,
    ...(trigger ? { trigger } : {}),
    ...(phase === 'historical' ? { name: `${original.name} (earlier version)` } : {}),
  });
  const viewLabels: WorkflowLabels = {
    ...defaults,
    ...(['manual', 'event'].includes(definition.trigger.kind) ? { actor: 'Run requester' } : {}),
    ...(scenario === 'pr'
      ? { trigger: { title: 'Pull request opened', summary: 'GitHub / webhook event', brand: 'github' } as const }
      : {}),
    steps:
      labels[scenario === 'branch-no' ? 'approval' : scenario] ??
      (scenario === 'long'
        ? Object.fromEntries(
            definition.steps.map((step, index) => [
              step.id,
              {
                title: `Prepare the regional purchase handoff ${index + 1}`,
                summary: 'Retain the complete request and its review context',
              },
            ]),
          )
        : {}),
  };
  const base: WorkflowView = {
    key: `${scenario}:${definition.trigger.kind}:${phase === 'historical' ? 'earlier' : 'current'}`,
    definition,
    labels: viewLabels,
    source: phase === 'active' ? 'Active' : ['saved', 'stale'].includes(phase) ? 'Saved' : 'Draft',
    revisionLabel:
      phase === 'draft'
        ? 'Proposed changes'
        : phase === 'historical'
          ? 'Run version 2 / current version 3'
          : 'Version 3',
    ...(phase === 'saved'
      ? { notice: 'These saved changes are not active. Version 2 is still used for new runs.' }
      : {}),
    ...(phase === 'stale'
      ? { notice: 'Refresh failed. This is the last loaded version, not a confirmed current view.' }
      : {}),
  };
  if (
    ![
      'queued',
      'running',
      'waiting',
      'completed',
      'failed',
      'blocked',
      'cancelled',
      'skipped',
      'historical',
      'withheld',
    ].includes(phase)
  )
    return base;
  const status =
    phase === 'historical' || phase === 'withheld'
      ? 'completed'
      : phase === 'queued' ||
          phase === 'running' ||
          phase === 'waiting' ||
          phase === 'completed' ||
          phase === 'failed' ||
          phase === 'blocked' ||
          phase === 'cancelled' ||
          phase === 'skipped'
        ? phase
        : 'queued';
  const states: Record<string, WorkflowStepState> = {
    $trigger: status === 'queued' || status === 'skipped' ? 'pending' : 'completed',
  };
  const skipped = new Set(
    scenario === 'branch-no'
      ? ['review']
      : scenario === 'approval'
        ? ['record']
        : scenario === 'nested'
          ? ['record', 'notify']
          : scenario === 'catalog'
            ? ['not_selected']
            : [],
  );
  const steps = definition.steps.filter(step => !skipped.has(step.id));
  const current =
    status === 'waiting'
      ? (steps.find(step => ['human', 'delay', 'wait-until', 'slack-message'].includes(step.kind)) ?? steps[0]!)
      : (steps.find(step => ['transform', 'agent', 'code', 'http', 'find-rows'].includes(step.kind)) ?? steps[0]!);
  const currentIndex = definition.steps.indexOf(current);
  const gates = stepGates(definition.steps);
  for (const [index, step] of definition.steps.entries())
    states[step.id] =
      status === 'queued' || status === 'skipped'
        ? 'pending'
        : skipped.has(step.id) &&
            [...(gates.get(step.id) ?? [])].some(gate =>
              ['completed', 'skipped'].includes(states[gate.split(':')[0]!] ?? ''),
            )
          ? 'skipped'
          : status === 'completed'
            ? 'completed'
            : index < currentIndex
              ? 'completed'
              : index > currentIndex
                ? 'pending'
                : status === 'running'
                  ? 'active'
                  : status === 'waiting'
                    ? 'waiting'
                    : 'unknown';
  if (phase === 'withheld') for (const step of definition.steps) states[step.id] = 'unknown';
  const notes = {
    queued: 'Accepted, but not started. No step is working yet.',
    running: 'Sample run in progress. The highlighted step is working.',
    waiting: 'Waiting at the highlighted step. Later steps have not started.',
    completed: 'The selected path finished. Other branches were not selected.',
    failed: 'The run failed. Its last step has no confirmed outcome.',
    blocked: 'Run authority changed. Work stopped before the next step.',
    cancelled: 'The run was cancelled. Unfinished steps have no confirmed outcome.',
    skipped: 'The trigger was skipped. No steps ran.',
  };
  return {
    ...base,
    source: 'Run',
    run: {
      label: mockPhases[phase],
      status,
      states,
      note:
        phase === 'historical'
          ? 'This run shows its earlier definition, not the current saved workflow.'
          : phase === 'withheld'
            ? 'Step results are unavailable. The definition is still visible.'
            : notes[status],
      ...(['active', 'waiting', 'completed'].includes(states.research ?? '')
        ? {
            task: {
              stepId: 'research',
              title: 'Purchase request recommendation',
              status: states.research === 'completed' ? 'Completed' : 'In progress',
            },
          }
        : {}),
    },
  };
}

if (import.meta.env?.DEV && window.location.pathname.startsWith('/workflow-mock/')) {
  class MockEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly withCredentials = false;
    readonly url: string;
    readyState = 0;
    onopen: EventSource['onopen'] = null;
    onmessage: EventSource['onmessage'] = null;
    onerror: EventSource['onerror'] = null;
    constructor(url: string | URL) {
      super();
      this.url = String(url);
      queueMicrotask(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = MockEventSource as typeof EventSource;
  const workspace = {
    id: mockId,
    slug: 'workflow-mock',
    name: 'Workflow mock',
    status: 'ready',
    createdAt: '2026-10-12T00:00:00Z',
    soulCommit: 'a'.repeat(40),
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!url.pathname.startsWith('/v1/')) return originalFetch(input, init);
    const path = url.pathname,
      method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method !== 'GET') return Response.json({ error: 'workflow-mock-read-only' }, { status: 403 });
    if (path === '/v1/auth/get-session')
      return Response.json({
        session: { id: 'workflow-mock', userId: 'mock' },
        user: { id: 'mock', name: 'Demo user', email: 'mock@example.test' },
      });
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === '/v1/workspaces/workflow-mock') return Response.json(workspace);
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: mockId,
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: false },
      });
    return Response.json({ error: 'not-available-in-workflow-mock' }, { status: 404 });
  };
}
