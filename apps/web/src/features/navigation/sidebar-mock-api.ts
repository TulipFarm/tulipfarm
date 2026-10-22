function installSidebarMock() {
  const originalFetch = window.fetch.bind(window);
  const id = '33333333-3333-4333-8333-333333333333';
  const workspace = {
    id,
    slug: 'sidebar-mock',
    name: 'TulipFarm',
    status: 'ready',
    createdAt: '2026-10-11T00:00:00Z',
    soulCommit: 'a'.repeat(40),
  };
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!url.pathname.startsWith('/v1/')) return originalFetch(input, init);
    const path = url.pathname;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (method !== 'GET') return Response.json({ error: 'disabled-in-local-mock' }, { status: 403 });
    if (path === '/v1/auth/get-session')
      return Response.json({
        session: { id: 'sidebar-mock', userId: 'sidebar-mock' },
        user: { id: 'sidebar-mock', name: 'Local demo', email: 'demo@example.test' },
      });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === '/v1/workspaces/sidebar-mock') return Response.json(workspace);
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: id,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: false },
      });
    if (path.endsWith('/credits'))
      return Response.json({ available: 555, granted: 600, used: 45, held: 0, days: [], breakdown: [], series: [] });
    return Response.json({ error: 'not-available-in-sidebar-mock' }, { status: 404 });
  };
}

if (
  import.meta.env.DEV &&
  (window.location.pathname === '/sidebar-mock' || window.location.pathname.startsWith('/sidebar-mock/'))
)
  installSidebarMock();
