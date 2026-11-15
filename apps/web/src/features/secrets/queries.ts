import { useMemo } from 'react';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { loadCollaborationDirectory } from '@/lib/governance';
import { secretsApi } from './api';

export const secretsKeys = {
  all: ['secrets'] as const,
  capabilities: ['secrets', 'capabilities'] as const,
  list: ['secrets', 'list'] as const,
  history: (id: string) => ['secrets', 'history', id] as const,
  reveals: (id: string) => ['secrets', 'reveals', id] as const,
  request: (id: string) => ['secrets', 'request', id] as const,
  task: (taskId: string) => ['secrets', 'task', taskId] as const,
  directory: ['secrets', 'directory'] as const,
};

export function useSecretsApi(workspaceId: string) {
  return useMemo(() => secretsApi(workspaceId), [workspaceId]);
}

export function useSecretsCapabilities(workspaceId: string, enabled = true) {
  const api = useSecretsApi(workspaceId);
  return useFeatureRead({ key: secretsKeys.capabilities, load: api.capabilities, enabled });
}

export function useSecrets(workspaceId: string, enabled: boolean) {
  const api = useSecretsApi(workspaceId);
  return useFeatureRead({ key: secretsKeys.list, load: api.list, enabled });
}

export function useSecretHistory(workspaceId: string, id: string) {
  const api = useSecretsApi(workspaceId);
  return useFeatureRead({ key: secretsKeys.history(id), load: signal => api.history(id, signal) });
}

export function useSecretReveals(workspaceId: string, id: string) {
  const api = useSecretsApi(workspaceId);
  return useFeatureRead({ key: secretsKeys.reveals(id), load: signal => api.reveals(id, signal) });
}

export function useSecretRequest(workspaceId: string, id: string, enabled: boolean) {
  const api = useSecretsApi(workspaceId);
  return useFeatureRead({ key: secretsKeys.request(id), load: signal => api.requestView(id, signal), enabled });
}

export function useTaskSecretRequests(workspaceId: string, taskId: string, revision: unknown) {
  const api = useSecretsApi(workspaceId);
  return useFeatureRead({
    key: [...secretsKeys.task(taskId), revision],
    load: signal => api.forTask(taskId, signal),
    enabled: !!workspaceId,
  });
}

export function useMemberDirectory(workspaceId: string) {
  return useFeatureRead({
    key: secretsKeys.directory,
    load: async signal => (await loadCollaborationDirectory(workspaceId, signal)).members,
  });
}

export function useSecretsChanges() {
  const { change } = useFeatureChanges();
  return useMemo(() => ({ changed: () => change({ keys: [secretsKeys.all] }) }), [change]);
}
