export const membership = {
  membershipId: '22222222-2222-4222-8222-222222222222',
  role: 'admin',
  teams: [],
  capabilities: { manageGovernance: true, canLeave: true },
};
export const credits = { available: 1000, granted: 1000, used: 0, held: 0, days: [], breakdown: [], series: [] };
// An admin's workspace administration snapshot; two members keep the solo-workspace invite nudge hidden.
export const governance = {
  actorMembershipId: membership.membershipId,
  members: [
    { id: membership.membershipId, userId: 'ada', role: 'admin', name: 'Ada', email: 'ada@example.test' },
    {
      id: '33333333-3333-4333-8333-333333333334',
      userId: 'grace',
      role: 'member',
      name: 'Grace',
      email: 'grace@example.test',
    },
  ],
  teams: [],
  directory: [],
  tableTeamIds: [],
  adminTeamId: null,
  tables: [],
  grants: [],
  teamNames: [],
  personGrants: [],
};

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
