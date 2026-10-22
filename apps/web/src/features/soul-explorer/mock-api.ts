if (import.meta.env.DEV && /^\/soul-explorer-mock(?:\/|$)/.test(window.location.pathname)) {
  const id = '61616161-6161-4161-8161-616161616161';
  const agentId = '72727272-7272-4272-8272-727272727272';
  const tableId = '83838383-8383-4383-8383-838383838383';
  const revision = 'd43f921e6a78199b7cf271b7105fa9d903e36d12';
  const workspace = {
    id,
    slug: 'soul-explorer-mock',
    name: 'Soul demo',
    status: 'ready',
    createdAt: '2026-10-14T10:00:00.000Z',
    soulCommit: revision,
  };
  const scenario = new URLSearchParams(window.location.search).get('soulScenario');
  const member = scenario === 'member';
  let failed = false;
  let reads = 0;
  const files = new Map<string, string>([
    [
      'soul.json',
      JSON.stringify({ templateVersion: 1, workspaceId: id, createdBy: id, createdAt: workspace.createdAt }, null, 2) +
        '\n',
    ],
    ['skills-lock.json', '{}\n'],
    [
      'tables/invoices.json',
      JSON.stringify(
        {
          formatVersion: 3,
          id: 'invoices',
          owningTeamId: id,
          label: 'Invoices',
          fields: [
            { id: agentId, label: 'Invoice number', kind: 'text', required: true, maxLength: 120 },
            { id: tableId, label: 'Amount', kind: 'numeric', required: true, precision: 12, scale: 2 },
          ],
          uniqueKeys: [],
        },
        null,
        2,
      ) + '\n',
    ],
    [
      `agents/${agentId}.json`,
      JSON.stringify(
        {
          formatVersion: 1,
          id: agentId,
          name: 'Invoice assistant',
          instructions: 'Read the requested invoices.\nSummarize outstanding balances. Do not change records.',
          tools: ['schema.inspect', 'rows.list'],
        },
        null,
        2,
      ) + '\n',
    ],
    ...['tables', 'agents', 'workflows', 'skills', 'roles', 'integrations'].map(
      name => [`${name}/.gitkeep`, ''] as [string, string],
    ),
  ]);
  if (scenario === 'unicode')
    files.set(
      'tables/café_東京.json',
      JSON.stringify(
        { formatVersion: 3, id: 'café_東京', owningTeamId: id, label: 'Café 東京', fields: [], uniqueKeys: [] },
        null,
        2,
      ) + '\n',
    );
  if (scenario === 'many') {
    for (let i = 0; i < 120; i++) files.set(`tables/page-${String(i).padStart(3, '0')}.json`, '{}\n');
  }
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    // Flags stay a network read so a browser test can answer them; without an API the build defaults apply.
    if (!url.pathname.startsWith('/v1/') || url.pathname === '/v1/feature-flags') return original(input, init);
    const path = url.pathname,
      method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (path.endsWith('/last-used') && method === 'PUT') return new Response(null, { status: 204 });
    if (method !== 'GET') return Response.json({ error: 'read-only-local-fixture' }, { status: 403 });
    if (path === '/v1/auth/get-session')
      return Response.json({
        session: { id: 'soul-demo', userId: id },
        user: { id, name: 'Local admin', email: 'soul@example.test' },
      });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === '/v1/workspaces/soul-explorer-mock') return Response.json(workspace);
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: id,
        role: member ? 'member' : 'admin',
        teams: [],
        capabilities: { manageGovernance: !member, canLeave: false },
      });
    if (path.endsWith('/settings'))
      return Response.json({
        workspaceId: id,
        name: workspace.name,
        slug: workspace.slug,
        icon: null,
        revision: 1,
        canManage: !member,
      });
    if (path.endsWith('/credits'))
      return Response.json({ available: 0, granted: 0, used: 0, held: 0, days: [], breakdown: [], series: [] });
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
    if (path.endsWith('/github/accounts')) return Response.json({ configured: false, accounts: [] });
    if (path.endsWith('/atlassian/accounts')) return Response.json({ accounts: [], providers: [] });
    if (path.endsWith('/workspace-mcp/capabilities')) return Response.json({ enabled: false });
    if (path.endsWith('/recent')) return Response.json([]);
    if (path.includes('/soul/')) {
      reads++;
      if (member || scenario === 'denied') return Response.json({ error: 'soul-not-found' }, { status: 404 });
      if (scenario === 'refresh-denied' && reads > 1)
        return Response.json({ error: 'soul-not-found' }, { status: 404 });
      if (scenario === 'oversized') return Response.json({ error: 'soul-snapshot-too-large' }, { status: 503 });
      if (scenario === 'error' && !failed) {
        failed = true;
        return Response.json({ error: 'soul-unavailable' }, { status: 503 });
      }
      if (scenario === 'slow' && !failed) {
        failed = true;
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      if (path.endsWith('/snapshot')) {
        if (scenario === 'changed' && !failed) {
          failed = true;
          return Response.json({ error: 'soul-revision-changed' }, { status: 409 });
        }
        const entries = [
          ...['agents', 'integrations', 'roles', 'skills', 'tables', 'workflows'].map(path => ({
            path,
            kind: 'directory',
            size: 0,
          })),
          ...[...files].map(([path, content]) => ({
            path,
            kind: 'file',
            size: new TextEncoder().encode(content).length,
          })),
        ];
        const contents = [...files].map(([path, content]) =>
          scenario === 'binary' || scenario === 'large'
            ? { kind: 'unavailable', path, revision, reason: scenario === 'large' ? 'too-large' : 'binary' }
            : { kind: 'text', path, revision, content },
        );
        return Response.json({
          revision,
          entries: scenario === 'empty' ? [] : entries,
          files: scenario === 'empty' ? [] : contents,
        });
      }
    }
    return Response.json({ error: 'not-in-soul-demo' }, { status: 404 });
  };
}
