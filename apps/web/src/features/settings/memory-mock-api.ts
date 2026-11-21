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
  // `memoryScenario=empty|denied|keep-unavailable|error|slow|conflict|instruct-error` picks the memory files demo.
  type File = {
    path: string;
    name: string;
    description: string;
    group: 'you' | 'topics' | 'areas' | 'people';
    revisionId: string | null;
    updatedAt: string | null;
    size: number;
    content: string;
  };
  let revision = 1;
  const at = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const file = (path: string, name: string, description: string, content: string, days: number): File => ({
    path,
    name,
    description,
    group: path.startsWith('/topics/')
      ? 'topics'
      : path.startsWith('/areas/')
        ? 'areas'
        : path.startsWith('/people/')
          ? 'people'
          : 'you',
    revisionId: content ? `r${revision++}` : null,
    updatedAt: content ? at(days) : null,
    size: new TextEncoder().encode(content).length,
    content,
  });
  const empty = scenario === 'empty';
  let files: File[] = [
    file(
      '/profile.md',
      'Preferences',
      'How you want Bud to respond',
      empty
        ? ''
        : 'Use short, friendly replies.\n\nGreet me for my time of day. Explain unfamiliar terms in plain words.',
      2,
    ),
    file(
      '/you/about.md',
      'Profile',
      'Who you are and what you do',
      empty ? '' : 'Head of operations at Tulip demo. Based in London.',
      9,
    ),
    ...(empty
      ? []
      : [
          file('/topics/career.md', 'Career', 'Goals and growth plans', 'Working towards a COO role next year.', 30),
          file(
            '/areas/hiring.md',
            'Hiring',
            'Recruiting for the operations team',
            'Hiring two analysts this quarter.',
            1,
          ),
          file(
            '/people/sam-lee.md',
            'Sam Lee',
            'Finance lead',
            'Prefers numbers in tables. Reviews budgets on Fridays.',
            5,
          ),
        ]),
  ];
  let failed = false;
  let readFailures = 0;
  const listed = () => files.map(({ content: _content, ...entry }) => entry);
  const withContent = () => files.map(entry => ({ ...entry }));
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!url.pathname.startsWith('/v1/')) return original(input, init);
    const path = url.pathname,
      method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (/\/personal-memory\/(?:files(?:\/read)?|instruct)$/.test(path)) {
      if (scenario === 'denied') return Response.json({ error: 'personal-memory-not-found' }, { status: 404 });
      if (scenario === 'keep-unavailable')
        return Response.json({ error: 'personal-memory-unavailable' }, { status: 503 });
      if (path.endsWith('/files') && method === 'GET') {
        // Reads resend a 503 once, so the first load fails only when both answers do.
        if (scenario === 'error' && readFailures < 2) {
          readFailures++;
          return Response.json({ error: 'personal-memory-unavailable' }, { status: 503 });
        }
        if (scenario === 'slow' && !failed) {
          failed = true;
          await new Promise(resolve => setTimeout(resolve, 1800));
        }
        return Response.json({ files: withContent() });
      }
      if (path.endsWith('/files/read')) {
        const found = files.find(entry => entry.path === url.searchParams.get('path'));
        return found ? Response.json(found) : Response.json({ error: 'memory-file-not-found' }, { status: 404 });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string | null>;
      const found = files.find(entry => entry.path === body.path);
      if (path.endsWith('/files') && method === 'PUT') {
        if (scenario === 'conflict' && !failed && found) {
          failed = true;
          found.revisionId = `r${revision++}`;
        }
        if ((found?.revisionId ?? null) !== body.expectedRevisionId)
          return Response.json({ error: 'personal_memory_conflict' }, { status: 409 });
        const content = String(body.content ?? '');
        if (new TextEncoder().encode(content).length > 8192)
          return Response.json({ error: 'invalid-request' }, { status: 400 });
        const next = file(
          String(body.path),
          found?.name ?? String(body.name),
          found?.description ?? '',
          content.trim() ? content : '',
          0,
        );
        files = found ? files.map(entry => (entry === found ? next : entry)) : [...files, next];
        return Response.json(next);
      }
      if (path.endsWith('/files') && method === 'DELETE') {
        if (!found?.revisionId) return Response.json({ error: 'memory-file-not-found' }, { status: 404 });
        if (found.revisionId !== body.expectedRevisionId)
          return Response.json({ error: 'personal_memory_conflict' }, { status: 409 });
        files =
          found.group === 'you'
            ? files.map(entry => (entry === found ? file(found.path, found.name, found.description, '', 0) : entry))
            : files.filter(entry => entry !== found);
        return Response.json({ files: withContent() });
      }
      if (path.endsWith('/instruct') && method === 'POST') {
        await new Promise(resolve => setTimeout(resolve, 900));
        if (scenario === 'instruct-error') return Response.json({ error: 'credits-exhausted' }, { status: 402 });
        const text = String(body.instruction ?? '');
        const falcon = files.find(entry => entry.path === '/topics/project-falcon.md');
        if (/forget/i.test(text) && falcon) {
          files = files.filter(entry => entry !== falcon);
          return Response.json({
            changed: [{ path: falcon.path, name: falcon.name, operation: 'deleted' }],
            files: listed(),
          });
        }
        if (/forget/i.test(text)) return Response.json({ changed: [], files: listed() });
        const about = files.find(entry => entry.path === '/you/about.md')!;
        const content = `${about.content}\n${text}`.trim();
        files = [
          ...files.map(entry =>
            entry === about ? file(about.path, about.name, about.description, content, 0) : entry,
          ),
          file('/topics/project-falcon.md', 'Project Falcon', 'Launch planning', 'Launch planned for spring.', 0),
        ];
        return Response.json({
          changed: [
            { path: about.path, name: about.name, operation: 'updated' },
            { path: '/topics/project-falcon.md', name: 'Project Falcon', operation: 'created' },
          ],
          files: listed(),
        });
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
