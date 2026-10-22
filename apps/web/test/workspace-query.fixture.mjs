export const ownMembership = {
  membershipId: '22222222-2222-4222-8222-222222222222',
  role: 'admin',
  teams: [],
  capabilities: { manageGovernance: true, canLeave: true },
};

export async function workspaceChange(page, workspaceId, userId, keys) {
  await page.evaluate(
    async ({ workspaceId, userId, keys, membershipId }) => {
      const { queryNotifications } = await import('/src/lib/query/notifications.ts');
      const channel = queryNotifications(() => {}, 'other-tab');
      channel.send({ kind: 'workspace', userId, workspaceId, membershipId }, 'change', keys);
      channel.close();
    },
    { workspaceId, userId, keys, membershipId: ownMembership.membershipId },
  );
}
