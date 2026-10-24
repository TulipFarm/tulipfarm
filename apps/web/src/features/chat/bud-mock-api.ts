import { budCommandSchema, type BudState } from '@tulipfarm/conversations/bud-contracts';
import { createChatsMock } from './chats-mock-api';
import { createWorkflowChatMock } from './workflow-chat-mock-api';
import { createGoogleResultsMock } from './google-results-mock-api';
import { createConnectorResultsMock } from './connector-results-mock-api';
import type { ConversationMessage } from './conversation-api';
import { catalogFixture } from '@/features/models/catalog-fixture';

function installBudMock() {
  const start = new URLSearchParams(window.location.search).get('start');
  const chatsMock = start?.startsWith('chats') ? createChatsMock(start) : null;
  const workflowMock = start?.startsWith('workflow') ? createWorkflowChatMock(start) : null;
  const googleMock = start?.startsWith('connector-results')
    ? createConnectorResultsMock(start)
    : start?.startsWith('slides')
      ? createGoogleResultsMock(start)
      : null;
  const id = '99999999-9999-4999-8999-999999999999';
  const chatId = start === 'compaction' ? '23232323-2323-4323-8323-232323232323' : id;
  const createdAt = new Date().toISOString();
  const workspace = {
    id,
    slug: 'bud-mock',
    name: start ? 'TulipFarm demo' : 'Bud demo',
    status: 'ready',
    createdAt,
    soulCommit: 'a'.repeat(40),
  };
  const chat = {
    id: chatId,
    title: start === 'compaction' ? 'Pitch deck handoff' : 'Bud',
    titleRevision: 1,
    titleManual: true,
    archived: false,
    activityAt: createdAt,
    createdAt,
  };
  let state: BudState = {
    conversationId: id,
    onboarding: 'ineligible',
    bubblesEnabled: true,
    snoozedUntil: null,
    preferences: [],
    nudge: start
      ? null
      : {
          fingerprint: 'a'.repeat(64),
          suggestionId: 'personalize-bud',
          presented: true,
          question: 'Would you like to set how Bud replies to you?',
          action: { kind: 'prompt', prompt: 'Set how Bud replies to me.' },
        },
  };
  const setup = [
    {
      id: 'personalize-bud',
      kind: 'onboarding',
      label: 'Set how Bud replies to you',
      brands: [],
      action: { kind: 'prompt', prompt: 'Help me set how Bud replies to me.' },
    },
    {
      id: 'slack-sources',
      kind: 'onboarding',
      label: 'Choose Slack channels for knowledge',
      brands: ['slack'],
      action: { kind: 'open', destination: 'integrations', sourcePicker: 'slack' },
    },
    {
      id: 'google-sources',
      kind: 'onboarding',
      label: 'Choose Google sources for knowledge',
      brands: [],
      action: { kind: 'open', destination: 'integrations', sourcePicker: 'google' },
    },
    {
      id: 'add-knowledge',
      kind: 'onboarding',
      label: 'Add knowledge about your business',
      brands: [],
      action: { kind: 'open', destination: 'files' },
    },
    {
      id: 'invite-teammate',
      kind: 'onboarding',
      label: 'Invite a teammate',
      brands: [],
      action: { kind: 'open', destination: 'members' },
    },
  ];
  const tasks = [
    'Plan customer follow-ups',
    'Draft a support reply',
    'Plan my week',
    'Prepare a daily team update',
    'Write down a business process',
  ].map((label, index) => ({
    id: `demo-${index}`,
    kind: 'prompt',
    label,
    brands: [],
    action: { kind: 'prompt', prompt: label },
  }));
  let recommendationReads = 0;
  const messages: ConversationMessage[] = [];
  const message = (author: 'human' | 'assistant', text: string) =>
    messages.push({
      id: crypto.randomUUID(),
      sequence: messages.length + 1,
      author,
      createdAt: new Date().toISOString(),
      parts: [{ kind: 'text', text }],
      turn: null,
      tools: [],
      calendarResults: [],
    });
  if (start === 'compaction') {
    const compacted = (trigger: 'inactivity' | 'manual') =>
      messages.push({
        id: crypto.randomUUID(),
        sequence: messages.length + 1,
        author: 'assistant',
        createdAt,
        turn: null,
        tools: [],
        calendarResults: [],
        parts: [
          {
            kind: 'compaction',
            compactionId: crypto.randomUUID(),
            trigger,
            state: 'compacted',
            beforeTokens: 12000,
            afterTokens: 2000,
            windowTokens: 32000,
            errorCode: null,
            handoffStatus: 'completed',
          },
        ],
      });
    message('human', 'Help me prepare the TulipFarm pitch deck.');
    message('assistant', 'The outline is ready: the problem, our product, customer traction, and the funding plan.');
    compacted('inactivity');
    message('human', 'Keep the customer traction and financing terms for the handoff.');
    message('assistant', 'I have kept those points in the working summary. Your earlier messages stay in this chat.');
    compacted('manual');
  }
  class DemoEventSource extends EventTarget {
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
        const event = new Event('open');
        this.dispatchEvent(event);
      });
    }
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = DemoEventSource as typeof EventSource;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!url.pathname.startsWith('/v1/')) return originalFetch(input, init);
    const path = url.pathname;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const chatsResponse = await chatsMock?.(url, method, input, init);
    if (chatsResponse) return chatsResponse;
    const workflowResponse = await workflowMock?.(url, method, input, init);
    if (workflowResponse) return workflowResponse;
    const googleResponse = await googleMock?.(url, method, input, init);
    if (googleResponse) return googleResponse;
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (start && path === '/v1/workspaces/bud-mock/last-used' && method === 'PUT')
      return new Response(null, { status: 204 });
    if (path.endsWith('/bud')) {
      if (method === 'POST') {
        const value =
          typeof init?.body === 'string' ? JSON.parse(init.body) : input instanceof Request ? await input.json() : null;
        const parsed = budCommandSchema.safeParse(value);
        if (!parsed.success) return Response.json({ error: 'invalid-request' }, { status: 400 });
        const command = parsed.data;
        if (command.kind === 'open-nudge' && state.nudge) {
          message('human', 'Set how Bud replies to me.');
          state = {
            ...state,
            nudge: null,
            preferences: [
              {
                id,
                conversationId: id,
                topic: 'reply-style',
                question: 'Which reply style works for you?',
                value: null,
                status: 'asking',
                expectedRevision: 0,
                savedRevision: null,
              },
            ],
          };
        } else if (command.kind === 'answer-preference') {
          state = {
            ...state,
            preferences: state.preferences.map(item => ({
              ...item,
              value: command.value,
              status: 'saved',
              savedRevision: 1,
            })),
          };
        } else if (command.kind === 'undo-preference' || command.kind === 'dismiss-preference')
          state = { ...state, preferences: [] };
        else if (command.kind === 'dismiss') state = { ...state, nudge: null };
        else if (!['open', 'sync', 'bootstrap'].includes(command.kind))
          return Response.json({ error: 'not-available-in-bud-demo' }, { status: 400 });
      }
      return Response.json(state);
    }
    if (method === 'PUT' && /\/conversations\/[^/]+\/messages\/[^/]+$/.test(path)) {
      return Response.json({ error: 'demo-has-no-live-model' }, { status: 409 });
    }
    if (method !== 'GET') return Response.json({ error: 'not-available-in-bud-demo' }, { status: 403 });
    if (path === '/v1/auth/get-session')
      return Response.json({
        session: { id: 'bud-mock', userId: 'bud-mock' },
        user: { id: 'bud-mock', name: start ? 'Dhruv' : 'Demo user', email: 'demo@example.test' },
      });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === '/v1/workspaces/bud-mock') return Response.json(workspace);
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: id,
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: false },
      });
    if (path.endsWith('/credits'))
      return Response.json({ available: 100, granted: 100, used: 0, held: 0, days: [], breakdown: [], series: [] });
    if (start) {
      if ((start === 'result-cards' || start === 'compaction') && path.endsWith('/github/accounts'))
        return Response.json({ configured: false, accounts: [] });
      if (path.endsWith('/projects')) return Response.json([]);
      if (path.endsWith('/skills')) return Response.json({ workspace: [], nextCursor: null });
      if (path.endsWith('/google-workspace/availability')) return Response.json({ configured: false });
      if (path.endsWith('/slack/status'))
        return Response.json({ state: 'disconnected', canManage: false, linked: false, scopes: [] });
      if (path.endsWith('/github/accounts'))
        return Response.json({
          configured: true,
          accounts: [
            {
              id,
              configured: true,
              state: 'reconnect-required',
              generation: 1,
              scopes: ['repo'],
              identity: { id: '42', login: 'demo' },
            },
          ],
        });
      if (path.endsWith('/atlassian/accounts')) return Response.json({ accounts: [], providers: [] });
      if (path.endsWith('/workspace-mcp/capabilities')) return Response.json({ enabled: false });
    }
    if (path.endsWith('/model-catalog')) return Response.json(catalogFixture());
    if (start && path.endsWith('/recommendations')) {
      recommendationReads++;
      if (start === 'loading') await new Promise(resolve => setTimeout(resolve, 2000));
      if (start === 'error' && recommendationReads <= 4)
        return Response.json({ error: 'demo-recommendations-unavailable' }, { status: 503 });
      return Response.json({
        onboarding: start !== 'empty',
        status: 'ready',
        version: 1,
        items:
          start === 'empty'
            ? []
            : start === 'mixed'
              ? [...tasks.slice(0, 3), ...setup.slice(1, 3)]
              : start === 'sparse'
                ? [tasks[0], ...setup.slice(0, 4)]
                : setup,
      });
    }
    if (path.endsWith('/recommendations'))
      return Response.json({ onboarding: false, status: 'ready', version: 1, items: tasks });
    if (start === 'compaction' && path.endsWith(`/conversations/${chatId}/maintenance`))
      return Response.json({ maintenance: null });
    if (path.endsWith(`/conversations/${chatId}/messages`))
      return Response.json({ messages, nextBefore: null, hasGitHubProposals: false });
    if (path.endsWith(`/conversations/${chatId}`)) return Response.json(chat);
    if (path.endsWith('/conversations')) return Response.json({ chats: [chat], nextCursor: null });
    return Response.json({ error: 'not-available-in-bud-demo' }, { status: 404 });
  };
}

if (
  import.meta.env.DEV &&
  (window.location.pathname === '/bud-mock' || window.location.pathname.startsWith('/bud-mock/'))
)
  installBudMock();
