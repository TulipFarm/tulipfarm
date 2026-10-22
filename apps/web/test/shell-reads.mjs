// Reads the signed-in workspace shell makes on every page: integration status for the banner and
// composer, Bud, recommendations, last-used, the session visit and build feature flags. Tests that do not exercise them
// answer with these neutral states rather than failing on an unexpected request.
export function shellRead(method, path, workspace) {
  if (method === 'PUT' && path.endsWith('/last-used')) return { status: 204 };
  // The session records a visit once per load since cloud f58aaca3 (#1142), src/lib/user-visit.tsx:18.
  if (method === 'POST' && path === '/v1/user/visit') return { json: { firstSession: false } };
  if (method !== 'GET') return undefined;
  if (path === '/v1/feature-flags') return { json: {} };
  if (path === '/v1/google-workspace/availability') return { json: { configured: false } };
  if (path.endsWith('/google-workspace')) return { json: { status: 'disconnected' } };
  if (path.endsWith('/slack/status'))
    return { json: { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] } };
  if (path.endsWith('/github/accounts')) return { json: { configured: false, accounts: [] } };
  if (path.endsWith('/atlassian/accounts')) return { json: { accounts: [], providers: [] } };
  if (path.endsWith('/workspace-mcp/capabilities')) return { status: 404, json: { error: 'not-found' } };
  if (path.endsWith('/bud'))
    return {
      json: {
        conversationId: null,
        onboarding: 'skipped',
        bubblesEnabled: false,
        snoozedUntil: null,
        nudge: null,
        preferences: [],
      },
    };
  if (path.endsWith('/recommendations') || path.endsWith('/recommendations/events'))
    return { status: 503, json: { error: 'recommendations-unavailable' } };
  if (workspace && path.endsWith(`/${workspace.id}/settings`))
    return {
      json: { workspaceId: workspace.id, name: workspace.name, slug: workspace.slug, revision: 1, canManage: true },
    };
  return undefined;
}
