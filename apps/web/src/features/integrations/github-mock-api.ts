import type { GitHubAccount } from '@/lib/github';
import type { GitHubRepositoryChoice, GitHubSource } from './github-knowledge-api';

export const githubMockEnabled =
  import.meta.env.DEV &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
  window.location.pathname === '/seed-github-ux/integrations' &&
  new URLSearchParams(window.location.search).has('githubMock');

if (githubMockEnabled) {
  const scenario = new URLSearchParams(window.location.search).get('githubMock');
  const id = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  const accounts: GitHubAccount[] = [
    {
      id,
      state: 'active',
      configured: true,
      identity: { id: '101', login: 'dev-user' },
      generation: 1,
      scopes: ['repo', 'read:org', 'read:user'],
    },
    ...(scenario === 'multiple'
      ? [
          {
            id: secondId,
            state: 'active' as const,
            configured: true,
            identity: { id: '102', login: 'dev-work' },
            generation: 1,
            scopes: ['repo', 'read:org', 'read:user'],
          },
        ]
      : []),
    ...(scenario === 'pending'
      ? [
          {
            id: secondId,
            state: 'reconnect-required' as const,
            configured: true,
            identity: null,
            generation: 1,
            scopes: [],
          },
        ]
      : []),
  ];
  const repositories: GitHubRepositoryChoice[] = [
    ...Array.from({ length: 247 }, (_, index) => ({
      repositoryId: String(index + 1),
      fullName: `dev-user/project-${String(index + 1).padStart(3, '0')}`,
      visibility: index % 3 ? ('private' as const) : ('public' as const),
      title: `Personal project ${index + 1}`,
    })),
    ...[
      'design-system',
      'docs',
      'integrations',
      'packages',
      'pitch',
      'project',
      'skills',
      'telemetry-collector',
      'tulipfarm',
      'tulipfarm-cloud',
      'tulipfarm-dark',
      'website',
      'workflows',
    ].map((name, index) => ({
      repositoryId: String(1000 + index),
      fullName: `TulipFarm/${name}`,
      visibility: index % 2 ? ('private' as const) : ('public' as const),
      title: name,
    })),
  ];
  const workRepositories: GitHubRepositoryChoice[] = [
    { repositoryId: '2000', fullName: 'WorkTeam/handbook', visibility: 'private', title: 'Team handbook' },
  ];
  const sources: GitHubSource[] = [];
  const originalFetch = window.fetch.bind(window);
  let failedOnce = false;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const path = url.pathname;
    if (
      window.location.pathname !== '/seed-github-ux/integrations' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !/^\/v1\/workspaces\/[^/]+\/(?:github\/accounts|knowledge\/github)(?:\/|$)/.test(path)
    )
      return originalFetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    await new Promise(resolve => window.setTimeout(resolve, scenario === 'slow' ? 700 : 100));
    signal?.throwIfAborted();
    if (path.endsWith('/github/accounts') && method === 'GET') return Response.json({ configured: true, accounts });
    if (path.endsWith('/disconnect')) {
      const account = accounts.find(item => path.includes(item.id));
      if (!account) return Response.json({ error: 'account-not-found' }, { status: 404 });
      account.state = 'disconnected';
      return Response.json({ account, providerRevocation: 'manual-required' });
    }
    if (path.endsWith('/begin') || path.endsWith('/reconnect'))
      return Response.json({ error: 'account-disabled' }, { status: 409 });
    if (path.endsWith('/members'))
      return Response.json({ members: [{ id: secondId, name: 'Mia Member', email: 'mia.member@tulipfarm.test' }] });
    if (path.endsWith('/discover')) {
      if (scenario === 'error' && !failedOnce) {
        failedOnce = true;
        return Response.json({ error: 'github-rate-limited' }, { status: 429 });
      }
      if (scenario === 'reconnect') return Response.json({ error: 'github-reconnect-required' }, { status: 409 });
      const account = accounts.find(item => item.id === url.searchParams.get('accountId'));
      if (!account?.identity || account.state !== 'active')
        return Response.json({ error: 'github-not-linked' }, { status: 409 });
      const page = Number(url.searchParams.get('cursor') ?? 1);
      const all = scenario === 'empty' ? [] : account.id === secondId ? workRepositories : repositories;
      return Response.json({
        binding: {
          accountId: account.id,
          accountGeneration: account.generation,
          githubUserId: account.identity.id,
          login: account.identity.login,
        },
        items: all.slice((page - 1) * 50, page * 50),
        nextCursor: all.length > page * 50 ? String(page + 1) : null,
      });
    }
    if (path.endsWith('/sources') && method === 'GET') return Response.json({ items: sources });
    if (path.endsWith('/sources') && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      const existing = sources.find(source => source.sourceId === body.commandId);
      if (existing) return Response.json(existing);
      const source: GitHubSource = {
        sourceId: body.commandId,
        title:
          body.selection.repositories.length === 1
            ? body.selection.repositories[0]
            : `${body.selection.repositories[0]} and ${body.selection.repositories.length - 1} more`,
        selection: body.selection,
        memberIds: [id, ...body.memberIds],
        canManage: true,
        state: 'active',
        syncState: 'ready',
        failure: null,
        nextAttemptAt: new Date().toISOString(),
        repositories: [...repositories, ...workRepositories]
          .filter(item => body.selection.repositories.includes(item.fullName))
          .map(item => ({ ...item, state: 'active', failure: null })),
        counts: { total: 12, ready: 12, failed: 0 },
      };
      sources.push(source);
      return Response.json(source);
    }
    if (path.endsWith('/manage')) {
      const body = JSON.parse(String(init?.body));
      const source = sources.find(item => path.includes(item.sourceId));
      if (!source) return Response.json({ error: 'knowledge-not-found' }, { status: 404 });
      source.state = body.action === 'pause' ? 'paused' : body.action === 'remove' ? 'removed' : 'active';
      return Response.json(source);
    }
    if (path.endsWith('/refresh')) return Response.json({ refreshed: 1, unavailable: 0, bounded: true });
    if (path.endsWith('/documents')) return Response.json({ items: [], nextCursor: null });
    return Response.json({ error: 'github-mock-route-not-implemented' }, { status: 404 });
  };
}
