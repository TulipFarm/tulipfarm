export const ownMembership = {
  membershipId: '22222222-2222-4222-8222-222222222222',
  role: 'admin',
  teams: [],
  capabilities: { manageGovernance: true, canLeave: true },
};

export async function workspaceChange(page, workspaceId, userId, keys) {
  await page.evaluate(
    ({ workspaceId, userId, keys, membershipId }) => {
      const channel = new BroadcastChannel('tulipfarm:query:v1');
      channel.postMessage({
        version: 1,
        id: crypto.randomUUID(),
        sessionId: 'other-tab',
        scope: { kind: 'workspace', userId, workspaceId, membershipId },
        kind: 'change',
        keys,
      });
      channel.close();
    },
    { workspaceId, userId, keys, membershipId: ownMembership.membershipId },
  );
}
