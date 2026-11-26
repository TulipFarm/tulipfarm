// Reads the signed-in workspace shell makes on every page: integration status for the banner and
// composer, Bud, recommendations, the sidebar's pinned chats and recent items, last-used, the
// session visit, build feature flags, the Inbox count and settings. Tests that do not exercise them
// answer with these neutral states rather than failing on an unexpected request.
export function shellRead(method, path, workspace) {
  if (method === 'PUT' && path.endsWith('/last-used')) return { status: 204 };
  // The session records a visit once per load since cloud f58aaca3 (#1142), src/lib/user-visit.tsx:18.
  if (method === 'POST' && path === '/v1/user/visit') return { json: { firstSession: false } };
  if (method !== 'GET') return undefined;
  if (path === '/v1/feature-flags') return { json: {} };
  if (/^\/v1\/workspaces\/[^/]+\/inbox$/.test(path)) return { json: { items: [], open: 0 } };
  if (/^\/v1\/workspaces\/[^/]+\/inbox\/slack$/.test(path))
    return {
      json: { connected: false, kinds: { assigned: true, waiting: true, finished: true, mention: true } },
    };
  if (/^\/v1\/workspaces\/[^/]+\/assignment-limits$/.test(path))
    return { json: { workspace: 10, timeZone: 'UTC', dailyCredits: null, agents: [] } };
  if (path.endsWith('/conversations/pinned')) return { json: { chats: [] } };
  if (/\/(agents|tasks|workflows)\/recent$/.test(path)) return { json: [] };
  if (path === '/v1/google-workspace/availability') return { json: { configured: false } };
  if (path.endsWith('/google-workspace')) return { json: { status: 'disconnected' } };
  if (path.endsWith('/slack/status'))
    return { json: { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] } };
  if (path.endsWith('/github/accounts')) return { json: { configured: false, accounts: [] } };
  if (/^\/v1\/workspaces\/[^/]+\/code-mode\/repositories$/.test(path)) return { json: { items: [] } };
  if (/^\/v1\/workspaces\/[^/]+\/tables\/[^/]+\/rows\/[^/]+\/clarifications$/.test(path))
    return { json: { items: [] } };
  if (/^\/v1\/workspaces\/[^/]+\/integrations$/.test(path)) return { json: { integrations: [] } };
  if (path.endsWith('/atlassian/accounts')) return { json: { accounts: [], providers: [] } };
  if (path.endsWith('/workspace-mcp/capabilities')) return { status: 404, json: { error: 'not-found' } };
  // Members reads the built-in Members table for people added by hand; these mocks have none.
  if (/^\/v1\/workspaces\/[^/]+\/workspace-members$/.test(path)) return { status: 404, json: { error: 'not-found' } };
  if (/^\/v1\/workspaces\/[^/]+\/workspace-members\/identities\/search$/.test(path)) return { json: { matches: [] } };
  if (/^\/v1\/workspaces\/[^/]+\/workspace-members\/[^/]+\/identities$/.test(path))
    return { status: 404, json: { error: 'not-found' } };
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
  // The sidebar lists pinned chats and recent agents.
  if (path.endsWith('/conversations/pinned')) return { json: { chats: [] } };
  if (path.endsWith('/agents/recent')) return { json: [] };
  if (path.endsWith('/recommendations') || path.endsWith('/recommendations/events'))
    return { status: 503, json: { error: 'recommendations-unavailable' } };
  if (workspace && path.endsWith(`/${workspace.id}/settings`))
    return {
      json: { workspaceId: workspace.id, name: workspace.name, slug: workspace.slug, revision: 1, canManage: true },
    };
  return undefined;
}
