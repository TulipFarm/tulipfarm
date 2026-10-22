import { rowViewForReceipt } from '@tulipfarm/conversations/row-view';
import { toolPresentation } from '@tulipfarm/conversations/tool-activity';
import { publicWebReceipt } from '@tulipfarm/conversations/public-web';
import { z } from 'zod';
import { planControlSchema, planViewSchema } from '@tulipfarm/agents/plan-contracts';
import { knowledgeMockMessages, knowledgeScenarios } from './knowledge-mock';
import { catalogFixture } from '@/features/models/catalog-fixture';

const id = '11111111-1111-4111-8111-111111111111';
const tableId = '22222222-2222-4222-8222-222222222222';
const fieldId = '33333333-3333-4333-8333-333333333333';
const revision = 'a'.repeat(40);
const workspace = {
  id,
  slug: 'canvas-mock',
  name: 'Canvas mock',
  status: 'ready',
  createdAt: '2026-10-12T00:00:00Z',
  soulCommit: revision,
};
const records = ['Check invoice totals', 'Confirm delivery date', 'Review customer request'].map((name, index) => ({
  id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
  token: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
  values: { [fieldId]: { kind: 'text', value: name } },
}));
export const canvasScenarios = {
  ...knowledgeScenarios,
  'plan-draft': 'Planning: review before starting',
  'plan-blocked': 'Planning: missing prerequisite',
  'plan-verified': 'Planning: verified result',
  web: 'Web search and page reads',
  timeline: 'Mixed activity timeline',
  'timeline-pages': 'Paged activity timeline',
  'timeline-pages-error': 'Paged activity retry',
  running: 'Fetching rows',
  completed: 'Completed read',
  history: 'Past results',
  page: 'Compact page',
  get: 'Single row',
  empty: 'Empty page',
  error: 'Read error',
  failed: 'Failed step',
  blocked: 'Access denied',
  unknown: 'Unconfirmed step',
  'skill-only': 'Hidden skill reads',
};
let scenario = import.meta.env.DEV
  ? (new URLSearchParams(window.location.search).get('scenario') ?? 'running')
  : 'running';
let timelineCompleted = false;
let webCompleted = false;
let knowledgeCompleted = false;
let timelineOlderFailures = 0;
const planTitles = [
  'Create the alert and occurrence table',
  'Set up the triage agent',
  'Connect the Slack intake workflow',
  'Review and activate the setup',
  'Verify the first alert and a repeat',
];
const planKeys = ['records', 'agent', 'intake', 'activation', 'verify'];
function planningFixture() {
  const verified = scenario === 'plan-verified',
    blocked = scenario === 'plan-blocked';
  return planViewSchema.parse({
    id: tableId,
    chatId: id,
    title: 'Observability alert triage',
    brief: 'Track every alert occurrence. Open one GitHub issue for a new alert, then reuse it for repeats.',
    lifecycle: verified ? 'completed' : 'draft',
    version: 0,
    canControl: true,
    createdAt: workspace.createdAt,
    updatedAt: workspace.createdAt,
    outcome: verified ? 'completed' : blocked ? 'waiting' : 'active',
    pause: null,
    budget: { toolCalls: 300, activeMilliseconds: 1800000, credits: 300 },
    specialists: [],
    counts: {
      total: 5,
      pending: verified ? 0 : 4,
      ready: verified || blocked ? 0 : 1,
      running: 0,
      verifying: 0,
      'waiting-input': 0,
      'waiting-approval': 0,
      blocked: blocked ? 1 : 0,
      completed: verified ? 5 : 0,
      failed: 0,
      cancelled: 0,
    },
    planning: {
      requirements: planKeys.slice(0, 4).map((key, index) => ({ key, description: planTitles[index], tasks: [key] })),
      prerequisites: [
        {
          key: 'existing',
          title: 'Existing agents checked',
          tasks: ['agent'],
          status: 'verified',
          evidence: [{ callId: fieldId, summary: 'No matching triage agent in this local fixture.' }],
        },
        {
          key: 'slack',
          title: 'TulipFarm-alerts channel access',
          tasks: ['intake'],
          status: 'verified',
          evidence: [{ callId: fieldId, summary: 'Synthetic channel C_DEMO_ALERTS is available.' }],
        },
        {
          key: 'github',
          title: 'Repository access and issue support',
          tasks: ['records', 'activation'],
          status: blocked ? 'unknown' : 'verified',
          evidence: blocked
            ? []
            : [{ callId: fieldId, summary: 'Synthetic repository access and supported issue actions checked.' }],
          ...(blocked ? { reason: 'Choose a GitHub account before checking repository access.' } : {}),
        },
      ],
      verificationTask: 'verify',
    },
    tasks: planKeys.map((key, index) => ({
      id: `77777777-7777-4777-8777-${String(index + 1).padStart(12, '0')}`,
      key,
      title: planTitles[index],
      parent: null,
      position: index,
      kind: 'work',
      order: 'parallel',
      brief: '',
      criteria: [
        index === 4
          ? 'First alert creates one issue; a repeat records another occurrence without a second issue.'
          : 'Read back the saved resource and confirm its required state.',
      ],
      dependsOn: index === 0 ? [] : index === 4 ? planKeys.slice(0, 4) : [planKeys[index - 1]],
      state: verified ? 'completed' : index === 0 ? (blocked ? 'blocked' : 'ready') : 'pending',
      reason: blocked && index === 0 ? 'Repository access has not been checked.' : null,
      assignee: { kind: 'coordinator' },
      summary: null,
      waitingTaskId: null,
      report: verified
        ? {
            outcome: 'passed',
            summary: 'Checked using synthetic local resources. This is not production evidence.',
            checks: [
              {
                criterion: 0,
                outcome: 'passed',
                evidence: [{ callId: fieldId, summary: 'The expected outcome was read back in the local demo.' }],
              },
            ],
            requirements:
              index === 4
                ? planKeys.slice(0, 4).map(key => ({
                    key,
                    outcome: 'passed',
                    evidence: [{ callId: fieldId, summary: 'The required state was checked in the local demo.' }],
                  }))
                : [],
          }
        : null,
    })),
  });
}
const mockSources = new Set<EventTarget>();
const emitMock = (type: string, data: unknown) => {
  for (const source of mockSources) source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
};

export function completeCanvasMock() {
  if (scenario.startsWith('timeline')) {
    timelineCompleted = true;
    emitMock('tool', {
      turnId: id,
      generation: 0,
      epoch: 0,
      id: tableId,
      tool: 'rows.page',
      sequence: 6,
      status: 'completed',
      presentation: toolPresentation('rows.page'),
    });
  } else if (scenario === 'web') webCompleted = true;
  else if (scenario.startsWith('knowledge')) knowledgeCompleted = true;
  else if (scenario !== 'history') scenario = 'completed';
  const channel = new BroadcastChannel('tulipfarm:query:v1');
  channel.postMessage({
    version: 1,
    id: crypto.randomUUID(),
    sessionId: 'canvas-mock',
    scope: { kind: 'workspace', userId: 'mock', workspaceId: id, membershipId: id },
    kind: 'change',
    keys: [['conversations']],
  });
  channel.close();
}

if (import.meta.env.DEV && window.location.pathname.startsWith('/canvas-mock/')) {
  class MockEventSource extends EventTarget {
    readyState = 0;
    constructor() {
      super();
      mockSources.add(this);
      queueMicrotask(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    close() {
      this.readyState = 2;
      mockSources.delete(this);
    }
  }
  window.EventSource = MockEventSource as unknown as typeof EventSource;
  const originalFetch = window.fetch.bind(window);
  const started = new Date().toISOString();
  const chat = {
    id,
    title: scenario.startsWith('plan-') ? 'Observability alert triage' : 'Review tasks',
    titleRevision: 1,
    archived: false,
    activityAt: started,
    createdAt: started,
  };
  const planning = planningFixture();
  const planCommands = new Map<string, unknown>();
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!url.pathname.startsWith('/v1/')) return originalFetch(input, init);
    const path = url.pathname;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (scenario.startsWith('plan-')) {
      if (path.endsWith(`/agent-plans/${tableId}/control`) && method === 'POST') {
        const control = planControlSchema.parse(await new Request(input instanceof Request ? input : url, init).json());
        if (planCommands.has(control.requestId)) return Response.json(planCommands.get(control.requestId));
        if (control.expectedVersion !== planning.version)
          return Response.json({ error: 'version-conflict' }, { status: 409 });
        planning.lifecycle = control.action === 'stop' ? 'stopped' : control.action === 'pause' ? 'paused' : 'active';
        planning.pause = control.action === 'pause' ? 'starter' : null;
        planning.version++;
        const receipt = { id: tableId, version: planning.version, added: [], yielded: false };
        planCommands.set(control.requestId, receipt);
        return Response.json(receipt);
      }
      if (method === 'GET' && path.endsWith('/plans')) return Response.json({ plans: [planning] });
      if (method === 'GET' && path.endsWith(`/agent-plans/${tableId}`)) return Response.json(planning);
      if (method === 'GET' && path.endsWith('/messages'))
        return Response.json({
          messages: [
            {
              id,
              sequence: 1,
              author: 'human',
              createdAt: started,
              parts: [
                {
                  kind: 'text',
                  text: `${scenario === 'plan-verified' ? 'Create' : 'Plan'} an agent that tracks alerts in TulipFarm-alerts and creates one GitHub issue for each new alert.`,
                },
              ],
              turn: {
                id,
                status: 'completed',
                generation: 0,
                ...(scenario === 'plan-verified' ? {} : { mode: 'plan' }),
              },
              tools: [],
            },
            {
              id: fieldId,
              sequence: 2,
              author: 'assistant',
              createdAt: started,
              parts: [
                {
                  kind: 'text',
                  text:
                    scenario === 'plan-blocked'
                      ? 'Repository access still needs to be checked. The dependent work is blocked.'
                      : scenario === 'plan-verified'
                        ? 'Every required outcome has been checked in this local demo.'
                        : 'The prerequisite checks and deliverable plan are saved. No setup work has started.',
                },
              ],
              turn: null,
              tools: [],
            },
          ],
          nextBefore: null,
          hasGitHubProposals: false,
        });
    }
    const historyWindow =
      method === 'POST' &&
      path === `/v1/workspaces/${id}/conversations/${id}/messages/pages` &&
      scenario.startsWith('timeline')
        ? z
            .object({ before: z.number().nullable(), count: z.number().int().min(1).max(5) })
            .parse(await new Request(input instanceof Request ? input : url, init).json())
        : null;
    if (method !== 'GET' && !historyWindow) return Response.json({ error: 'mock-read-only' }, { status: 403 });
    if (path === '/v1/auth/get-session')
      return Response.json({
        session: { id: 'canvas-mock', userId: 'mock' },
        user: { id: 'mock', name: 'Demo user', email: 'mock@example.test' },
      });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === '/v1/workspaces/canvas-mock') return Response.json(workspace);
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: id,
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: false },
      });
    if (path.endsWith('/model-catalog')) return Response.json(catalogFixture());
    if (path.endsWith('/messages') || historyWindow) {
      if (scenario.startsWith('knowledge'))
        return Response.json({
          messages: knowledgeMockMessages(scenario, knowledgeCompleted, started),
          nextBefore: null,
          hasGitHubProposals: false,
        });
      if (scenario === 'web') {
        const sources = [
          { url: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility', title: 'Accessibility | MDN' },
          { url: 'https://www.w3.org/WAI/standards-guidelines/wcag/', title: 'Web Content Accessibility Guidelines' },
          { url: 'https://github.com/microsoft/playwright', title: 'Playwright on GitHub' },
          { url: 'https://en.wikipedia.org/wiki/Web_accessibility', title: 'Web accessibility' },
          { url: 'https://web.dev/learn/accessibility', title: 'Learn accessibility' },
          {
            url: 'https://example.com/a/very/long/page/address/with/no/title/available?reference=web-search-example',
            title: '',
          },
        ].map(source => ({ ...source, description: '', publishedAt: null }));
        const result = (status: string, selected = sources) => ({
          result: {
            kind: 'public-web',
            status,
            sources: selected,
            pages: [],
            window: 'any',
            widened: false,
            retrievedAt: started,
            untrusted: true,
          },
        });
        const sample = (index: number, tool: string, call: object, output: unknown, status: string) => ({
          id: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
          tool,
          status,
          presentation: toolPresentation(tool),
          web: publicWebReceipt(tool, call, output, status),
        });
        return Response.json({
          messages: [
            {
              id,
              sequence: 1,
              author: 'human',
              createdAt: started,
              parts: [{ kind: 'text', text: 'Find web accessibility guides and read the key pages.' }],
              turn: { id, status: webCompleted ? 'completed' : 'processing', generation: 0 },
              tools: [
                sample(1, 'web.search', { query: 'web accessibility testing guides' }, result('success'), 'completed'),
                sample(2, 'web.fetch', { url: sources[0]!.url }, result('success', [sources[0]!]), 'completed'),
                sample(
                  3,
                  'web.search',
                  { query: 'accessibility guidelines published this morning' },
                  result('empty', []),
                  'completed',
                ),
                sample(4, 'web.fetch', { url: 'https://example.com/unavailable-page' }, null, 'failed'),
                sample(
                  5,
                  'web.fetch',
                  { url: sources[1]!.url },
                  webCompleted ? result('success', [sources[1]!]) : null,
                  webCompleted ? 'completed' : 'running',
                ),
                sample(
                  6,
                  'web.search',
                  { query: 'keyboard navigation testing checklist' },
                  webCompleted ? result('success', [sources[2]!]) : null,
                  webCompleted ? 'completed' : 'running',
                ),
              ],
            },
          ],
          nextBefore: null,
          hasGitHubProposals: false,
        });
      }
      const single = scenario === 'get';
      const tool = single ? 'rows.get' : 'rows.page';
      const status =
        scenario === 'running' || (scenario.startsWith('timeline') && !timelineCompleted)
          ? 'running'
          : scenario === 'failed'
            ? 'failed'
            : scenario === 'blocked'
              ? 'blocked'
              : 'completed';
      const stored = {
        id: tableId,
        tool,
        status,
        call: single
          ? { tool, tableId, expectedAppliedRevision: revision, recordId: records[0]!.id }
          : { tool, tableId, revision },
        output: { result: single ? records[0] : scenario === 'empty' ? [] : records },
      };
      if (scenario.startsWith('timeline')) {
        const sample = (index: number, name: string, activityStatus: string, activity?: string) => ({
          id: `88888888-8888-4888-8888-${String(index).padStart(12, '0')}`,
          tool: name,
          status: ['queued', 'waiting', 'cancelled', 'unknown'].includes(activityStatus) ? 'running' : activityStatus,
          activityStatus,
          activity,
          presentation: toolPresentation(name),
        });
        const messages = [
          {
            id: '66666666-6666-4666-8666-666666666666',
            sequence: 1,
            author: 'human',
            createdAt: '2026-10-12T00:00:00Z',
            parts: [{ kind: 'text', text: 'Find the customer and check team updates.' }],
            turn: null,
            tools: [
              sample(1, 'tables.definitions', 'completed'),
              sample(2, 'rows.get', 'completed'),
              sample(3, 'slack.resolve', 'completed', 'Looking up a Slack channel'),
              sample(4, 'github.personal.read', 'completed'),
              sample(5, 'web.search', 'completed'),
            ],
          },
          {
            id,
            sequence: 2,
            author: 'human',
            createdAt: started,
            parts: [{ kind: 'text', text: 'Show the latest tasks.' }],
            turn: { id, status: timelineCompleted ? 'completed' : 'processing', generation: 0 },
            tools: [
              sample(6, 'mcp.call', 'unknown', 'Checking connector action'),
              sample(7, 'rows.update', 'blocked'),
              sample(8, 'web.fetch', 'failed'),
              sample(9, 'agents.read', 'cancelled'),
              sample(10, 'agents.list', 'queued'),
              sample(11, 'mcp.call', 'waiting', 'Waiting for connector approval'),
              {
                id: tableId,
                tool,
                status,
                activity: 'Fetching task rows',
                ...(timelineCompleted ? { rowView: rowViewForReceipt(stored) } : {}),
              },
            ],
          },
        ];
        const paged = scenario.startsWith('timeline-pages');
        const older = historyWindow
          ? historyWindow.before !== null || historyWindow.count > 1
          : url.searchParams.has('before');
        if (scenario === 'timeline-pages-error' && older && timelineOlderFailures < 4) {
          timelineOlderFailures += 1;
          return Response.json({ error: 'mock-older-page-error' }, { status: 503 });
        }
        if (historyWindow)
          return Response.json({
            chat,
            pages: (historyWindow.before === null
              ? [...messages].reverse().slice(0, historyWindow.count)
              : [messages[0]!]
            ).map(message => ({
              digest: `${timelineCompleted ? 'c'.repeat(63) : 'a'.repeat(63)}${message.sequence}`,
              value: { messages: [message], nextBefore: message.sequence === 1 ? null : 2, hasGitHubProposals: false },
            })),
          });
        return Response.json({
          messages: paged ? [messages[older ? 0 : 1]] : messages,
          nextBefore: paged && !older ? 2 : null,
          hasGitHubProposals: false,
        });
      }
      return Response.json({
        messages: [
          ...(scenario === 'history'
            ? [
                {
                  id: '66666666-6666-4666-8666-666666666666',
                  sequence: 1,
                  author: 'human',
                  createdAt: started,
                  parts: [{ kind: 'text', text: 'Show the delivery task.' }],
                  turn: null,
                  tools: [
                    {
                      id,
                      tool: 'rows.page',
                      status: 'completed',
                      rowView: rowViewForReceipt({
                        id,
                        tool: 'rows.page',
                        status: 'completed',
                        call: { tool: 'rows.page', tableId, revision },
                        output: { result: [records[1]] },
                      }),
                    },
                  ],
                },
              ]
            : []),
          {
            id,
            sequence: 2,
            author: 'human',
            createdAt: started,
            parts: [{ kind: 'text', text: 'Show the latest tasks.' }],
            turn: {
              id,
              status: scenario === 'running' ? 'processing' : scenario === 'failed' ? 'failed' : 'completed',
              generation: 0,
            },
            tools: [
              { id: '77777777-7777-4777-8777-777777777777', tool: 'skills.read', status: 'completed' },
              ...(scenario === 'skill-only'
                ? []
                : [
                    { id: fieldId, tool: 'tables.definitions', status: 'completed' },
                    {
                      id: tableId,
                      tool,
                      status,
                      activity: 'Fetching task rows',
                      ...(scenario === 'unknown' ? { activityStatus: 'unknown' } : {}),
                      ...(status === 'completed' && scenario !== 'unknown'
                        ? { rowView: rowViewForReceipt(stored) }
                        : {}),
                    },
                  ]),
            ],
          },
          ...(scenario === 'running'
            ? []
            : [
                {
                  id: fieldId,
                  sequence: 3,
                  author: 'assistant',
                  createdAt: started,
                  parts: [
                    {
                      kind: 'text',
                      text: scenario === 'skill-only' ? 'I read the procedure.' : 'The results are ready to review.',
                    },
                  ],
                  turn: null,
                  tools: [],
                },
              ]),
        ],
        nextBefore: null,
        hasGitHubProposals: false,
      });
    }
    if (/\/conversations\/[\w-]+$/.test(path)) return Response.json(chat);
    if (path.endsWith(`/tables/${tableId}`))
      return Response.json({
        id: tableId,
        saved: null,
        applied: {
          revision,
          definition: {
            formatVersion: 2,
            id: tableId,
            owningTeamId: id,
            label: 'Tasks',
            fields: [{ id: fieldId, label: 'Title', kind: 'text', required: true, maxLength: 200 }],
            uniqueKeys: [],
          },
          appliedAt: started,
        },
        rowPermissions: { create: false, update: false, delete: false },
      });
    if (path.endsWith(`/tables/${tableId}/rows`)) {
      await new Promise(resolve => window.setTimeout(resolve, 300));
      if (scenario === 'error') return Response.json({ error: 'mock-read-error' }, { status: 503 });
      return Response.json(
        records.filter(record => !url.searchParams.has('ids') || url.searchParams.get('ids')!.includes(record.id)),
      );
    }
    return Response.json({ error: 'not-available-in-canvas-mock' }, { status: 404 });
  };
}
