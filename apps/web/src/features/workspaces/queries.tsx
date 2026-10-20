import { useCallback, useEffect, useLayoutEffect } from 'react';
import { featureKey, featureReadOptions, useFeatureRead, type FeatureClient, type SessionIdentity } from '@/lib/query';
import { useFeatureContext } from '@/lib/query/provider';
import { getWorkspace, getWorkspaceSetup, listWorkspaces } from '@/lib/workspaces';

export const workspaceKeys = {
  all: ['workspaces'] as const,
  list: ['workspaces', 'list'] as const,
  detail: (slug: string) => ['workspaces', 'detail', slug] as const,
  setup: (id: string) => ['workspaces', 'setup', id] as const,
};
export const workspaceListOptions = () => ({ key: workspaceKeys.list, load: listWorkspaces });

// Route admission can precede provider mounting on cold entry. Warm navigation
// uses the provider's client, while workspace and membership admission stay fresh.
const sessions = new Map<string, FeatureClient>();
const identityKey = (identity: SessionIdentity) => JSON.stringify([identity.userId, identity.sessionId]);
export function WorkspaceListQueryBridge({
  initialWorkspaces,
  onChanged,
}: {
  initialWorkspaces?: Awaited<ReturnType<typeof listWorkspaces>> | undefined;
  onChanged: () => void;
}) {
  const { runtime } = useFeatureContext();
  useLayoutEffect(() => {
    const key = identityKey(runtime.identity);
    sessions.set(key, runtime);
    const queryKey = featureKey({ kind: 'account', userId: runtime.identity.userId }, workspaceKeys.list);
    if (initialWorkspaces && !runtime.client.getQueryState(queryKey))
      runtime.client.setQueryData(queryKey, initialWorkspaces);
    return () => {
      if (sessions.get(key) === runtime) sessions.delete(key);
    };
  }, [runtime, initialWorkspaces]);
  return initialWorkspaces ? (
    <WorkspaceListObserver initialWorkspaces={initialWorkspaces} onChanged={onChanged} />
  ) : null;
}
function WorkspaceListObserver({
  initialWorkspaces,
  onChanged,
}: {
  initialWorkspaces: Awaited<ReturnType<typeof listWorkspaces>>;
  onChanged: () => void;
}) {
  const read = useWorkspaceList();
  const changed =
    read.state.kind === 'ready' &&
    !read.state.refreshing &&
    !read.state.error &&
    JSON.stringify(read.state.data) !== JSON.stringify(initialWorkspaces);
  useEffect(() => {
    if (changed) onChanged();
  }, [changed, onChanged]);
  return null;
}
export function sessionRuntime(identity: SessionIdentity) {
  return sessions.get(identityKey(identity));
}
export function readWorkspaceList(identity: SessionIdentity) {
  const runtime = sessionRuntime(identity);
  if (runtime && !runtime.isCurrent({ kind: 'account', userId: identity.userId }))
    return Promise.reject(new DOMException('Session changed', 'AbortError'));
  return runtime
    ? runtime.client.fetchQuery(
        featureReadOptions(runtime, { kind: 'account', userId: identity.userId }, workspaceListOptions()),
      )
    : listWorkspaces();
}
export async function refreshWorkspaceList(identity: SessionIdentity) {
  const runtime = sessionRuntime(identity);
  if (runtime) await runtime.change({ kind: 'account', userId: identity.userId }, { keys: [workspaceKeys.list] });
  return readWorkspaceList(identity);
}
export function useWorkspaceList() {
  const { scope } = useFeatureContext();
  if (scope.kind !== 'account') throw new Error('Workspace lists require account scope.');
  return useFeatureRead(workspaceListOptions());
}
export function useWorkspaceListCommand() {
  const { runtime } = useFeatureContext();
  return useCallback(async () => {
    const scope = { kind: 'account', userId: runtime.identity.userId } as const;
    await runtime.change(scope, { keys: [workspaceKeys.list] });
    return runtime.client.fetchQuery(featureReadOptions(runtime, scope, workspaceListOptions()));
  }, [runtime]);
}
export function useWorkspaceSetup(id: string) {
  const { scope } = useFeatureContext();
  if (scope.kind !== 'account') throw new Error('Workspace setup requires account scope.');
  return useFeatureRead({
    key: workspaceKeys.setup(id),
    load: signal => getWorkspaceSetup(id, signal),
    pollWhile: setup => !setup.error && (setup.stage === 'reserved' || setup.stage === 'database'),
  });
}
export function useProvisioningWorkspace(slug: string) {
  const { scope } = useFeatureContext();
  if (scope.kind !== 'account') throw new Error('Workspace provisioning requires account scope.');
  return useFeatureRead({
    key: workspaceKeys.detail(slug),
    load: signal => getWorkspace(slug, signal),
    pollWhile: workspace => workspace.status === 'provisioning',
  });
}
