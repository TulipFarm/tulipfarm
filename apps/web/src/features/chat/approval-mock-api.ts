const id = '11111111-1111-4111-8111-111111111111';
const workspace = {
  id,
  slug: 'approval-mock',
  name: 'Approval mock',
  status: 'ready',
  createdAt: '2026-10-11T00:00:00Z',
  soulCommit: 'a'.repeat(40),
};

export function installApprovalPreviewApi() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!url.pathname.startsWith('/v1/')) return originalFetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const path = url.pathname;
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (method !== 'GET') return Response.json({ error: 'mock-read-only' }, { status: 403 });
    if (path === '/v1/auth/get-session')
      return Response.json({
        session: { id: 'approval-mock', userId: 'mock' },
        user: { id: 'mock', name: 'Demo user', email: 'mock@example.test' },
      });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === '/v1/workspaces/approval-mock') return Response.json(workspace);
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: id,
        role: 'member',
        teams: [],
        capabilities: { manageGovernance: false, canLeave: false },
      });
    return Response.json({ error: 'not-available-in-approval-mock' }, { status: 404 });
  };
  // Live update streams use EventSource, not fetch; leave them connecting so the mock never reaches a real API.
  const NativeEventSource = window.EventSource;
  window.EventSource = function ApprovalMockEventSource(url: string | URL, init?: EventSourceInit) {
    const target = new URL(String(url), window.location.origin);
    if (!target.pathname.startsWith('/v1/')) return new NativeEventSource(url, init);
    return Object.assign(new EventTarget(), {
      url: target.href,
      withCredentials: false,
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      close() {},
    });
  } as unknown as typeof EventSource;
}

if (import.meta.env.DEV && window.location.pathname.startsWith('/approval-mock/')) {
  installApprovalPreviewApi();
}
