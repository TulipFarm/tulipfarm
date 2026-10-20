import { useCallback } from 'react';
import { useFeatureContext } from '@/lib/query/provider';
import { workspaceKeys } from './queries';

export function useWorkspaceChanges() {
  const { runtime, scope } = useFeatureContext();
  const account = { kind: 'account', userId: scope.userId } as const;
  const changed = useCallback(() => runtime.change(account, { keys: [workspaceKeys.all] }), [runtime, scope.userId]);
  const removed = useCallback(
    (workspaceId: string) => {
      // Recovery runs in account scope and can confirm deletion without admission.
      const memberships = new Set<string>();
      for (const query of runtime.client
        .getQueryCache()
        .findAll({ queryKey: ['user', scope.userId, 'workspace', workspaceId] })) {
        const membershipId = query.queryKey[5];
        if (typeof membershipId === 'string') memberships.add(membershipId);
      }
      if (scope.kind === 'workspace' && scope.workspaceId === workspaceId) memberships.add(scope.membershipId);
      void changed();
      void runtime.change(account, { keys: [['workspace', workspaceId]] });
      for (const membershipId of memberships)
        runtime.revoke({ kind: 'workspace', userId: scope.userId, workspaceId, membershipId }, true);
    },
    [runtime, scope, changed],
  );
  return { changed, removed };
}
