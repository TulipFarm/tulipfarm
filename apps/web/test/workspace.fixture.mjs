import assert from 'node:assert/strict';
import { createWorkspaceSchema, workspaceSchema } from '../../../packages/workspaces/src/contracts.ts';

export function createWorkspaceFixture({
  id = '11111111-1111-4111-8111-111111111111',
  slug = 'chat-qa',
  name = 'Chat QA',
  userId = 'ada',
  sessionId = 'qa',
} = {}) {
  createWorkspaceSchema.parse({ requestId: id, name, slug });
  const workspace = workspaceSchema.parse({
    id,
    slug,
    name,
    status: 'ready',
    createdAt: '2026-10-02T00:00:00Z',
    soulCommit: 'a'.repeat(40),
  });
  return {
    workspace,
    session: { session: { id: sessionId, userId }, user: { id: userId, name: 'Ada', email: 'ada@example.test' } },
  };
}

export function workspaceShellReads(workspaceId) {
  const base = `/v1/workspaces/${workspaceId}`;
  return [
    ['/v1/feature-flags', {}],
    [`${base}/slack/status`, { state: 'disconnected', teamId: null, canManage: false, linked: false, scopes: [] }],
    [`${base}/github/accounts`, { configured: false, accounts: [] }],
    [`${base}/atlassian/accounts`, { accounts: [], providers: [] }],
    [`${base}/workspace-mcp/capabilities`, { enabled: false }],
    [
      `${base}/bud`,
      {
        conversationId: null,
        onboarding: 'skipped',
        bubblesEnabled: false,
        snoozedUntil: null,
        nudge: null,
        preferences: [],
      },
    ],
  ];
}

export async function serveWorkspaceShellEvent(route, workspace) {
  const request = route.request(),
    path = new URL(request.url()).pathname;
  if (path === `/v1/workspaces/${workspace.id}/recommendations/events`) {
    assert.equal(request.method(), 'GET');
    await route.fulfill({ status: 204 });
    return true;
  }
  if (path === `/v1/workspaces/${workspace.slug}/last-used`) {
    assert.equal(request.method(), 'PUT');
    await route.fulfill({ status: 204 });
    return true;
  }
  return false;
}
