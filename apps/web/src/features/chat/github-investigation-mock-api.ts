import { investigationChoicesSchema, selectInvestigationSchema } from '@tulipfarm/github/investigation-contracts';
import { toolPresentation } from '@tulipfarm/conversations/tool-activity';
import { integrationDetailSchema, integrationGrantsSchema } from '@tulipfarm/integrations/contracts';
import { catalogFixture } from '@/features/models/catalog-fixture';

if (
  import.meta.env.DEV &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
  window.location.pathname.startsWith('/github-investigation-mock/')
) {
  const id = '11111111-1111-4111-8111-111111111111';
  const personalId = '22222222-2222-4222-8222-222222222222';
  const teamId = '33333333-3333-4333-8333-333333333333';
  const sourceId = '44444444-4444-4444-8444-444444444444';
  const createdAt = '2026-10-13T10:30:00.000Z';
  const parameters = new URLSearchParams(window.location.search);
  const scenario = parameters.get('scenario') ?? 'choice';
  const slowResponse =
    scenario === 'slow' && parameters.has('hold')
      ? new Promise<void>(resolve =>
          window.addEventListener('github-investigation-ready', () => resolve(), { once: true }),
        )
      : null;
  const workspace = {
    id,
    slug: 'github-investigation-mock',
    name: 'GitHub investigation demo',
    status: 'ready',
    createdAt,
    soulCommit: 'a'.repeat(40),
  };
  const chat = {
    id,
    title: 'Investigate checkout failures',
    titleRevision: 1,
    archived: false,
    activityAt: createdAt,
    createdAt,
  };
  const choices = [
    { kind: 'personal' as const, id: personalId, generation: 1, name: 'dev-user' },
    { kind: 'team' as const, id: teamId, generation: 2, name: 'Engineering repositories' },
  ];
  let selection = investigationChoicesSchema.parse({
    investigation: ['selected', 'partial', 'completed', 'end-error-empty'].includes(scenario),
    version: 1,
    selected: ['selected', 'partial', 'completed'].includes(scenario) ? choices[1] : null,
    choices: ['empty', 'end-error-empty'].includes(scenario) ? [] : choices,
  });
  let failures = 0;
  let investigationReads = 0;
  let generation = 0;
  let taskStatus = 'waiting-clarification';
  const metadata = {
    id: teamId,
    owningTeamId: id,
    name: 'Engineering repositories',
    enabled: true,
    generation: 2,
    grantsVersion: 1,
    capabilities: { read: true, use: true, manage: true, administer: true },
  };
  let integration = integrationDetailSchema.parse({
    ...metadata,
    repositories: [{ id: sourceId, owner: 'example', repo: 'web', canReadIssues: true }],
    grants: [{ teamId: id, permissions: ['read', 'use', 'manage'] }],
    sourceGrants: [{ teamId: id, sourceId }],
    personGrants: [],
    sourcePersonGrants: [],
    investigationGrants: [{ teamId: id, sourceId, permissions: ['github.code.read', 'github.issues.read'] }],
    investigationPersonGrants: [],
  });
  const answer =
    scenario === 'partial'
      ? 'The web repository calls the shared payment library. Its source confirms the missing timeout. Actions logs were rate-limited, so the runtime cause is not proven. Retry the same source later.'
      : scenario === 'completed'
        ? 'The checkout path passes an empty currency to the payment library. This matches the failed check output. See the linked files in example/web and example/payments. Reading this evidence did not reproduce the production failure.'
        : 'Choose a personal account or team integration in the card. I will read only permitted repositories and make no changes.';
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
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (path === '/v1/auth/get-session')
      return Response.json({
        session: { id: 'github-investigation-mock', userId: 'demo' },
        user: { id: 'demo', name: 'Demo engineer', email: 'demo@example.test' },
      });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === `/v1/workspaces/${workspace.slug}`) return Response.json(workspace);
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: id,
        role: 'admin',
        teams: [{ id, name: 'Engineering' }],
        capabilities: { manageGovernance: true, canLeave: false },
      });
    if (path.endsWith('/model-catalog')) return Response.json(catalogFixture());
    if (path.endsWith('/investigation')) {
      if (method === 'GET') document.documentElement.dataset.investigationReads = String(++investigationReads);
      if (scenario === 'slow') await (slowResponse ?? new Promise(resolve => window.setTimeout(resolve, 1600)));
      if (scenario === 'denied') return Response.json({ error: 'investigation-unavailable' }, { status: 404 });
      if (scenario === 'error' && failures++ < 3)
        return Response.json({ error: 'investigation-unavailable' }, { status: 503 });
      if (method === 'PUT') {
        const body = selectInvestigationSchema.parse(JSON.parse(String(init?.body)));
        if (body.expectedVersion !== selection.version)
          return Response.json({ error: 'selection-conflict' }, { status: 409 });
        if (['save-error', 'end-error-empty'].includes(scenario))
          return Response.json({ error: 'selection-conflict' }, { status: 409 });
        selection = {
          ...selection,
          investigation: body.investigation,
          version: selection.version + 1,
          selected: choices.find(choice => choice.id === body.choice?.id && choice.kind === body.choice.kind) ?? null,
        };
        generation++;
      }
      return Response.json(selection);
    }
    if (path.endsWith('/github/accounts'))
      return Response.json({
        configured: true,
        accounts: [
          {
            id: personalId,
            generation: 1,
            state: 'active',
            configured: true,
            identity: { id: '101', login: 'dev-user' },
            scopes: ['repo'],
          },
        ],
      });
    if (path.endsWith('/selection'))
      return Response.json({ accountId: null, generation: null, version: selection.version });
    if (path.endsWith('/batches')) return Response.json({ batches: [] });
    if (path.endsWith('/integrations'))
      return Response.json({ integrations: [{ ...metadata, grantsVersion: integration.grantsVersion }] });
    if (path.endsWith(`/integrations/${teamId}`)) return Response.json(integration);
    if (path.endsWith('/integrations/collaborators'))
      return Response.json({ teams: [{ id, name: 'Engineering' }], members: [{ id, name: 'Demo engineer' }] });
    if (path.endsWith('/integrations/creation-context')) return Response.json({ teams: [{ id, name: 'Engineering' }] });
    if (path.endsWith(`/integrations/${teamId}/grants`) && method === 'PUT') {
      const { expectedGrantsVersion, ...grants } = integrationGrantsSchema.parse(JSON.parse(String(init?.body)));
      if (expectedGrantsVersion !== integration.grantsVersion)
        return Response.json({ error: 'conflict' }, { status: 409 });
      integration = integrationDetailSchema.parse({
        ...integration,
        ...grants,
        grantsVersion: integration.grantsVersion + 1,
      });
      return Response.json(integration);
    }
    if (path.endsWith('/governance/directory'))
      return Response.json({
        members: [{ id, name: 'Demo engineer', email: 'demo@example.test', image: null }],
        teams: [{ id, name: 'Engineering' }],
      });
    if (/\/agent-tasks\/[^/]+\/pause$/.test(path)) {
      taskStatus = 'paused';
      return Response.json({ id, generation, status: taskStatus });
    }
    if (/\/agent-tasks\/[^/]+\/(?:continue|retry)$/.test(path)) {
      taskStatus = 'completed';
      return Response.json({ id, generation, status: taskStatus });
    }
    if (/\/agent-tasks\/[^/]+\/history$/.test(path))
      return Response.json({
        messages: [{ sequence: 0, generation, role: 'agent', text: answer, sources: [], createdAt }],
        nextCursor: null,
      });
    if (/\/agent-tasks\/[^/]+\/proposals$/.test(path)) return Response.json({ proposals: [], nextCursor: null });
    if (/\/agent-tasks\/[^/]+$/.test(path))
      return Response.json({
        id,
        generation,
        status: taskStatus,
        pauseReason: null,
        agentId: id,
        activationId: id,
        definitionRevision: 'a'.repeat(64),
        parentTaskId: null,
        delegationDepth: 0,
        skills: [{ id: 'github-investigation', revision: 'latest' }],
        scope: [],
        limits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
        flowId: id,
        activeMilliseconds: '1200',
        toolCalls: 1,
        createdAt,
        cost: { chargedCreditUnits: '0', heldCreditUnits: '0' },
        activity: [],
      });
    if (path.endsWith('/messages') && method === 'GET')
      return Response.json({
        messages: [
          {
            id,
            sequence: 1,
            author: 'human',
            createdAt,
            parts: [{ kind: 'text', text: 'Investigate checkout failures across the web and payment repositories.' }],
            turn: { id, status: 'completed', generation: 0 },
            tools: [
              {
                id: sourceId,
                tool: 'github.investigation.account',
                status: 'completed',
                presentation: toolPresentation('github.investigation.account'),
              },
            ],
          },
          {
            id: personalId,
            sequence: 2,
            author: 'assistant',
            createdAt,
            parts: [{ kind: 'text', text: answer }],
            turn: null,
            tools: [],
          },
        ],
        nextBefore: null,
        hasGitHubProposals: false,
      });
    if (/\/messages\/[^/]+$/.test(path) && method === 'PUT')
      return Response.json({ messageId: path.split('/').at(-1), turnId: sourceId, sequence: 3 });
    if (/\/turns\/[^/]+\/cancel$/.test(path))
      return Response.json({ turnId: sourceId, generation: 0, status: 'cancelled' });
    if (/\/conversations\/[^/]+$/.test(path)) return Response.json(chat);
    if (path.endsWith('/conversations')) return Response.json({ chats: [chat], nextCursor: null });
    if (path.endsWith('/workspace-mcp/capabilities'))
      return Response.json({
        enabled: false,
        canManageShared: false,
        integrationsEnabled: false,
        dispatchEnabled: false,
      });
    if (path.endsWith('/google-workspace/availability')) return Response.json({ configured: false });
    if (path.endsWith('/google-workspace')) return Response.json({ status: 'disconnected' });
    if (path.endsWith('/slack/status'))
      return Response.json({ state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] });
    if (path.endsWith('/atlassian/accounts')) return Response.json({ accounts: [], providers: [] });
    if (path.endsWith('/skills')) return Response.json({ workspace: [], nextCursor: null });
    if (path.endsWith('/tables')) return Response.json({ tables: [], nextCursor: null });
    return Response.json({ error: 'not-available-in-investigation-demo' }, { status: 404 });
  };
}
