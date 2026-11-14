import { useMemo } from 'react';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { appApi, type AppOperation } from './api';

export const appKeys = {
  all: ['apps'] as const,
  list: ['apps', 'list'] as const,
  detail: (id: string) => ['apps', 'detail', id] as const,
  releases: (id: string) => ['apps', 'releases', id] as const,
  grants: (id: string) => ['apps', 'grants', id] as const,
  operation: (appId: string, id: string) => ['apps', 'operation', appId, id] as const,
  name: (name: string) => ['apps', 'name', name] as const,
};

export function useAppApi(workspaceId: string) {
  return useMemo(() => appApi(workspaceId), [workspaceId]);
}

export function useApps(workspaceId: string) {
  const api = useAppApi(workspaceId);
  return useFeatureRead({ key: appKeys.list, load: api.list });
}

export function useApp(workspaceId: string, appId: string | undefined) {
  const api = useAppApi(workspaceId);
  return useFeatureRead({
    key: appKeys.detail(appId ?? ''),
    load: signal => api.read(appId!, signal),
    enabled: appId !== undefined,
  });
}

export function useAppReleases(workspaceId: string, appId: string, enabled: boolean) {
  const api = useAppApi(workspaceId);
  return useFeatureRead({ key: appKeys.releases(appId), load: signal => api.releases(appId, signal), enabled });
}

export function useAppGrants(workspaceId: string, appId: string, enabled: boolean) {
  const api = useAppApi(workspaceId);
  return useFeatureRead({ key: appKeys.grants(appId), load: signal => api.grants(appId, signal), enabled });
}

const settled = (operation: AppOperation) => operation.status !== 'admitted' && operation.status !== 'staging';

/** Follows a publish or rollback until it switches, fails or is overtaken by a newer one. */
export function useAppOperation(workspaceId: string, appId: string, operationId: string | null) {
  const api = useAppApi(workspaceId);
  return useFeatureRead({
    key: appKeys.operation(appId, operationId ?? ''),
    load: signal => api.operation(appId, operationId!, signal),
    enabled: operationId !== null,
    staleTime: 0,
    pollWhile: operation => !settled(operation),
  });
}

export function useAppChanges() {
  const { change } = useFeatureChanges();
  return useMemo(
    () => ({
      app: (appId: string) => change({ keys: [appKeys.list, appKeys.detail(appId), appKeys.releases(appId)] }),
      grants: (appId: string) => change({ keys: [appKeys.list, appKeys.grants(appId)] }),
    }),
    [change],
  );
}

export function useNameAvailability(workspaceId: string, name: string, enabled: boolean) {
  const api = useAppApi(workspaceId);
  return useFeatureRead({
    key: appKeys.name(name),
    load: signal => api.nameAvailability(name, signal),
    enabled,
    staleTime: 0,
  });
}
