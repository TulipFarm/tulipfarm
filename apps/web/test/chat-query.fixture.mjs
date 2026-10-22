export const membership = {
  membershipId: '22222222-2222-4222-8222-222222222222',
  role: 'admin',
  teams: [],
  capabilities: { manageGovernance: true, canLeave: true },
};
export const credits = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };

// Deliver the same scoped notice as a confirmed change in another browser tab.
export async function notifyChange(page, workspaceId, userId, feature, id) {
  await page.evaluate(
    ({ workspaceId, userId, feature, id, membershipId }) => {
      const keys =
        feature === 'models'
          ? [
              ['models', 'catalog'],
              ['models', 'membership'],
              ['models', 'availability'],
              ['models', 'rules'],
            ]
          : feature === 'model-rule'
            ? [['models', 'rules', id]]
            : feature === 'credits'
              ? [['credits', 'balance']]
              : feature === 'catalog'
                ? [['models', 'catalog']]
                : feature === 'list'
                  ? [['conversations', 'list']]
                  : [['conversations', 'detail', id]];
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
    { workspaceId, userId, feature, id, membershipId: membership.membershipId },
  );
}
