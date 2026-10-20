import type { QueryKey } from '@tanstack/react-query';

export type SessionIdentity = { userId: string; sessionId: string };
export type FeatureScope =
  | { kind: 'account'; userId: string }
  | { kind: 'workspace'; userId: string; workspaceId: string; membershipId: string };
export type WorkspaceScope = Extract<FeatureScope, { kind: 'workspace' }>;

export function scopeKey(scope: FeatureScope): QueryKey {
  return scope.kind === 'account'
    ? ['user', scope.userId]
    : ['user', scope.userId, 'workspace', scope.workspaceId, 'membership', scope.membershipId];
}

export function featureKey(scope: FeatureScope, key: QueryKey): QueryKey {
  return [...scopeKey(scope), ...key];
}
