import type { DefaultKnowledgeIntent } from './default-knowledge-api';

// Dev-only Integrations preview for automatic Knowledge. No provider or server calls; reloading resets state.
if (
  import.meta.env.DEV &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
  window.location.pathname.startsWith('/default-knowledge-mock/')
) {
  const id = '11111111-1111-4111-8111-111111111111';
  const createdAt = '2026-10-16T09:00:00.000Z';
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get('scenario') ?? 'status';
  // `slack=link|recovery|workspace|admin` picks the Slack repair case; `github=two` adds a second login listed first;
  // `atlassian=check-failed` fails the first Atlassian account checks.
  const slackCase = params.get('slack'),
    twoGitHub = params.get('github') === 'two';
  const devId = '88888888-8888-4888-8888-888888888888',
    restId = '66666666-6666-4666-8666-666666666666';
  const failed = scenario === 'failed',
    limits = scenario === 'limits',
    importing = scenario === 'importing';
  const workspace = {
    id,
    slug: 'default-knowledge-mock',
    name: 'Automatic Knowledge demo',
    status: 'ready',
    createdAt,
    soulCommit: 'a'.repeat(40),
  };
  const soon = () => new Date(Date.now() + 4 * 60_000).toISOString();
  const counts = (ready: number, queued = 0, failed = 0, skipped = 0, quotaLimited = 0) => ({
    total: ready + queued + failed + skipped + quotaLimited,
    ready,
    queued,
    failed,
    skipped,
    quotaLimited,
  });
  const intent = (
    n: number,
    product: DefaultKnowledgeIntent['product'],
    accountLabel: string,
    rest: Partial<DefaultKnowledgeIntent>,
  ): DefaultKnowledgeIntent => ({
    intentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    product,
    accountLabel,
    state: 'active',
    syncState: 'ready',
    failure: null,
    discoveredAt: createdAt,
    nextAttemptAt: soon(),
    scopes: { discovered: 0, included: 0, manual: 0 },
    sources: [],
    counts: counts(0),
    groupFailures: [],
    accountKey: `account-${n}`,
    ingestion: { state: 'ready', pending: 0, failed: 0, failure: null },
    ...rest,
  });
  const atlassianRead = scenario === 'atlassian-loading' || scenario === 'atlassian-error';
  const fail = (failure: string) => ({ syncState: 'failed' as const, failure });
  const intents: DefaultKnowledgeIntent[] =
    scenario === 'empty'
      ? []
      : [
          intent(1, 'google-drive', 'ada@example.test', {
            accountKey: 'ada',
            scopes: { discovered: 4, included: 4, manual: 0 },
            ...(failed
              ? { ...fail('account-changed'), counts: counts(1180) }
              : importing
                ? { counts: counts(300), ingestion: { state: 'pending', pending: 2, failed: 0, failure: null } }
                : { counts: counts(1180, 0, 2, 37, 0) }),
          }),
          intent(2, 'gmail', 'ada@example.test', {
            accountKey: 'ada',
            ...(failed
              ? {
                  ...fail('reconnect-required'),
                  scopes: { discovered: 1, included: 1, manual: 0 },
                  counts: counts(640),
                }
              : limits
                ? { ...fail('rate-limited'), scopes: { discovered: 1, included: 1, manual: 0 }, counts: counts(640) }
                : importing
                  ? {
                      scopes: { discovered: 1, included: 1, manual: 0 },
                      counts: counts(640),
                      ingestion: { state: 'failed', pending: 0, failed: 1, failure: 'provider' },
                    }
                  : { syncState: 'discovering', discoveredAt: null, counts: counts(212, 96) }),
          }),
          intent(3, 'slack', '@UADA', {
            accountKey: 'TACME:UADA',
            ...(slackCase
              ? { ...fail('not-linked'), scopes: { discovered: 61, included: 61, manual: 2 }, counts: counts(4200) }
              : failed || limits
                ? {
                    ...fail('quota'),
                    scopes: { discovered: 61, included: 61, manual: 2 },
                    counts: counts(4200, 0, 0, 0, 318),
                  }
                : { syncState: 'queued', discoveredAt: null }),
          }),
          intent(4, 'github', 'ada-dev', {
            accountKey: devId,
            ...(failed
              ? {
                  ...fail('forbidden'),
                  scopes: { discovered: 27, included: 27, manual: 1 },
                  counts: counts(5400, 0, 0, 212, 0),
                }
              : { scopes: { discovered: 27, included: 26, manual: 1 }, counts: counts(5400, 120, 0, 212, 0) }),
          }),
          ...(atlassianRead
            ? []
            : [
                intent(5, 'jira', 'Ada Lovelace', {
                  accountKey: restId,
                  ...(failed
                    ? {
                        ...fail('consent-required'),
                        scopes: { discovered: 12, included: 12, manual: 0 },
                        counts: counts(900),
                      }
                    : limits
                      ? {
                          ...fail('scope-limit'),
                          scopes: { discovered: 2400, included: 2000, manual: 0 },
                          counts: counts(18000),
                        }
                      : {
                          state: 'opted-out',
                          scopes: { discovered: 12, included: 12, manual: 0 },
                          counts: counts(900),
                        }),
                }),
                intent(6, 'confluence', 'Ada Lovelace', {
                  accountKey: restId,
                  scopes: { discovered: 9, included: 9, manual: 0 },
                  counts: counts(2300),
                  ...(failed
                    ? fail('insufficient-scope')
                    : limits
                      ? fail('not-found')
                      : {
                          groupFailures: [
                            { title: 'Acme Finance', failure: 'forbidden' },
                            { title: 'Acme Labs', failure: 'insufficient-scope' },
                          ],
                        }),
                }),
              ]),
        ];
  const atlassianAccounts = [
    {
      id: '55555555-5555-4555-8555-555555555555',
      protocol: 'atlassian-mcp',
      ownership: 'personal',
      state: 'active',
      configured: true,
      identity: { id: 'mcp', label: 'Atlassian MCP grant', qualification: 'grant-bound-needs-qualification' },
      resources: [],
      scopes: [],
      generation: 1,
      grantsVersion: 1,
      capabilities: { read: true, manage: true, use: true },
    },
    ...(scenario === 'empty'
      ? []
      : [
          {
            id: restId,
            protocol: 'atlassian-rest',
            ownership: 'personal',
            state: 'active',
            configured: true,
            identity: { id: 'acc-1', label: 'Ada Lovelace', qualification: 'verified' },
            resources: [],
            scopes: ['read:me', 'read:jira-work', 'offline_access'],
            generation: 1,
            grantsVersion: 1,
            capabilities: { read: true, manage: true, use: true },
          },
        ]),
  ];
  const google = {
    status: 'connected',
    integrationId: '77777777-7777-4777-8777-777777777777',
    generation: 1,
    ...(failed
      ? { accountId: 'ada-work', email: 'ada.work@example.test' }
      : { accountId: 'ada', email: 'ada@example.test' }),
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.modify'],
  };
  let listReads = 0,
    accountReads = 0;
  const originalFetch = window.fetch.bind(window);
  class MockEvents extends EventTarget {
    readyState = 1;
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = MockEvents as unknown as typeof EventSource;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/v1/'))
      return originalFetch(input, init);
    const path = url.pathname,
      method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    await new Promise(resolve => window.setTimeout(resolve, 80));
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (path === '/v1/auth/get-session')
      return Response.json({
        session: { id: 'default-knowledge-mock', userId: 'demo' },
        user: { id: 'demo', name: 'Ada Lovelace', email: 'ada@example.test' },
      });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === `/v1/workspaces/${workspace.slug}`) return Response.json(workspace);
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: id,
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
      });
    if (path.endsWith('/knowledge/defaults')) {
      listReads++;
      if (scenario === 'loading') await new Promise(() => undefined);
      if (scenario === 'error' && listReads <= 3)
        return Response.json({ error: 'knowledge-unavailable' }, { status: 503 });
      return Response.json({ enabled: scenario !== 'off', items: scenario === 'off' ? [] : intents });
    }
    const managed = path.match(/\/knowledge\/defaults\/([^/]+)\/manage$/);
    if (managed && method === 'POST') {
      const target = intents.find(item => item.intentId === managed[1]);
      if (!target) return Response.json({ error: 'knowledge-not-found' }, { status: 404 });
      const { action } = JSON.parse(String(init?.body)) as { action: string };
      await new Promise(resolve => window.setTimeout(resolve, 1200));
      if (action === 'opt-out') target.state = 'opted-out';
      else {
        target.state = 'active';
        target.syncState = 'queued';
        target.failure = null;
        target.nextAttemptAt = new Date().toISOString();
        if (target.ingestion.state === 'failed')
          target.ingestion = { state: 'pending', pending: target.ingestion.failed, failed: 0, failure: null };
      }
      return Response.json(target);
    }
    if (path === '/v1/google-workspace/availability') return Response.json({ configured: true });
    if (path.endsWith('/google-workspace')) return Response.json(google);
    // Repairs return each provider's real consent origin, which the app validates before leaving the demo.
    if (path.endsWith('/google-workspace/begin') && method === 'POST')
      return Response.json({
        authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?client_id=tulipfarm-demo&app=${url.searchParams.get('app')}`,
      });
    if (path.endsWith('/slack/install') && method === 'POST')
      return Response.json({ url: 'https://slack.com/oauth/v2/authorize?client_id=tulipfarm-demo' });
    const reconnect = path.match(/\/(github|atlassian)\/accounts\/([^/]+)\/reconnect$/);
    if (reconnect && method === 'POST')
      return Response.json({
        accountId: reconnect[2],
        url:
          reconnect[1] === 'github'
            ? `https://github.com/login/oauth/authorize?client_id=tulipfarm-demo&account=${reconnect[2]}`
            : `https://auth.atlassian.com/authorize?client_id=tulipfarm-demo&account=${reconnect[2]}`,
      });
    if (path.endsWith('/slack/status'))
      return Response.json({
        state: slackCase === 'workspace' || slackCase === 'admin' ? 'reconnect-required' : 'active',
        teamId: 'TACME',
        canManage: slackCase === 'workspace',
        linked: slackCase !== 'recovery',
        scopes: [],
        ...(slackCase === 'recovery' ? { recoveryEventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } : {}),
      });
    if (path.endsWith('/github/accounts'))
      return Response.json({
        configured: true,
        accounts: [
          ...(twoGitHub
            ? [
                {
                  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  state: 'active',
                  configured: true,
                  identity: { id: '102', login: 'ada-work' },
                  generation: 1,
                  scopes: ['repo', 'read:user'],
                },
              ]
            : []),
          {
            id: devId,
            state: 'active',
            configured: true,
            identity: { id: '101', login: 'ada-dev' },
            generation: 1,
            scopes: ['repo', 'read:user'],
          },
        ],
      });
    if (path.endsWith('/atlassian/accounts')) {
      accountReads++;
      if (scenario === 'atlassian-loading') await new Promise(() => undefined);
      if ((scenario === 'atlassian-error' || params.get('atlassian') === 'check-failed') && accountReads <= 3)
        return Response.json({ error: 'atlassian-unavailable' }, { status: 503 });
    }
    if (path.endsWith('/atlassian/accounts'))
      return Response.json({
        accounts: atlassianAccounts,
        providers: [
          { protocol: 'atlassian-mcp', configured: true },
          { protocol: 'atlassian-rest', configured: true },
          { protocol: 'trello', configured: false },
        ],
      });
    if (path.endsWith('/knowledge/atlassian/sources')) return Response.json({ items: jiraSources() });
    if (/\/knowledge\/atlassian\/sources\/[^/]+\/documents$/.test(path))
      return Response.json({ items: [], nextCursor: null });
    if (path.endsWith('/atlassian/sources'))
      return Response.json({
        sources: [],
        mcp: { enabled: true, explanation: 'Jira and Confluence tools are available in chat.' },
      });
    if (/\/knowledge\/(?:google|slack|github|atlassian)\/sources$/.test(path)) return Response.json({ items: [] });
    if (path.endsWith('/integrations')) return Response.json({ integrations: [] });
    if (path.endsWith('/workspace-mcp/capabilities'))
      return Response.json({
        enabled: false,
        canManageShared: false,
        integrationsEnabled: false,
        dispatchEnabled: false,
      });
    if (path.endsWith('/bud'))
      return Response.json({
        conversationId: null,
        onboarding: 'skipped',
        bubblesEnabled: false,
        snoozedUntil: null,
        nudge: null,
        preferences: [],
      });
    if (path.endsWith('/conversations')) return Response.json({ chats: [], nextCursor: null });
    if (path.endsWith('/skills')) return Response.json({ workspace: [], nextCursor: null });
    if (path.endsWith('/tables')) return Response.json({ tables: [], nextCursor: null });
    if (path.endsWith('/last-used') || path.endsWith('/recommendations/events'))
      return new Response(null, { status: 204 });
    return Response.json({ error: 'not-available-in-default-knowledge-demo' }, { status: 404 });
  };
}

const jiraCloud = '7f0c2a4e-1b3d-4c5e-8f6a-9b0c1d2e3f4a';
const jiraSource = (
  n: number,
  key: string,
  title: string,
  sync: 'queued' | 'syncing' | 'ready' | 'failed',
  counts: { total: number; ready: number; failed: number } | null,
  failure: string | null = null,
) => ({
  sourceId: `5a5a5a5a-5a5a-4a5a-8a5a-00000000000${n}`,
  product: 'jira',
  selection: {
    product: 'jira',
    cloudId: jiraCloud,
    targets: [{ kind: 'project', id: `1000${n}`, descendants: false }],
  },
  memberIds: Array.from({ length: n === 2 ? 3 : 1 }, (_, i) => `6b6b6b6b-6b6b-4b6b-8b6b-00000000000${i}`),
  title,
  state: 'active',
  syncState: sync,
  failure,
  nextAttemptAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  targets: [{ kind: 'project', id: `1000${n}`, key, title, descendants: false, state: 'active', failure: null }],
  counts,
  canManage: true,
});
const jiraSources = () => [
  jiraSource(1, 'ENG', 'Engineering', 'ready', { total: 1_284, ready: 1_284, failed: 0 }),
  jiraSource(2, 'OPS', 'Operations', 'syncing', { total: 412, ready: 268, failed: 0 }),
  jiraSource(3, 'SUP', 'Customer support', 'ready', { total: 2_031, ready: 1_998, failed: 33 }),
  jiraSource(4, 'MKT', 'Marketing', 'queued', null),
];
