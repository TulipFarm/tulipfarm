if (import.meta.env.DEV && /^\/memory-mock(?:\/|$)/.test(window.location.pathname)) {
  const id = '61616161-6161-4161-8161-616161616161';
  const workspace = {
    id,
    slug: 'memory-mock',
    name: 'Tulip demo',
    status: 'ready',
    createdAt: '2026-10-14T10:00:00.000Z',
    soulCommit: 'a'.repeat(40),
  };
  const scenario = new URLSearchParams(window.location.search).get('memoryScenario');
  // `passwordScenario=credential|link` turns on self-hosted password sign-in for this demo account.
  const passwordScenario = new URLSearchParams(window.location.search).get('passwordScenario');
  // `memoryScenario=keep-unavailable` shows the memory service not answering.
  let memory: { content: string; revision: number; history: { trashed: boolean; undo: boolean } } = {
    history: { trashed: false, undo: true },
    content:
      scenario === 'empty'
        ? ''
        : 'Use short, friendly replies with emojis when they help.\n\nGreet me for my time of day. Explain unfamiliar terms in plain words.',
    revision: 1,
  };
  // `proposalScenario=pending|outdated|empty|error` sets the suggested changes.
  const proposalScenario = new URLSearchParams(window.location.search).get('proposalScenario') ?? 'empty';
  const suggestion = (n: number, kind: 'add' | 'change' | 'remove', before: string | null, after: string | null) => ({
    id: `7${n}7${n}7${n}7${n}-7${n}7${n}-4${n}7${n}-8${n}7${n}-7${n}7${n}7${n}7${n}7${n}7${n}`,
    kind,
    before,
    after,
    conversationId: id,
    createdAt: '2026-10-14T10:00:00.000Z',
  });
  let proposals =
    proposalScenario === 'pending' || proposalScenario === 'outdated'
      ? [
          {
            ...suggestion(1, 'add', null, 'Answer in British English.'),
            quote: 'Please always use British spelling.',
            conversationTitle: 'Launch plan',
            outdated: false,
          },
          {
            ...suggestion(
              2,
              'change',
              'Use short, friendly replies with emojis when they help.',
              'Use short replies without emojis.',
            ),
            quote: 'Stop using emojis, keep it short.',
            conversationTitle: 'Weekly update',
            outdated: proposalScenario === 'outdated',
          },
        ]
      : [];
  let proposalFailures = 0;
  let previous = '';
  let failed = false;
  let readFailures = 0;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!url.pathname.startsWith('/v1/')) return original(input, init);
    const path = url.pathname,
      method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (/\/personal-memory\/(?:undo|forget)$/.test(path) && method === 'POST') {
      const value = JSON.parse(String(init?.body)) as { expectedRevision: number };
      if (value.expectedRevision !== memory.revision)
        return Response.json({ error: 'personal_memory_conflict' }, { status: 409 });
      memory = path.endsWith('/forget')
        ? { content: '', revision: memory.revision + 2, history: { trashed: false, undo: false } }
        : {
            content: memory.history?.trashed ? previous : 'Use short, friendly replies.',
            revision: memory.revision + 2,
            history: { trashed: false, undo: true },
          };
      return Response.json(memory);
    }
    if (path.endsWith('/personal-memory/proposals') && method === 'GET') {
      if (proposalScenario === 'error' && proposalFailures < 3) {
        proposalFailures++;
        return Response.json({ error: 'personal-memory-unavailable' }, { status: 503 });
      }
      return Response.json({ memory, proposals });
    }
    const decision = /\/personal-memory\/proposals\/([^/]+)\/(confirm|dismiss|refresh)$/.exec(path);
    if (decision && method === 'POST') {
      const proposal = proposals.find(item => item.id === decision[1]);
      if (!proposal) return Response.json({ error: 'memory-proposal-not-found' }, { status: 404 });
      if (decision[2] === 'refresh' || (decision[2] === 'confirm' && proposal.outdated))
        return Response.json({ error: 'memory-proposal-outdated' }, { status: 409 });
      proposals = proposals.filter(item => item !== proposal);
      if (decision[2] === 'confirm')
        memory = {
          content: proposal.before
            ? memory.content.replace(proposal.before, proposal.after ?? '').trim()
            : `${memory.content}\n${proposal.after}`,
          revision: memory.revision + 1,
          history: { trashed: false, undo: true },
        };
      return Response.json({ memory, proposals });
    }
    if (path.endsWith('/personal-memory')) {
      if (scenario === 'denied') return Response.json({ error: 'personal-memory-not-found' }, { status: 404 });
      if (scenario === 'keep-unavailable')
        return Response.json({ error: 'personal-memory-unavailable' }, { status: 503 });
      if (method === 'DELETE') {
        previous = memory.content;
        memory = { content: '', revision: memory.revision + 1, history: { trashed: true, undo: true } };
        return Response.json(memory);
      }
      if (method === 'GET') {
        // Reads resend a 503 once, so the first load fails only when both answers do.
        if (scenario === 'error' && readFailures < 2) {
          readFailures++;
          return Response.json({ error: 'personal-memory-unavailable' }, { status: 503 });
        }
        if (scenario === 'slow' && !failed) {
          failed = true;
          await new Promise(resolve => setTimeout(resolve, 1800));
        }
        return Response.json(memory);
      }
      if (method === 'PUT') {
        const value = JSON.parse(String(init?.body)) as { content: string; expectedRevision: number };
        if (scenario === 'conflict' && !failed) {
          failed = true;
          memory = {
            content: 'Use clear, short replies without emojis.',
            revision: memory.revision + 1,
            history: { trashed: false, undo: true },
          };
        }
        if (value.expectedRevision !== memory.revision)
          return Response.json({ error: 'personal_memory_conflict' }, { status: 409 });
        if (Array.from(value.content).length > 10000)
          return Response.json({ error: 'invalid-request' }, { status: 400 });
        memory = {
          history: { trashed: false, undo: true },
          content: value.content.trim() ? value.content : '',
          revision: memory.revision + 1,
        };
        if (scenario === 'lost-save' && !failed) {
          failed = true;
          throw new TypeError('Local fixture lost the save response');
        }
        return Response.json(memory);
      }
    }
    if (passwordScenario) {
      if (path === '/v1/auth/options')
        return Response.json({
          turnstileSiteKey: null,
          emailPassword: true,
          passwordResetEmail: true,
          google: true,
          magicLink: true,
        });
      if (path === '/v1/auth/list-accounts')
        return Response.json(passwordScenario === 'credential' ? [{ id: 'credential', providerId: 'credential' }] : []);
      if (path === '/v1/account/sign-in-methods') return Response.json({ methods: ['email-link'] });
      if (path === '/v1/auth/change-password' && method === 'POST') {
        const value = JSON.parse(String(init?.body)) as { currentPassword: string };
        return value.currentPassword === 'current password'
          ? Response.json({ token: null })
          : Response.json({ code: 'INVALID_PASSWORD', message: 'Invalid password' }, { status: 400 });
      }
    }
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (path.endsWith('/last-used') && method === 'PUT') return new Response(null, { status: 204 });
    if (method !== 'GET') return Response.json({ error: 'not-in-memory-demo' }, { status: 404 });
    if (path === '/v1/auth/get-session')
      return Response.json({
        session: { id: 'memory-demo', userId: id },
        user: { id, name: 'Alex', email: 'alex@example.test' },
      });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === '/v1/workspaces/memory-mock') return Response.json(workspace);
    if (path === `/v1/workspaces/${id}/settings`)
      return Response.json({
        workspaceId: id,
        name: workspace.name,
        slug: workspace.slug,
        icon: null,
        revision: 1,
        canManage: false,
      });
    if (path === `/v1/workspaces/${id}/credits`)
      return Response.json({
        scope: 'personal',
        available: 250,
        granted: 250,
        used: 0,
        held: 0,
        days: [],
        breakdown: [],
        series: [],
      });
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: id,
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: true },
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
    if (path.endsWith('/recommendations/events')) return new Response(null, { status: 204 });
    if (path.endsWith('/slack/status'))
      return Response.json({ state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] });
    if (path.endsWith('/github/accounts')) return Response.json({ configured: false, installUrl: null, accounts: [] });
    if (path.endsWith('/atlassian/accounts')) return Response.json({ accounts: [], providers: [] });
    if (path.endsWith('/workspace-mcp/capabilities')) return Response.json({ enabled: false });
    if (path.endsWith('/recent')) return Response.json([]);
    return Response.json({ error: 'not-in-memory-demo' }, { status: 404 });
  };
}
