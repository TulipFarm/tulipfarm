import { useEffect } from 'react';
import { featureKey, useFeatureRead, type SessionIdentity, type WorkspaceScope } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { loadGovernance, loadOwnMembership } from '@/lib/governance';
import { useProviderAuthority } from '@/features/integrations/query-authority';
import { sessionRuntime } from '@/features/workspaces/queries';
import { ownMembershipSchema, type OwnMembership } from '@tulipfarm/workspaces/governance-contracts';

function membershipAuthority(data: unknown) {
  const parsed = ownMembershipSchema.safeParse(data);
  if (!parsed.success) return null;
  const { membershipId, role, teams, capabilities } = parsed.data;
  return { membershipId, role, teams: teams.map(team => `${team.id}:${team.role}`).sort(), capabilities };
}

export const governanceKeys = {
  all: ['governance'] as const,
  membership: ['governance', 'membership'] as const,
  administration: ['governance', 'administration'] as const,
  invitations: ['governance', 'invitations'] as const,
  authority: ['governance', 'authority'] as const,
  tableAuthority: ['governance', 'table-authority'] as const,
};
export const governanceDependents = [
  ['tables'],
  ['agents'],
  ['skills'],
  ['tasks'],
  ['workflows'],
  ['integrations'],
  ['workspace-mcp'],
  ['github'],
  ['google'],
  ['slack'],
  ['atlassian'],
  ['conversations'],
  ['models'],
  ['settings'],
  governanceKeys.administration,
  governanceKeys.invitations,
];
export const governanceTableDependents = governanceDependents.filter(
  key => key[0] !== 'governance' && key[0] !== 'settings',
);

/**
 * Applies an own-membership read made outside the query cache, such as the focus access check.
 * Returns whether its authority differs from the admitted membership, so the caller can re-admit.
 */
export function reconcileMembership(
  identity: SessionIdentity,
  workspaceId: string,
  admitted: OwnMembership | null,
  observed: OwnMembership,
) {
  if (JSON.stringify(membershipAuthority(admitted)) === JSON.stringify(membershipAuthority(observed))) return false;
  const runtime = sessionRuntime(identity);
  const scope: WorkspaceScope = {
    kind: 'workspace',
    userId: identity.userId,
    workspaceId,
    membershipId: observed.membershipId,
  };
  if (runtime?.isCurrent(scope)) {
    const key = featureKey(scope, governanceKeys.membership);
    if (runtime.client.getQueryData(key) !== undefined) runtime.client.setQueryData(key, observed);
    void runtime.applyChange(scope, { kind: 'conceal', keys: governanceDependents });
  }
  return true;
}

export function useOwnMembership(workspaceId: string) {
  const { runtime, scope } = useFeatureContext();
  useProviderAuthority(
    governanceKeys.authority,
    [governanceKeys.membership],
    governanceDependents,
    membershipAuthority,
  );
  useProviderAuthority(governanceKeys.tableAuthority, [], governanceTableDependents);
  return useFeatureRead({
    key: governanceKeys.membership,
    load: async signal => {
      try {
        const membership = await loadOwnMembership(workspaceId, signal);
        signal.throwIfAborted();
        if (scope.kind === 'workspace' && membership.membershipId !== scope.membershipId) runtime.revoke(scope, true);
        return membership;
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof Error &&
          'status' in error &&
          [401, 403, 404].includes(Number(error.status))
        )
          runtime.revoke(scope, true);
        throw error;
      }
    },
  });
}
export function useGovernance(workspaceId: string) {
  const membership = useOwnMembership(workspaceId);
  const authorized = membership.state.kind === 'ready';
  const administration = useFeatureRead({
    key: governanceKeys.administration,
    load: signal => loadGovernance(workspaceId, signal),
    enabled: authorized,
  });
  const denied = administration.state.kind === 'unavailable';
  useEffect(() => {
    if (denied) void membership.refresh();
  }, [denied, membership.refresh]);
  const refresh = async () => {
    await membership.refresh();
    await administration.refresh();
  };
  return { membership, administration, refresh };
}
